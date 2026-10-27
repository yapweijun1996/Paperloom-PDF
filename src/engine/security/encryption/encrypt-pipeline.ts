/**
 * Encrypt document objects and build /Encrypt dictionary (Phase 4).
 */

import {
  PDFArray,
  PDFBoolean,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFDocumentData,
} from '../../types';
import { getNextObjNum } from '../../writer/serializer';
import type {
  EncryptDictionary,
  EncryptOptions,
  EncryptionAlgorithm,
  EncryptionContext,
  PdfPermissions,
} from '../types';
import { mergePermissions } from '../permissions/permission-bits';
import {
  createEncryptionR2R4,
  createEncryptionR6,
  detectAlgorithm,
} from './standard-handler';
import {
  bytesToPdfHex,
  ensureFileId,
  parseEncryptDict,
} from './encrypt-dict';
import {
  computeObjectKey,
  encryptBytes,
  shouldEncryptStream,
  shouldEncryptString,
} from './object-cipher';
import { stringToPdfBytes } from '../crypto/bytes';

function asPdfStringBytes(obj: PDFString | PDFHexString): Uint8Array {
  return obj.toBytes();
}

/**
 * Encrypt all strings/streams in place and attach Encrypt dict to trailer.
 */
export async function encryptDocumentObjects(
  doc: PDFDocumentData,
  options: EncryptOptions = {},
): Promise<EncryptionContext> {
  const algorithm: EncryptionAlgorithm = options.algorithm ?? 'AES-256';
  const userPassword = options.userPassword ?? '';
  const ownerPassword = options.ownerPassword ?? userPassword;
  const permissions: PdfPermissions = mergePermissions(options.permissions);
  const encryptMetadata = options.encryptMetadata ?? true;

  const fileId = ensureFileId(doc.xref.trailerDict);

  let fileKey: Uint8Array;
  let encryptDict: PDFDict;
  let parsed: EncryptDictionary;

  if (algorithm === 'AES-256') {
    const mat = await createEncryptionR6(userPassword, ownerPassword, permissions, encryptMetadata);
    fileKey = mat.fileKey;
    encryptDict = buildEncryptDictR6(mat, encryptMetadata);
    parsed = parseEncryptDict(encryptDict);
  } else {
    const mat = createEncryptionR2R4(
      userPassword,
      ownerPassword,
      permissions,
      algorithm,
      fileId,
      encryptMetadata,
    );
    fileKey = mat.fileKey;
    encryptDict = buildEncryptDictR2R4(mat, algorithm, encryptMetadata);
    parsed = parseEncryptDict(encryptDict);
  }

  // Assign Encrypt as a new indirect object
  const objNum = getNextObjNum(doc);
  const encryptRef = new PDFRef(objNum, 0);
  doc.objects.set(encryptRef.toKey(), encryptDict);
  doc.xref.trailerDict.set('Encrypt', encryptRef);
  parsed.ref = encryptRef;
  parsed.dict = encryptDict;

  const ctx: EncryptionContext = {
    encrypt: parsed,
    fileId,
    fileKey,
    isOwner: true,
    algorithm: detectAlgorithm(parsed),
  };

  // Encrypt all objects
  for (const [key, obj] of doc.objects.entries()) {
    if (key === encryptRef.toKey()) continue;
    const parts = key.split('_');
    const on = parseInt(parts[0], 10);
    const gn = parseInt(parts[1], 10);

    if (obj instanceof PDFStream) {
      await encryptStream(obj, on, gn, ctx);
    } else if (shouldEncryptString(parsed)) {
      await encryptObjectValue(obj, on, gn, ctx, new Set());
    }
  }

  // Bump version for AES
  if (algorithm === 'AES-256' && parseFloat(doc.version) < 1.7) {
    doc.version = '1.7';
  } else if (algorithm === 'AES-128' && parseFloat(doc.version) < 1.6) {
    doc.version = '1.6';
  }

  return ctx;
}

