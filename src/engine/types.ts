/**
 * Core PDF Object Types
 *
 * PDF files are built from a small set of primitive types:
 *   - Boolean, Integer, Real, String, HexString, Name, Null
 *   - Array, Dictionary, Stream
 *   - Indirect Reference (obj_num gen_num R)
 *
 * We model each as a distinct class so we can use `instanceof` checks
 * throughout the parser, renderer, and editor.
 */

// ─── Primitive wrappers ────────────────────────────────────────────────────

export class PDFName {
  readonly _tag = 'PDFName' as const;
  constructor(public readonly name: string) {}
  toString(): string { return `/${this.name}`; }
  equals(other: PDFName): boolean { return this.name === other.name; }
}

export class PDFString {
  readonly _tag = 'PDFString' as const;
  constructor(public readonly value: string) {}
  /** Text dictionaries use UTF-16BE for non-ASCII, never ambiguous binary bytes. */
  static fromText(value: string): PDFString {
    if (!/[^\x20-\x7e\t\r\n]/.test(value)) return new PDFString(value);
    let raw = '\xfe\xff';
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      raw += String.fromCharCode(code >>> 8, code & 0xff);
    }
    return new PDFString(raw);
  }
  /** Preserve byte strings; encode Unicode text outside the byte range as UTF-16BE. */
  toBytes(): Uint8Array {
    const unicode = /[^\u0000-\u00ff]/.test(this.value);
    const bytes = new Uint8Array(unicode ? 2 + this.value.length * 2 : this.value.length);
    if (unicode) { bytes[0] = 0xfe; bytes[1] = 0xff; }
    for (let i = 0; i < this.value.length; i++) {
      const code = this.value.charCodeAt(i);
      if (unicode) { bytes[2 + i * 2] = code >>> 8; bytes[3 + i * 2] = code & 0xff; }
      else bytes[i] = code;
    }
    return bytes;
  }
  /** Decode a PDF text string while retaining byte-oriented access via value/toBytes. */
  toText(): string { return decodePdfTextString(this.toBytes()); }
  toString(): string { return `(${this.value})`; }
}

function decodePdfTextString(bytes: Uint8Array): string {
  let result = '';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff && bytes.length % 2 === 0) {
    for (let i = 2; i < bytes.length; i += 2) result += String.fromCharCode(bytes[i] * 256 + bytes[i + 1]);
  } else {
    // PDFDocEncoding differs from Latin-1 in these ranges; byte-oriented
    // consumers continue to use PDFString.value or toBytes instead.
    const accents = '\u02d8\u02c7\u02c6\u02d9\u02dd\u02db\u02da\u02dc';
    const symbols = '\u2022\u2020\u2021\u2026\u2014\u2013\u0192\u2044\u2039\u203a\u2212\u2030\u201e\u201c\u201d\u2018\u2019\u201a\u2122\ufb01\ufb02\u0141\u0152\u0160\u0178\u017d\u0131\u0142\u0153\u0161\u017e';
    for (const byte of bytes) {
      if (byte === 0x16) result += '\u0017';
      else if (byte >= 0x18 && byte <= 0x1f) result += accents[byte - 0x18];
      else if (byte >= 0x80 && byte <= 0x9e) result += symbols[byte - 0x80];
      else if (byte === 0xa0) result += '\u20ac';
      else if (byte === 0x7f || byte === 0x9f || byte === 0xad) result += '\ufffd';
      else result += String.fromCharCode(byte);
    }
  }
  return result;
}

