/**
 * Decrypt all encrypted strings and streams in a PDF document.
 */

import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFNumber,
  PDFObject,
  PDFStream,
  PDFString,
  type PDFDocumentData,
} from '../../types';
import { applyFilters, DecodeLimitError } from '../../parser/filters';
import { EncryptedObjectMaterializer, restoreEncryptedIndirectStream } from '../../parser/parser';
import { runDocumentTransaction } from '../../session/document-transaction';
import type { EncryptionContext } from '../types';
import {
  algorithmForEncrypt,
  algorithmForFilter,
  computeObjectKey,
  decryptBytes,
  shouldEncryptStream,
  shouldEncryptString,
} from './object-cipher';
import { pdfBytesToString, bytesToHex } from '../crypto/bytes';

// Limit the total decoded data used to materialize object streams in one file.
export const MAX_ENCRYPTED_OBJECT_STREAM_BYTES = 32 * 1024 * 1024;

/**
 * Walk the object graph and decrypt strings/streams in place.
 * Then apply compression filters to streams.
 */
export async function decryptDocumentObjects(
  doc: PDFDocumentData,
  ctx: EncryptionContext,
): Promise<void> {
  await runDocumentTransaction(doc, async staged => {
    await decryptDocumentObjectsInPlace(staged, ctx);
  });
}

async function decryptDocumentObjectsInPlace(
  doc: PDFDocumentData,
  ctx: EncryptionContext,
): Promise<void> {
  if (!ctx.fileKey) throw new Error('No file encryption key — authenticate first');

  const enc = ctx.encrypt;
  const encryptRefKey = enc.ref?.toKey();
  const requiredObjectStreams = new Set([...doc.xref.entries.values()]
    .flatMap(entry => entry.type !== 'f' && entry.compressedObjNum !== undefined ? [entry.compressedObjNum] : []));
  let remainingObjectBytes = MAX_ENCRYPTED_OBJECT_STREAM_BYTES;
  const chargeObjectBytes = (bytes: number) => {
    if (bytes > remainingObjectBytes) throw new DecodeLimitError();
    remainingObjectBytes -= bytes;
  };

  const pendingStreams = new Map<string, PDFStream>();
  for (const [key, obj] of doc.objects.entries()) {
    // Never decrypt the Encrypt dictionary itself
    if (encryptRefKey && key === encryptRefKey) continue;

    const parts = key.split('_');
    const objNum = parseInt(parts[0], 10);
    const genNum = parseInt(parts[1], 10);

    if (obj instanceof PDFStream) {
      pendingStreams.set(key, obj);
      continue;
    }

    if (shouldEncryptString(enc)) {
      const decrypted = await decryptObjectValue(obj, objNum, genNum, ctx, new Set());
      if (decrypted !== obj) {
        doc.objects.set(key, decrypted);
      }
    }
  }

  const materializer = new EncryptedObjectMaterializer(doc);
  let passes = 0;
  while (pendingStreams.size) {
    if (++passes > 64) throw new Error('Invalid stream length: object-stream dependency chain is too deep');
    let progress = false;
    for (const [key, obj] of pendingStreams) {
      // A ciphertext stream may contain an endstream byte sequence. Never
      // decrypt the provisional slice before the authenticated length is known.
      if (!restoreEncryptedIndirectStream(doc, key, obj)) continue;
      const [objectNumber, generationNumber] = key.split('_').map(Number);
      if (obj.dict.getName('Type') !== 'XRef' && shouldEncryptString(enc)) {
        await decryptObjectValue(obj.dict, objectNumber, generationNumber, ctx, new Set());
      }
      const isObjectStream = obj.dict.getName('Type') === 'ObjStm';
      await decryptStream(obj, objectNumber, generationNumber, ctx, isObjectStream
        ? requiredObjectStreams.has(objectNumber) ? { remaining: () => remainingObjectBytes, charge: chargeObjectBytes } : 'defer'
        : undefined);
      pendingStreams.delete(key);
      progress = true;
    }
    if (materializer.processAvailable()) progress = true;
    if (!progress) break;
  }
  if (pendingStreams.size) throw new Error('Invalid stream length: unresolved encrypted object-stream dependency');
  materializer.processAvailable();
  materializer.finish();

  // Trailer strings (rarely encrypted for ID)
  // Re-decode page content is handled by stream decrypt + filters
}

