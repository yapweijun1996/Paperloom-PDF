import { sha256 } from '@noble/hashes/sha2.js';
import {
  PDFArray, PDFBoolean, PDFDict, PDFHexString, PDFName, PDFNull,
  PDFNumber, PDFRef, PDFStream, PDFString, type PDFObject,
} from '../types';
// Bound the synchronous work performed while interpreting untrusted documents.
const MAX_VALUES = 100_000;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_DEPTH = 128;

/** The budget and cache belong to one synchronous interpretation, never to a document. */
export function createImageResourceVersioner(resources: PDFDict, objects: Map<string, PDFObject>): (name: string) => string | undefined {
  let remainingValues = MAX_VALUES, remainingBytes = MAX_BYTES;
  const versions = new Map<string | PDFObject, string | undefined>();
  let dictionary: PDFObject | undefined, dictionaryResolved = false;
  function consumeValue(): void {
    if (--remainingValues < 0) throw new Error('Image resource graph exceeds fingerprint limit');
  }
  function resolveRef(value: PDFObject): PDFObject {
    const seen = new Set<string>();
    while (value instanceof PDFRef) {
      consumeValue();
      const key = value.toKey();
      if (seen.has(key) || seen.size >= MAX_DEPTH) throw new Error('Invalid image resource reference');
      seen.add(key);
      const next = objects.get(key);
      if (!next) throw new Error('Unresolved image resource');
      value = next;
    }
    return value;
  }
  return (name: string) => {
    let cacheKey: string | PDFObject | undefined;
    try {
      if (!dictionaryResolved) {
        dictionaryResolved = true;
        const category = resources.get('XObject');
        dictionary = category && resolveRef(category);
      }
      const root = dictionary instanceof PDFDict ? dictionary.get(name) : undefined;
      if (!root) return undefined;
      cacheKey = root instanceof PDFRef ? `ref:${root.toKey()}` : root;
      if (versions.has(cacheKey)) return versions.get(cacheKey);
      const hash = sha256.create();
      const encoder = new TextEncoder();
      const active = new Set<PDFObject>();
      const references = new Set<string>();
      const colorSpaces = resources.get('ColorSpace');
      const colorDictionary = colorSpaces ? resolveRef(colorSpaces) : undefined;
      if (colorSpaces && !(colorDictionary instanceof PDFDict)) throw new Error('Invalid color space resources');
      const activeColorNames = new Set<string>();
      function add(data: Uint8Array) {
        if (data.length > remainingBytes) {
          remainingBytes = 0;
          throw new Error('Image resource exceeds fingerprint limit');
        }
        remainingBytes -= data.length;
        hash.update(encoder.encode(`${data.length}:`));
        hash.update(data);
      }
      function text(value: string) { add(encoder.encode(value)); }
      function inspectColorSpace(value: PDFObject, depth: number): void {
        if (depth > MAX_DEPTH) throw new Error('Color space exceeds fingerprint limit');
        consumeValue();
        const resolved = resolveRef(value);
        if (resolved instanceof PDFName) {
          if (['DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'G', 'RGB', 'CMYK'].includes(resolved.name)) return;
          const named = colorDictionary instanceof PDFDict ? colorDictionary.get(resolved.name) : undefined;
          if (!named || activeColorNames.has(resolved.name)) throw new Error('Unresolved named color space');
          activeColorNames.add(resolved.name);
          inspectColorSpace(named, depth + 1);
          activeColorNames.delete(resolved.name);
        } else if (resolved instanceof PDFArray) {
          const kind = resolveRef(resolved.get(0) ?? PDFNull.instance);
          if (!(kind instanceof PDFName)) throw new Error('Invalid color space');
          let base: PDFObject | undefined;
          switch (kind.name) {
            case 'Indexed': case 'I': base = resolved.get(1); break;
            case 'Separation': case 'DeviceN': base = resolved.get(2); break;
            case 'Pattern': base = resolved.get(1); break;
            case 'ICCBased': {
              const profile = resolved.get(1);
              const stream = profile && resolveRef(profile);
              if (!(stream instanceof PDFStream)) throw new Error('Invalid ICC profile');
              base = stream.dict.get('Alternate');
              break;
            }
            case 'CalGray': case 'CalRGB': case 'Lab': return;
            default: throw new Error('Unsupported color space');
          }
          if (base) inspectColorSpace(base, depth + 1);
          else if (kind.name !== 'ICCBased') throw new Error('Missing color space base');
        } else throw new Error('Invalid color space');
      }
      function visit(value: PDFObject, depth: number): void {
        consumeValue();
        if (depth > MAX_DEPTH) throw new Error('Image resource graph exceeds fingerprint limit');
        if (value instanceof PDFRef) {
          const key = value.toKey();
          text(`ref:${key}`);
          if (!references.has(key)) {
            references.add(key);
            const resolved = objects.get(key);
            if (!resolved) throw new Error('Unresolved image resource');
            visit(resolved, depth + 1);
          }
        } else if (value instanceof PDFArray || value instanceof PDFDict || value instanceof PDFStream) {
          if (active.has(value)) throw new Error('Cyclic direct image resource');
          active.add(value);
          if (value instanceof PDFArray) {
            text(`array:${value.length}`);
            for (const item of value.items) visit(item, depth + 1);
          } else if (value instanceof PDFDict) {
            text(`dict:${value.size}`);
            for (const [key, item] of value.entries()) { text(JSON.stringify(key)); visit(item, depth + 1); }
          } else {
            text('stream');
            visit(value.dict, depth + 1);
            add(value.rawBytes);
            if (value.dict.getName('Subtype') === 'Image') {
              const color = value.dict.get('ColorSpace') ?? value.dict.get('CS');
              if (color) inspectColorSpace(color, depth + 1);
            }
          }
          active.delete(value);
        } else if (value instanceof PDFName) text(`name:${JSON.stringify(value.name)}`);
        else if (value instanceof PDFString) text(`string:${JSON.stringify(value.value)}`);
        else if (value instanceof PDFHexString) text(`hex:${JSON.stringify(value.hex)}`);
        else if (value instanceof PDFNumber) text(`number:${String(value.value)}`);
        else if (value instanceof PDFBoolean) text(`boolean:${value.value}`);
        else if (value instanceof PDFNull) text('null');
        else throw new Error('Unknown image resource object');
      }
      visit(root, 0);
      // Named and default device spaces live in page resources rather than in
      // the image object graph. Include their complete graph conservatively.
      if (colorSpaces) { text('page-color-spaces'); visit(colorSpaces, 0); }
      const version = Array.from(hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('');
      versions.set(cacheKey, version);
      return version;
    } catch {
      // Rendering can continue, but the editor must not trust an incomplete identity.
      if (cacheKey !== undefined) versions.set(cacheKey, undefined);
      return undefined;
    }
  };
}

/** A portable fingerprint of an image resource and its indirect dependencies. */
export function imageResourceVersion(resources: PDFDict, name: string, objects: Map<string, PDFObject>): string | undefined {
  return createImageResourceVersioner(resources, objects)(name);
}