export class PDFHexString {
  readonly _tag = 'PDFHexString' as const;
  constructor(public readonly hex: string) {}
  /** Decode hex string to raw bytes */
  toBytes(): Uint8Array {
    const clean = this.hex.replace(/[\s\x00]/g, '');
    // Pad with trailing 0 if odd length (per PDF spec)
    const padded = clean.length % 2 === 1 ? clean + '0' : clean;
    const bytes = new Uint8Array(padded.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(padded.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
  /** Decode hex pairs to a string (latin-1) */
  toText(): string {
    const bytes = this.toBytes();
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
  toString(): string { return `<${this.hex}>`; }
}

export class PDFNumber {
  readonly _tag = 'PDFNumber' as const;
  constructor(public readonly value: number) {}
  toString(): string { return String(this.value); }
}

export class PDFBoolean {
  readonly _tag = 'PDFBoolean' as const;
  constructor(public readonly value: boolean) {}
  toString(): string { return this.value ? 'true' : 'false'; }
}

export class PDFNull {
  readonly _tag = 'PDFNull' as const;
  private static _instance: PDFNull | null = null;
  static get instance(): PDFNull {
    if (!PDFNull._instance) PDFNull._instance = new PDFNull();
    return PDFNull._instance;
  }
  toString(): string { return 'null'; }
}

// ─── Indirect reference ────────────────────────────────────────────────────

export class PDFRef {
  readonly _tag = 'PDFRef' as const;
  constructor(
    public readonly objNum: number,
    public readonly genNum: number,
  ) {}
  toKey(): string { return `${this.objNum}_${this.genNum}`; }
  toString(): string { return `${this.objNum} ${this.genNum} R`; }
  equals(other: PDFRef): boolean {
    return this.objNum === other.objNum && this.genNum === other.genNum;
  }
}

// ─── Composite types ───────────────────────────────────────────────────────

export class PDFArray {
  readonly _tag = 'PDFArray' as const;
  constructor(public readonly items: PDFObject[] = []) {}
  get length(): number { return this.items.length; }
  get(index: number): PDFObject | undefined { return this.items[index]; }
  push(item: PDFObject): void { this.items.push(item); }

  /** Helper: get all items as numbers (returns NaN for non-numbers) */
  asNumbers(): number[] {
    return this.items.map((it) =>
      it instanceof PDFNumber ? it.value : NaN,
    );
  }
  toString(): string { return `[${this.items.map(String).join(' ')}]`; }
}

export class PDFDict {
  readonly _tag = 'PDFDict' as const;
  private readonly map: Map<string, PDFObject>;

  constructor(entries?: [string, PDFObject][]) {
    this.map = new Map(entries);
  }

  get(key: string): PDFObject | undefined { return this.map.get(key); }
  set(key: string, value: PDFObject): void { this.map.set(key, value); }
  has(key: string): boolean { return this.map.has(key); }
  delete(key: string): boolean { return this.map.delete(key); }
  entries(): IterableIterator<[string, PDFObject]> { return this.map.entries(); }
  keys(): IterableIterator<string> { return this.map.keys(); }
  values(): IterableIterator<PDFObject> { return this.map.values(); }
  get size(): number { return this.map.size; }

  // ── Typed accessors for common patterns ──

  /** Resolve a key expecting a PDFName, return the name string or undefined */
  getName(key: string): string | undefined {
    const v = this.map.get(key);
    return v instanceof PDFName ? v.name : undefined;
  }

  /** Resolve a key expecting a PDFNumber, return the number or undefined */
  getNumber(key: string): number | undefined {
    const v = this.map.get(key);
    return v instanceof PDFNumber ? v.value : undefined;
  }

  /** Resolve a key expecting a PDFBoolean */
  getBool(key: string): boolean | undefined {
    const v = this.map.get(key);
    return v instanceof PDFBoolean ? v.value : undefined;
  }

  /** Resolve a key expecting a PDFArray */
  getArray(key: string): PDFArray | undefined {
    const v = this.map.get(key);
    return v instanceof PDFArray ? v : undefined;
  }

  /** Resolve a key expecting a PDFDict */
  getDict(key: string): PDFDict | undefined {
    const v = this.map.get(key);
    return v instanceof PDFDict ? v : undefined;
  }

  /** Resolve a key that should be a PDFString or PDFHexString, return text */
  getString(key: string): string | undefined {
    const v = this.map.get(key);
    if (v instanceof PDFString) return v.toText();
    if (v instanceof PDFHexString) return decodePdfTextString(v.toBytes());
    return undefined;
  }

  /** Resolve a key that may be a PDFRef */
  getRef(key: string): PDFRef | undefined {
    const v = this.map.get(key);
    return v instanceof PDFRef ? v : undefined;
  }

  toString(): string {
    const entries: string[] = [];
    Array.from(this.map.entries()).forEach(([k, v]) => entries.push(`/${k} ${v}`));
    return `<< ${entries.join(' ')} >>`;
  }
}

export class PDFStream {
  readonly _tag = 'PDFStream' as const;
  constructor(
    public readonly dict: PDFDict,
    /** Raw (possibly compressed) stream bytes */
    public rawBytes: Uint8Array,
    /** Decoded (decompressed) bytes — populated after filter application */
    public decodedBytes: Uint8Array | null = null,
  ) {}

  /** Get the effective bytes (decoded if available, raw otherwise) */
  getBytes(): Uint8Array {
    return this.decodedBytes ?? this.rawBytes;
  }

  /** Length from the dictionary (pre-decode) */
  get length(): number {
    return this.dict.getNumber('Length') ?? this.rawBytes.length;
  }

  /** Filter names */
  getFilters(): string[] {
    const f = this.dict.get('Filter');
    if (f instanceof PDFName) return [f.name];
    if (f instanceof PDFArray) {
      return f.items
        .filter((it): it is PDFName => it instanceof PDFName)
        .map((n) => n.name);
    }
    return [];
  }

  /** Decode parameters (array of dicts, one per filter) */
  getDecodeParams(): (PDFDict | null)[] {
    const dp = this.dict.get('DecodeParms');
    if (dp instanceof PDFDict) return [dp];
    if (dp instanceof PDFArray) {
      return dp.items.map((it) => (it instanceof PDFDict ? it : null));
    }
    if (dp instanceof PDFNull) return [null];
    return [];
  }
}

// ─── Union type for any PDF object ─────────────────────────────────────────

export type PDFObject =
  | PDFBoolean
  | PDFNumber
  | PDFString
  | PDFHexString
  | PDFName
  | PDFNull
  | PDFArray
  | PDFDict
  | PDFStream
  | PDFRef;

// ─── Cross-reference entry ─────────────────────────────────────────────────

export interface XRefEntry {
  /** Object number */
  objNum: number;
  /** Generation number */
  genNum: number;
  /** Byte offset in the file (for uncompressed objects) */
  offset: number;
  /** Whether this entry is in use ('n') or free ('f') */
  type: 'n' | 'f';
  /** For compressed objects: the object number of the containing ObjStm */
  compressedObjNum?: number;
  /** For compressed objects: the index within the ObjStm */
  compressedIndex?: number;
}

export interface XRefTable {
  entries: Map<string, XRefEntry>; // keyed by "objNum_genNum"
  trailerDict: PDFDict;
  /** Integrity binding for parser-produced xref entries and their source bytes. */
  provenance?: { source: 'strict' | 'conservative'; digest: string; rawDigest?: string };
}

// ─── High-level document structures ────────────────────────────────────────

export interface PDFRectangle {
  x: number;     // lower-left x
  y: number;     // lower-left y
  width: number;
  height: number;
}

export interface PDFPageInfo {
  /** 0-based index */
  index: number;
  /** The page dictionary object */
  dict: PDFDict;
  /** MediaBox in PDF coordinate space */
  mediaBox: PDFRectangle;
  /** CropBox (defaults to MediaBox if absent) */
  cropBox: PDFRectangle;
  /** Page rotation in degrees (0, 90, 180, 270) */
  rotate: number;
  /** Indirect ref to the page object (for back-references) */
  ref: PDFRef;
  /** The Resources dictionary (may be inherited from parent) */
  resources: PDFDict;
  /** Content stream references (single ref or array of refs) */
  contentRefs: PDFRef[];
  /** False when the original Contents structure could not be fully inspected. */
  contentInspectionComplete?: boolean;
}

export interface PDFDocumentInfo {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: string;
  modDate?: string;
}

/**
 * The top-level parsed PDF document.
 * Contains the object graph, page tree, and document metadata.
 */
export interface PDFDocumentData {
  /** PDF version from header (e.g. "1.7", "2.0") */
  version: string;
  /** All indirect objects keyed by "objNum_genNum" */
  objects: Map<string, PDFObject>;
  /** The merged cross-reference table */
  xref: XRefTable;
  /** Catalog dictionary (root of the document) */
  catalog: PDFDict;
  /** Parsed page info array */
  pages: PDFPageInfo[];
  /** Document info dictionary */
  info: PDFDocumentInfo;
  /** The raw file bytes (kept for incremental saves) */
  rawBytes: Uint8Array;
  /** Sensitive content was removed; the original byte prefix must not be reused. */
  requiresFullRewrite?: boolean;
  /** True after securityEngine.open() has decrypted the in-memory objects. */
  decryptedFromEncrypted?: boolean;
  /** Authenticated file key retained only for re-encrypting save output. */
  encryptionFileKey?: Uint8Array;
  /** Original file cipher used by the Standard Security Handler. */
  encryptionAlgorithm?: 'RC4-40' | 'RC4-128' | 'AES-128' | 'AES-256';
}