function buildEncryptDictR6(
  mat: Awaited<ReturnType<typeof createEncryptionR6>>,
  encryptMetadata: boolean,
): PDFDict {
  const cf = new PDFDict();
  const stdCF = new PDFDict();
  stdCF.set('CFM', new PDFName('AESV3'));
  stdCF.set('Length', new PDFNumber(32));
  stdCF.set('AuthEvent', new PDFName('DocOpen'));
  cf.set('StdCF', stdCF);

  const d = new PDFDict();
  d.set('Filter', new PDFName('Standard'));
  d.set('V', new PDFNumber(5));
  d.set('R', new PDFNumber(6));
  d.set('Length', new PDFNumber(256));
  d.set('O', bytesToPdfHex(mat.O));
  d.set('U', bytesToPdfHex(mat.U));
  d.set('OE', bytesToPdfHex(mat.OE));
  d.set('UE', bytesToPdfHex(mat.UE));
  d.set('Perms', bytesToPdfHex(mat.Perms));
  d.set('P', new PDFNumber(mat.P));
  d.set('EncryptMetadata', new PDFBoolean(encryptMetadata));
  d.set('CF', cf);
  d.set('StmF', new PDFName('StdCF'));
  d.set('StrF', new PDFName('StdCF'));
  return d;
}

function buildEncryptDictR2R4(
  mat: ReturnType<typeof createEncryptionR2R4>,
  algorithm: EncryptionAlgorithm,
  encryptMetadata: boolean,
): PDFDict {
  const d = new PDFDict();
  d.set('Filter', new PDFName('Standard'));
  d.set('V', new PDFNumber(mat.version));
  d.set('R', new PDFNumber(mat.revision));
  d.set('Length', new PDFNumber(mat.length));
  d.set('O', bytesToPdfHex(mat.O));
  d.set('U', bytesToPdfHex(mat.U));
  d.set('P', new PDFNumber(mat.P));

  if (algorithm === 'AES-128') {
    d.set('EncryptMetadata', new PDFBoolean(encryptMetadata));
    const cf = new PDFDict();
    const stdCF = new PDFDict();
    stdCF.set('CFM', new PDFName('AESV2'));
    stdCF.set('Length', new PDFNumber(16));
    stdCF.set('AuthEvent', new PDFName('DocOpen'));
    cf.set('StdCF', stdCF);
    d.set('CF', cf);
    d.set('StmF', new PDFName('StdCF'));
    d.set('StrF', new PDFName('StdCF'));
  }

  return d;
}

async function encryptStream(
  stream: PDFStream,
  objNum: number,
  genNum: number,
  ctx: EncryptionContext,
): Promise<void> {
  const type = stream.dict.getName('Type');
  const subtype = stream.dict.getName('Subtype');
  if (!shouldEncryptStream(ctx.encrypt, { type, subtype })) return;

  // Encrypt the stored bytes (prefer raw/compressed form)
  const source = stream.rawBytes;
  const key = computeObjectKey(ctx.fileKey!, objNum, genNum, ctx.algorithm);
  const cipher = await encryptBytes(source, key, ctx.algorithm);
  stream.rawBytes = cipher;
  stream.decodedBytes = null;
  stream.dict.set('Length', new PDFNumber(cipher.length));
}

async function encryptObjectValue(
  obj: PDFObject,
  objNum: number,
  genNum: number,
  ctx: EncryptionContext,
  seen: Set<PDFObject>,
): Promise<void> {
  if (seen.has(obj)) return;
  seen.add(obj);

  if (obj instanceof PDFString || obj instanceof PDFHexString) {
    // Mutate by replacing is hard for immutable wrappers — callers replace dict entries
    return;
  }

  if (obj instanceof PDFDict) {
    for (const [k, v] of [...obj.entries()]) {
      if (v instanceof PDFString || v instanceof PDFHexString) {
        const key = computeObjectKey(ctx.fileKey!, objNum, genNum, ctx.algorithm);
        const cipher = await encryptBytes(asPdfStringBytes(v), key, ctx.algorithm);
        obj.set(k, bytesToPdfHex(cipher));
      } else if (v instanceof PDFDict || v instanceof PDFArray) {
        await encryptObjectValue(v, objNum, genNum, ctx, seen);
      }
    }
    return;
  }

  if (obj instanceof PDFArray) {
    for (let i = 0; i < obj.items.length; i++) {
      const v = obj.items[i];
      if (v instanceof PDFString || v instanceof PDFHexString) {
        const key = computeObjectKey(ctx.fileKey!, objNum, genNum, ctx.algorithm);
        const cipher = await encryptBytes(asPdfStringBytes(v), key, ctx.algorithm);
        obj.items[i] = bytesToPdfHex(cipher);
      } else if (v instanceof PDFDict || v instanceof PDFArray) {
        await encryptObjectValue(v, objNum, genNum, ctx, seen);
      }
    }
  }
}

/** Serialize EncryptDictionary back to PDFDict (permission updates etc.). */
export function serializeEncryptDict(enc: EncryptDictionary): PDFDict {
  return enc.dict;
}

export { stringToPdfBytes };
