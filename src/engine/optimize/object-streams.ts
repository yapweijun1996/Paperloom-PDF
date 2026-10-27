/**
 * PDF Object Streams (ObjStm) and Cross-Reference Streams.
 *
 * Packs non-stream indirect objects into compressed ObjStm containers
 * and generates a cross-reference stream instead of a plain-text xref table.
 *
 * Requires PDF 1.5+. Object streams typically save 10–20% of structural overhead.
 *
 * ISO 32000-2 §7.5.7: Object Streams
 * ISO 32000-2 §7.5.8: Cross-Reference Streams
 *
 * Restrictions:
 *   - Only objects with generation number 0 can be packed into ObjStm
 *   - Stream objects cannot be packed (they are already streams)
 *   - The document catalog and encryption dicts must remain standalone
 *   - Each ObjStm has a /N (count), /First (byte offset of first object data)
 */

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  type PDFObject,
  type PDFDocumentData,
} from '../types';
import { serializeToString } from '../editor/stream-compiler';
import { flateEncode } from '../parser/filters';

/** Max objects per ObjStm — balances compression ratio vs random access cost */
const OBJECTS_PER_STREAM = 100;

export interface ObjectStreamPack {
  /** Objects that must remain standalone (streams, catalog, encrypt, etc.) */
  standaloneObjects: Map<string, { objNum: number; genNum: number; obj: PDFObject }>;
  /** Generated ObjStm containers */
  objStreams: Array<{ objNum: number; stream: PDFStream; packedObjNums: number[] }>;
  /** Mapping of packed objNum → { containerObjNum, indexInContainer } */
  packMap: Map<number, { containerObjNum: number; index: number }>;
}

/**
 * Determine which objects can be packed into ObjStm containers.
 */
function classifyObjects(
  objects: Map<string, PDFObject>,
  catalogRef: PDFRef | undefined,
  encryptRef: PDFRef | undefined,
): { packable: Array<{ key: string; objNum: number; obj: PDFObject }>; standalone: Array<{ key: string; objNum: number; genNum: number; obj: PDFObject }> } {
  const packable: Array<{ key: string; objNum: number; obj: PDFObject }> = [];
  const standalone: Array<{ key: string; objNum: number; genNum: number; obj: PDFObject }> = [];

  const catalogKey = catalogRef?.toKey();
  const encryptKey = encryptRef?.toKey();

  for (const [key, obj] of objects) {
    const parts = key.split('_');
    const objNum = parseInt(parts[0], 10);
    const genNum = parseInt(parts[1], 10);

    // Cannot pack: streams, non-zero gen, catalog, encrypt
    if (
      obj instanceof PDFStream ||
      genNum !== 0 ||
      key === catalogKey ||
      key === encryptKey
    ) {
      standalone.push({ key, objNum, genNum, obj });
    } else {
      packable.push({ key, objNum, obj });
    }
  }

  // Sort packable by object number for deterministic output
  packable.sort((a, b) => a.objNum - b.objNum);

  return { packable, standalone };
}

function stringToBytes(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i) & 0xff;
  }
  return bytes;
}

/**
 * Pack objects into ObjStm containers.
 *
 * @param objects All document objects
 * @param nextObjNum The next available object number (for ObjStm objects)
 * @param catalogRef Reference to the document catalog
 * @param encryptRef Reference to the encryption dictionary (if any)
 */
export async function packIntoObjectStreams(
  objects: Map<string, PDFObject>,
  nextObjNum: number,
  catalogRef?: PDFRef,
  encryptRef?: PDFRef,
): Promise<ObjectStreamPack> {
  const { packable, standalone } = classifyObjects(objects, catalogRef, encryptRef);

  const result: ObjectStreamPack = {
    standaloneObjects: new Map(),
    objStreams: [],
    packMap: new Map(),
  };

  // Add standalone objects
  for (const entry of standalone) {
    result.standaloneObjects.set(entry.key, {
      objNum: entry.objNum,
      genNum: entry.genNum,
      obj: entry.obj,
    });
  }

  // If nothing to pack, bail
  if (packable.length === 0) return result;

  // Group packable objects into chunks
  let currentObjStreamNum = nextObjNum;

  for (let chunkStart = 0; chunkStart < packable.length; chunkStart += OBJECTS_PER_STREAM) {
    const chunk = packable.slice(chunkStart, chunkStart + OBJECTS_PER_STREAM);
    const containerObjNum = currentObjStreamNum++;

    // Build the ObjStm content:
    // Header: "objNum1 offset1 objNum2 offset2 ..."
    // Body: "serializedObj1 serializedObj2 ..."
    const serializedObjects: string[] = [];
    const objNums: number[] = [];

    for (const entry of chunk) {
      objNums.push(entry.objNum);
      serializedObjects.push(serializeToString(entry.obj));
    }

    // Calculate offsets for each object in the body
    const bodyParts: string[] = [];
    const offsets: number[] = [];
    let bodyOffset = 0;

    for (let i = 0; i < serializedObjects.length; i++) {
      offsets.push(bodyOffset);
      const objStr = serializedObjects[i];
      bodyParts.push(objStr);
      // Objects are separated by whitespace
      bodyOffset += objStr.length;
      if (i < serializedObjects.length - 1) {
        bodyOffset += 1; // space separator
      }
    }

    // Build header
    const headerParts: string[] = [];
    for (let i = 0; i < objNums.length; i++) {
      headerParts.push(`${objNums[i]} ${offsets[i]}`);
    }
    const header = headerParts.join(' ') + ' ';
    const body = bodyParts.join(' ');
    const combined = header + body;
    const rawBytes = stringToBytes(combined);

    // Flate-compress
    const compressed = await flateEncode(rawBytes);

    // Build ObjStm dictionary
    const dict = new PDFDict();
    dict.set('Type', new PDFName('ObjStm'));
    dict.set('N', new PDFNumber(chunk.length));
    dict.set('First', new PDFNumber(header.length));
    dict.set('Length', new PDFNumber(compressed.length));
    dict.set('Filter', new PDFName('FlateDecode'));

    const stream = new PDFStream(dict, compressed, rawBytes);

    result.objStreams.push({
      objNum: containerObjNum,
      stream,
      packedObjNums: objNums,
    });

    // Record pack mapping
    for (let i = 0; i < objNums.length; i++) {
      result.packMap.set(objNums[i], { containerObjNum, index: i });
    }
  }

  return result;
}

