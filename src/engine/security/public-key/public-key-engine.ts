/**
 * Public Key Encryption Engine — Adobe.PubSec (Phase 6).
 * Encrypts documents for certificate recipients. Does NOT implement signatures.
 */

import {
  PDFArray,
  PDFBoolean,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFDocumentData,
  type PDFObject,
} from '../../types';
import type {
  EncryptDictionary,
  EncryptionAlgorithm,
  IPublicKeyEncryptionEngine,
  PublicKeyEncryptOptions,
  RecipientCert,
  RecipientInfo,
  SecurityOpenResult,
} from '../types';
import { mergePermissions, serializePermissions } from '../permissions/permission-bits';
import { permissionEngine } from '../permissions/permission-engine';
import {
  ensureFileId,
  bytesToPdfHex,
  parseEncryptDict,
  parseFileId,
} from '../encryption/encrypt-dict';
import { decryptDocumentObjects } from '../encryption/decrypt-pipeline';
import {
  computeObjectKey,
  encryptBytes,
  shouldEncryptStream,
  shouldEncryptString,
} from '../encryption/object-cipher';
import { getNextObjNum } from '../../writer/serializer';
import { randomBytes } from '../crypto/bytes';
import { buildRecipientCms, unwrapFileKeyFromCms } from './cms-enveloped';
import { RecipientManager, recipientInfoFromCms } from './recipient-manager';
import { parseCertificateDer } from '../../signatures/certificates/certificate-parser';

function asBytes(obj: PDFObject | undefined): Uint8Array {
  if (!obj) return new Uint8Array(0);
  if (obj instanceof PDFString) return obj.toBytes();
  if (obj instanceof PDFHexString) return obj.toBytes();
  return new Uint8Array(0);
}

export class PublicKeyEncryptionEngine implements IPublicKeyEncryptionEngine {
  readonly recipients = new RecipientManager();

  isPublicKeyHandler(enc: EncryptDictionary): boolean {
    return (
      enc.filter === 'Adobe.PubSec' ||
      !!enc.subFilter?.toLowerCase().includes('smime') ||
      !!enc.subFilter?.toLowerCase().includes('pkcs7')
    );
  }

  async listRecipients(doc: PDFDocumentData): Promise<RecipientInfo[]> {
    const encryptObj = doc.xref.trailerDict.get('Encrypt');
    if (!encryptObj) return [];
    const dict =
      encryptObj instanceof PDFRef ? doc.objects.get(encryptObj.toKey()) : encryptObj;
    if (!(dict instanceof PDFDict)) return [];

    const rec = dict.get('Recipients');
    if (!(rec instanceof PDFArray)) return [];
    const out: RecipientInfo[] = [];
    for (let i = 0; i < rec.length; i++) {
      const bytes = asBytes(rec.get(i));
      if (bytes.length === 0) continue;
      out.push(recipientInfoFromCms(i, bytes));
    }
    return out;
  }

  async encryptForRecipients(
    doc: PDFDocumentData,
    recipients: RecipientCert[],
    options: PublicKeyEncryptOptions = {},
  ): Promise<PDFDocumentData> {
    if (recipients.length === 0) {
      throw new Error('At least one recipient certificate is required');
    }
    if (doc.xref.trailerDict.has('Encrypt')) {
      throw new Error('Document is already encrypted');
    }

    const algorithm = options.algorithm ?? 'AES-256';
    const permissions = mergePermissions(options.permissions);
    const encryptMetadata = options.encryptMetadata ?? true;
    const fileKey = randomBytes(algorithm === 'AES-128' ? 16 : 32);
    const algo: EncryptionAlgorithm = algorithm;

    const cmsBlobs: Uint8Array[] = [];
    for (const r of recipients) {
      cmsBlobs.push(await buildRecipientCms(r.certificateDer, fileKey, algorithm));
    }

    const cf = new PDFDict();
    const defCF = new PDFDict();
    defCF.set('CFM', new PDFName(algorithm === 'AES-128' ? 'AESV2' : 'AESV3'));
    defCF.set('Length', new PDFNumber(algorithm === 'AES-128' ? 16 : 32));
    defCF.set('AuthEvent', new PDFName('DocOpen'));
    cf.set('DefaultCryptFilter', defCF);

    const recipientsArr = new PDFArray(cmsBlobs.map((b) => bytesToPdfHex(b)));
    const encryptDict = new PDFDict();
    encryptDict.set('Filter', new PDFName('Adobe.PubSec'));
    encryptDict.set('SubFilter', new PDFName('adbe.pkcs7.s5'));
    encryptDict.set('V', new PDFNumber(algorithm === 'AES-128' ? 4 : 5));
    encryptDict.set('Length', new PDFNumber(algorithm === 'AES-128' ? 128 : 256));
    encryptDict.set('Recipients', recipientsArr);
    encryptDict.set('CF', cf);
    encryptDict.set('StmF', new PDFName('DefaultCryptFilter'));
    encryptDict.set('StrF', new PDFName('DefaultCryptFilter'));
    encryptDict.set('EFF', new PDFName('DefaultCryptFilter'));
    encryptDict.set('EncryptMetadata', new PDFBoolean(encryptMetadata));
    encryptDict.set('P', new PDFNumber(serializePermissions(permissions, 6)));

    ensureFileId(doc.xref.trailerDict);

    const objNum = getNextObjNum(doc);
    const encryptRef = new PDFRef(objNum, 0);
    doc.objects.set(encryptRef.toKey(), encryptDict);
    doc.xref.trailerDict.set('Encrypt', encryptRef);

    const parsed = parseEncryptDict(encryptDict);
    parsed.ref = encryptRef;
    // Ensure crypt filter map has DefaultCryptFilter for shouldEncryptStream
    if (!parsed.cryptFilters.has('DefaultCryptFilter')) {
      parsed.cryptFilters.set('DefaultCryptFilter', {
        name: 'DefaultCryptFilter',
        method: algorithm === 'AES-128' ? 'AESV2' : 'AESV3',
      });
    }
    parsed.stmF = 'DefaultCryptFilter';
    parsed.strF = 'DefaultCryptFilter';

    for (const [key, obj] of doc.objects.entries()) {
      if (key === encryptRef.toKey()) continue;
      const parts = key.split('_');
      const on = parseInt(parts[0], 10);
      const gn = parseInt(parts[1], 10);

      if (obj instanceof PDFStream) {
        const type = obj.dict.getName('Type');
        const subtype = obj.dict.getName('Subtype');
        if (!shouldEncryptStream(parsed, { type, subtype })) continue;
        const okey = computeObjectKey(fileKey, on, gn, algo);
        const cipher = await encryptBytes(obj.rawBytes, okey, algo);
        obj.rawBytes = cipher;
        obj.decodedBytes = null;
        obj.dict.set('Length', new PDFNumber(cipher.length));
      } else if (shouldEncryptString(parsed) && obj instanceof PDFDict) {
        await encryptDictStrings(obj, fileKey, on, gn, algo);
      }
    }

    if (algorithm === 'AES-256' && parseFloat(doc.version) < 1.7) doc.version = '1.7';
    return doc;
  }