async function decryptStream(
  stream: PDFStream,
  objNum: number,
  genNum: number,
  ctx: EncryptionContext,
  objectBudget?: { remaining: () => number; charge: (bytes: number) => void } | 'defer',
): Promise<void> {
  const type = stream.dict.getName('Type');
  const subtype = stream.dict.getName('Subtype');

  if (type === 'XRef') return;

  if (!shouldEncryptStream(ctx.encrypt, { type, subtype })) {
    // Still apply filters
    if (objectBudget !== 'defer') await decodeFilters(stream, objectBudget);
    else stream.decodedBytes = null;
    return;
  }

  const algorithm = algorithmForFilter(ctx.encrypt, ctx.encrypt.stmF);
  if (!algorithm) {
    if (objectBudget !== 'defer') await decodeFilters(stream, objectBudget);
    else stream.decodedBytes = null;
    return;
  }
  const key = computeObjectKey(ctx.fileKey!, objNum, genNum, algorithm);
  let plain: Uint8Array;
  try { plain = await decryptBytes(stream.rawBytes, key, algorithm); }
  catch { throw new Error('Invalid stream length or encrypted stream data'); }
  stream.rawBytes = plain;
  stream.dict.set('Length', new PDFNumber(plain.length));
  if (objectBudget !== 'defer') await decodeFilters(stream, objectBudget);
  else stream.decodedBytes = null;
}

async function decodeFilters(stream: PDFStream, budget?: { remaining: () => number; charge: (bytes: number) => void }): Promise<void> {
  const filters = stream.getFilters();
  if (filters.length === 0) {
    budget?.charge(stream.rawBytes.length);
    stream.decodedBytes = stream.rawBytes;
    return;
  }
  // Skip Crypt filter — already handled at document level
  const filtered = filters.filter((f) => f !== 'Crypt');
  if (filtered.length === 0) {
    budget?.charge(stream.rawBytes.length);
    stream.decodedBytes = stream.rawBytes;
    return;
  }
  try {
    stream.decodedBytes = await applyFilters(stream.rawBytes, filtered, stream.getDecodeParams(), budget && {
      remainingDecodedBytes: budget.remaining,
      consumeDecodedBytes: budget.charge,
      consumeFailedDecodedBytes: budget.charge,
    });
  } catch (e) {
    if (budget || e instanceof DecodeLimitError) throw e;
    console.warn('[Security] Filter decode failed after decrypt:', e);
    stream.decodedBytes = stream.rawBytes;
  }
}

async function decryptObjectValue(
  obj: PDFObject,
  objNum: number,
  genNum: number,
  ctx: EncryptionContext,
  seen: Set<PDFObject>,
): Promise<PDFObject> {
  if (seen.has(obj)) return obj;
  seen.add(obj);

  if (obj instanceof PDFString || obj instanceof PDFHexString) {
    const algorithm = algorithmForFilter(ctx.encrypt, ctx.encrypt.strF);
    if (!algorithm) return obj;
    const key = computeObjectKey(ctx.fileKey!, objNum, genNum, algorithm);
    const plain = await decryptBytes(obj.toBytes(), key, algorithm);
    return new PDFString(pdfBytesToString(plain));
  }

  if (obj instanceof PDFDict) {
    for (const [k, v] of obj.entries()) {
      obj.set(k, await decryptObjectValue(v, objNum, genNum, ctx, seen));
    }
    return obj;
  }

  if (obj instanceof PDFArray) {
    for (let i = 0; i < obj.items.length; i++) {
      obj.items[i] = await decryptObjectValue(obj.items[i], objNum, genNum, ctx, seen);
    }
    return obj;
  }

  return obj;
}

/**
 * Decrypt a single string given object numbers (for incremental use).
 */
export async function decryptStringBytes(
  data: Uint8Array,
  fileKey: Uint8Array,
  objNum: number,
  genNum: number,
  algorithm: EncryptionContext['algorithm'],
): Promise<Uint8Array> {
  const key = computeObjectKey(fileKey, objNum, genNum, algorithm);
  return decryptBytes(data, key, algorithm);
}

export { algorithmForEncrypt, bytesToHex };
