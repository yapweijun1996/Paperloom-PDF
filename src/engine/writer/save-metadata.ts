/** Update only metadata fields already present, so sanitized fields stay absent. */
import { SaxesParser, type SaxesTagNS } from 'saxes';
import { PDFArray, PDFDict, PDFHexString, PDFNumber, PDFRef, PDFStream, PDFString, type PDFDocumentData, type PDFObject } from '../types';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XMP = 'http://ns.adobe.com/xap/1.0/';
const PDF = 'http://ns.adobe.com/pdf/1.3/';
const PRODUCER = 'Paperloom PDF';

type Range = { start: number; end: number; value: string };
function updateXmp(xml: string, date: string): string {
  const parser = new SaxesParser({ xmlns: true });
  const stack: SaxesTagNS[] = [];
  const ranges: Range[] = [];
  const counts = new Map<string, number>();
  let target: { name: string; start: number; depth: number; value: string } | undefined;
  const valueFor = (uri: string, local: string) =>
    uri === XMP && local === 'ModifyDate' ? date : uri === PDF && local === 'Producer' ? PRODUCER : undefined;
  const record = (name: string, start: number, end: number, value: string) => {
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (counts.get(name)! > 1) throw new Error(`Ambiguous duplicate XMP ${name}.`);
    ranges.push({ start, end, value });
  };
  parser.on('doctype', () => { throw new Error('XMP with a DTD cannot be safely updated.'); });
  parser.on('opentag', tag => {
    if (target) throw new Error('Complex XMP properties cannot be safely updated.');
    const end = parser.position;
    const start = xml.lastIndexOf('<', end - 1);
    const markup = xml.slice(start, end);
    const description = tag.uri === RDF && tag.local === 'Description';
    for (const attr of Object.values(tag.attributes)) {
      const value = valueFor(attr.uri, attr.local);
      if (value !== undefined) {
        const parent = stack[stack.length - 1];
        if (!description || !parent || parent.uri !== RDF || parent.local !== 'RDF') {
          throw new Error('Unsupported XMP property structure.');
        }
        const attrPattern = /([^\s=\/<>]+)\s*=\s*(["'])([\s\S]*?)\2/g;
        let found: RegExpExecArray | null;
        let position = -1;
        while ((found = attrPattern.exec(markup))) {
          if (found[1] === attr.name) {
            position = start + found.index + found[0].length - found[3].length - 1;
            record(`${attr.uri}:${attr.local}`, position, position + found[3].length, value);
            break;
          }
        }
        if (position < 0) throw new Error('Could not locate an XMP attribute safely.');
      }
    }
    const value = valueFor(tag.uri, tag.local);
    if (value !== undefined) {
      const parent = stack[stack.length - 1];
      const grandparent = stack[stack.length - 2];
      if (!parent || parent.uri !== RDF || parent.local !== 'Description' || !grandparent || grandparent.uri !== RDF || grandparent.local !== 'RDF' || tag.isSelfClosing || Object.keys(tag.attributes).length) {
        throw new Error('Unsupported XMP property structure.');
      }
      target = { name: `${tag.uri}:${tag.local}`, start: end, depth: stack.length, value };
    }
    stack.push(tag);
  });
  parser.on('closetag', tag => {
    if (target && target.depth === stack.length - 1) {
      const end = xml.lastIndexOf('</', parser.position - 1);
      if (end < target.start || xml.slice(target.start, end).includes('<')) throw new Error('Complex XMP properties cannot be safely updated.');
      record(target.name, target.start, end, target.value);
      target = undefined;
    }
    if (stack.pop() !== tag) throw new Error('Invalid XMP nesting.');
  });
  parser.write(xml).close();
  let result = xml;
  for (const range of ranges.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, range.start) + range.value + result.slice(range.end);
  }
  return result;
}

function resolve(value: PDFObject | undefined, doc: PDFDocumentData): { object: PDFObject | undefined; key?: string } {
  const seen = new Set<string>();
  let key: string | undefined;
  while (value instanceof PDFRef) {
    key = value.toKey();
    if (seen.has(key)) throw new Error('Cyclic metadata reference.');
    seen.add(key);
    value = doc.objects.get(key);
  }
  return { object: value, key };
}

function assertUnsharedReference(value: PDFObject | undefined, doc: PDFDocumentData): void {
  const references = new Set<string>();
  while (value instanceof PDFRef) {
    const key = value.toKey();
    if (references.has(key)) throw new Error('Cyclic metadata reference.');
    references.add(key);
    value = doc.objects.get(key);
  }
  if (references.size === 0 && !value) return;
  const directTarget = references.size === 0 ? value : undefined;
  let directUses = 0;
  const counts = new Map<string, number>();
  const expandedRefs = new Set<string>();
  const seen = new Set<PDFObject>();
  // Only objects reachable from the live trailer can share this metadata.
  // Old xref streams may contain stale copies of the trailer's /Info entry.
  const pending: PDFObject[] = [doc.xref.trailerDict];
  while (pending.length) {
    const object = pending.pop()!;
    if (object instanceof PDFRef) {
      const key = object.toKey();
      if (references.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!expandedRefs.has(key)) {
        expandedRefs.add(key);
        const resolved = doc.objects.get(key);
        if (resolved) pending.push(resolved);
      }
    } else if (!seen.has(object)) {
      seen.add(object);
      const children = object instanceof PDFDict ? [...object.values()]
        : object instanceof PDFArray ? object.items : object instanceof PDFStream ? [object.dict] : [];
      if (directTarget) directUses += children.filter(child => child === directTarget).length;
      pending.push(...children);
    }
  }
  if (directUses > 1 || [...counts.values()].some(count => count > 1)) throw new Error('Shared metadata cannot be safely updated.');
}

function decodeXml(bytes: Uint8Array): { text: string; encoding: 'utf-8' | 'utf-16le' | 'utf-16be' } {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0x3c && bytes[1] === 0 ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff || bytes[0] === 0 && bytes[1] === 0x3c ? 'utf-16be' : 'utf-8';
  const text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes);
  const declared = /^\uFEFF?\s*<\?xml\b[^?]*\bencoding\s*=\s*(["'])([^"']+)\1/i.exec(text)?.[2].toLowerCase();
  if (declared && declared !== encoding && !(declared === 'utf-16' && encoding !== 'utf-8')) throw new Error('Unsupported or inconsistent XMP encoding.');
  return { text, encoding };
}
function encodeXml(text: string, encoding: 'utf-8' | 'utf-16le' | 'utf-16be'): Uint8Array {
  if (encoding === 'utf-8') return new TextEncoder().encode(text);
  const bytes = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes[2 * i] = encoding === 'utf-16le' ? code & 255 : code >>> 8;
    bytes[2 * i + 1] = encoding === 'utf-16le' ? code >>> 8 : code & 255;
  }
  return bytes;
}

/** Caller must first protect signatures and establish that the document was edited. */
export interface SavedMetadataPatch { modDate?: string; producer?: string; xmpBytes?: Uint8Array }
const savedPatches = new WeakMap<PDFDocumentData, SavedMetadataPatch>();
export function getSavedMetadataPatch(doc: PDFDocumentData): SavedMetadataPatch | undefined { return savedPatches.get(doc); }

export function applySavedMetadataPatch(doc: PDFDocumentData, patch: SavedMetadataPatch): void {
  const info = resolve(doc.xref.trailerDict.get('Info'), doc).object;
  if (info instanceof PDFDict) {
    if (patch.modDate !== undefined) info.set('ModDate', PDFString.fromText(patch.modDate));
    if (patch.producer !== undefined) info.set('Producer', PDFString.fromText(patch.producer));
    doc.info = { ...doc.info, modDate: info.getString('ModDate'), producer: info.getString('Producer') };
  }
  if (patch.xmpBytes) {
    const stream = resolve(doc.catalog.get('Metadata'), doc).object;
    if (!(stream instanceof PDFStream)) throw new Error('XMP metadata changed during save.');
    stream.dict.delete('Filter');
    stream.dict.delete('DecodeParms');
    stream.dict.set('Length', new PDFNumber(patch.xmpBytes.length));
    stream.rawBytes = patch.xmpBytes;
    stream.decodedBytes = patch.xmpBytes;
  }
}

export function updateExistingSaveMetadata(doc: PDFDocumentData, now = new Date()): Set<string> {
  const changed = new Set<string>();
  const patch: SavedMetadataPatch = {};
  const infoValue = doc.xref.trailerDict.get('Info');
  const metadataValue = doc.catalog.get('Metadata');
  const info = resolve(infoValue, doc);
  if (infoValue && !info.object) throw new Error('Unresolved Info metadata dictionary.');
  if (info.object !== undefined && !(info.object instanceof PDFDict)) throw new Error('Invalid Info metadata dictionary.');
  const metadata = resolve(metadataValue, doc);
  if (metadataValue && !metadata.object) throw new Error('Unresolved XMP metadata stream.');
  if (metadata.object !== undefined && !(metadata.object instanceof PDFStream)) throw new Error('Invalid XMP metadata stream.');
  assertUnsharedReference(infoValue, doc);
  assertUnsharedReference(metadataValue, doc);
  const isoDate = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  let replacement: Uint8Array | undefined;
  if (metadata.object instanceof PDFStream) {
    const stream = metadata.object;
    if (stream.dict.has('Filter') && (!stream.decodedBytes || stream.decodedBytes.every((v, i) => v === stream.rawBytes[i]) && stream.decodedBytes.length === stream.rawBytes.length)) {
      throw new Error('XMP metadata could not be safely decoded.');
    }
    try {
      const { text, encoding } = decodeXml(stream.getBytes());
      const updated = updateXmp(text, isoDate);
      if (updated !== text) replacement = encodeXml(updated, encoding);
    } catch (error) {
      throw new Error(`XMP metadata cannot be safely updated: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (info.object instanceof PDFDict) {
    const date = `D:${isoDate.slice(0, 19).replace(/[-:T]/g, '')}Z`;
    for (const [key, value] of [['ModDate', date], ['Producer', PRODUCER]] as const) {
      if (info.object.has(key)) {
        const current = resolve(info.object.get(key), doc).object;
        if (!(current instanceof PDFString || current instanceof PDFHexString)) throw new Error(`Invalid Info ${key} value.`);
        info.object.set(key, PDFString.fromText(value));
        if (key === 'ModDate') patch.modDate = value; else patch.producer = value;
      }
    }
    doc.info = { ...doc.info, modDate: info.object.getString('ModDate'), producer: info.object.getString('Producer') };
    if (info.key) changed.add(info.key);
  }
  if (replacement && metadata.object instanceof PDFStream) {
    const stream = metadata.object;
    stream.dict.delete('Filter');
    stream.dict.delete('DecodeParms');
    stream.dict.set('Length', new PDFNumber(replacement.length));
    stream.rawBytes = replacement;
    stream.decodedBytes = replacement;
    patch.xmpBytes = replacement;
    if (metadata.key) changed.add(metadata.key);
    else {
      const catalog = doc.xref.trailerDict.get('Root');
      if (catalog instanceof PDFRef) changed.add(catalog.toKey());
    }
  }
  if (patch.modDate !== undefined || patch.producer !== undefined || patch.xmpBytes) savedPatches.set(doc, patch);
  return changed;
}