  async openWithPrivateKey(
    doc: PDFDocumentData,
    privateKey: CryptoKey,
    _certificateDer?: Uint8Array,
  ): Promise<SecurityOpenResult> {
    const encryptObj = doc.xref.trailerDict.get('Encrypt');
    if (!encryptObj) throw new Error('Document is not encrypted');
    const dict =
      encryptObj instanceof PDFRef ? doc.objects.get(encryptObj.toKey()) : encryptObj;
    if (!(dict instanceof PDFDict)) throw new Error('Invalid Encrypt dictionary');

    const enc = parseEncryptDict(dict);
    const rec = dict.getArray('Recipients');
    if (!rec || rec.length === 0) throw new Error('No recipients in Encrypt dictionary');

    let fileKey: Uint8Array | null = null;
    for (let i = 0; i < rec.length; i++) {
      const cms = asBytes(rec.get(i));
      fileKey = await unwrapFileKeyFromCms(cms, privateKey);
      if (fileKey) break;
    }
    if (!fileKey) {
      throw new Error('Private key does not match any recipient');
    }

    let algorithm: EncryptionAlgorithm = 'AES-256';
    const cfm = enc.cryptFilters.get('DefaultCryptFilter')?.method
      ?? enc.cryptFilters.get(enc.stmF)?.method;
    if (cfm === 'AESV2') algorithm = 'AES-128';
    else if (cfm === 'AESV3') algorithm = 'AES-256';

    const ctx = {
      encrypt: enc,
      fileId: parseFileId(doc.xref.trailerDict),
      fileKey,
      isOwner: true,
      algorithm,
    };

    await decryptDocumentObjects(doc, ctx);
    const rawPerms = permissionEngine.fromEncryptDict(enc);
    const permissions = permissionEngine.effectivePermissions(rawPerms, true);

    return { doc, context: ctx, permissions, role: 'owner' };
  }

  async describeCertificate(der: Uint8Array): Promise<string> {
    try {
      const info = await parseCertificateDer(der);
      return info.subject.commonName ?? info.serialNumberHex;
    } catch {
      return 'Unknown certificate';
    }
  }
}

async function encryptDictStrings(
  dict: PDFDict,
  fileKey: Uint8Array,
  objNum: number,
  genNum: number,
  algorithm: EncryptionAlgorithm,
): Promise<void> {
  for (const [k, v] of [...dict.entries()]) {
    if (v instanceof PDFString || v instanceof PDFHexString) {
      const key = computeObjectKey(fileKey, objNum, genNum, algorithm);
      const cipher = await encryptBytes(v.toBytes(), key, algorithm);
      dict.set(k, bytesToPdfHex(cipher));
    } else if (v instanceof PDFDict) {
      await encryptDictStrings(v, fileKey, objNum, genNum, algorithm);
    } else if (v instanceof PDFArray) {
      for (let i = 0; i < v.items.length; i++) {
        const item = v.items[i];
        if (item instanceof PDFString || item instanceof PDFHexString) {
          const key = computeObjectKey(fileKey, objNum, genNum, algorithm);
          const cipher = await encryptBytes(item.toBytes(), key, algorithm);
          v.items[i] = bytesToPdfHex(cipher);
        }
      }
    }
  }
}

export const publicKeyEncryptionEngine = new PublicKeyEncryptionEngine();