// ─── Cross-reference stream ─────────────────────────────────────────────────

/**
 * XRef stream entry types (ISO 32000-2 Table 18):
 *   Type 0: free object (f entries)
 *   Type 1: uncompressed object — offset in file
 *   Type 2: compressed object in ObjStm — container obj num + index
 */

interface XRefStreamEntry {
  type: 0 | 1 | 2;
  /** For type 1: byte offset. For type 2: ObjStm object number */
  field2: number;
  /** For type 0: next free obj. For type 1: gen number. For type 2: index in ObjStm */
  field3: number;
}

/**
 * Build a cross-reference stream that replaces both the xref table and trailer.
 *
 * @param standaloneOffsets Map of object number → byte offset in file
 * @param packMap Map of object number → { containerObjNum, index }
 * @param maxObjNum The highest object number in the file
 * @param xrefObjNum The object number assigned to this xref stream
 * @param trailerDict The trailer dictionary entries to include
 */
export async function buildXRefStream(
  standaloneOffsets: Map<number, { offset: number; genNum: number }>,
  packMap: Map<number, { containerObjNum: number; index: number }>,
  maxObjNum: number,
  xrefObjNum: number,
  trailerKeys: {
    root?: PDFRef;
    info?: PDFObject;
    encrypt?: PDFObject;
    id?: PDFObject;
    size: number;
  },
): Promise<{ objNum: number; stream: PDFStream; bytes: Uint8Array }> {
  const size = maxObjNum + 1;

  // Build entries array
  const entries: XRefStreamEntry[] = [];

  // Entry 0: free head (points to 0)
  entries.push({ type: 0, field2: 0, field3: 65535 });

  for (let objNum = 1; objNum < size; objNum++) {
    const standaloneEntry = standaloneOffsets.get(objNum);
    const packEntry = packMap.get(objNum);

    if (standaloneEntry) {
      entries.push({ type: 1, field2: standaloneEntry.offset, field3: standaloneEntry.genNum });
    } else if (packEntry) {
      entries.push({ type: 2, field2: packEntry.containerObjNum, field3: packEntry.index });
    } else {
      // Free entry
      entries.push({ type: 0, field2: 0, field3: 0 });
    }
  }

  // Determine field widths (W array)
  // Field 1: type — always 1 byte (values 0, 1, 2)
  const w1 = 1;

  // Field 2: max value determines byte width
  let maxField2 = 0;
  let maxField3 = 0;
  for (const e of entries) {
    if (e.field2 > maxField2) maxField2 = e.field2;
    if (e.field3 > maxField3) maxField3 = e.field3;
  }
  const w2 = bytesNeeded(maxField2);
  const w3 = bytesNeeded(maxField3);

  // Build binary xref data
  const entrySize = w1 + w2 + w3;
  const xrefData = new Uint8Array(entries.length * entrySize);

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const offset = i * entrySize;
    writeIntBytes(xrefData, offset, e.type, w1);
    writeIntBytes(xrefData, offset + w1, e.field2, w2);
    writeIntBytes(xrefData, offset + w1 + w2, e.field3, w3);
  }

  // Flate-compress
  const compressed = await flateEncode(xrefData);

  // Build xref stream dictionary
  const dict = new PDFDict();
  dict.set('Type', new PDFName('XRef'));
  dict.set('Size', new PDFNumber(size));
  dict.set('W', new PDFArray([
    new PDFNumber(w1),
    new PDFNumber(w2),
    new PDFNumber(w3),
  ]));
  dict.set('Filter', new PDFName('FlateDecode'));
  dict.set('Length', new PDFNumber(compressed.length));

  // Include trailer keys
  if (trailerKeys.root) dict.set('Root', trailerKeys.root);
  if (trailerKeys.info) dict.set('Info', trailerKeys.info as PDFObject);
  if (trailerKeys.encrypt) dict.set('Encrypt', trailerKeys.encrypt);
  if (trailerKeys.id) dict.set('ID', trailerKeys.id);

  const stream = new PDFStream(dict, compressed, xrefData);

  // Serialize this object for writing
  const header = `${xrefObjNum} 0 obj\n`;
  const dictStr = serializeToString(dict);
  const prefix = stringToBytes(`${header}${dictStr}\nstream\n`);
  const suffix = stringToBytes('\nendstream\nendobj\n');

  const totalLen = prefix.length + compressed.length + suffix.length;
  const bytes = new Uint8Array(totalLen);
  bytes.set(prefix, 0);
  bytes.set(compressed, prefix.length);
  bytes.set(suffix, prefix.length + compressed.length);

  return { objNum: xrefObjNum, stream, bytes };
}

function bytesNeeded(value: number): number {
  if (value <= 0xFF) return 1;
  if (value <= 0xFFFF) return 2;
  if (value <= 0xFFFFFF) return 3;
  return 4;
}

function writeIntBytes(data: Uint8Array, offset: number, value: number, width: number): void {
  // Big-endian
  for (let i = width - 1; i >= 0; i--) {
    data[offset + i] = value & 0xFF;
    value = value >>> 8;
  }
}
