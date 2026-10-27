/**
 * CMS EnvelopedData helpers for Adobe.PubSec (Phase 6).
 * Builds/parses recipient-encrypted content-encryption keys — NOT signatures.
 */

import {
  derInteger,
  derLength,
  derObjectIdentifier,
  derOctetString,
  derSequence,
  derSet,
} from '../../signatures/crypto/cms-builder';
import { extractSpkiFromCertificate } from '../../signatures/validation/validation-engine';
import { parseDERNode } from '../../signatures/crypto/signature-verify';
import { randomBytes } from '../crypto/bytes';

const OID_PKCS7_DATA = [1, 2, 840, 113549, 1, 7, 1];
const OID_PKCS7_ENVELOPED = [1, 2, 840, 113549, 1, 7, 3];
const OID_RSA_ENCRYPTION = [1, 2, 840, 113549, 1, 1, 1];
const OID_AES256_CBC = [2, 16, 840, 1, 101, 3, 4, 1, 42];
const OID_AES128_CBC = [2, 16, 840, 1, 101, 3, 4, 1, 2];

function derNull(): number[] {
  return [0x05, 0x00];
}

function derContext(tag: number, contents: number[]): number[] {
  return [0xa0 | tag, ...derLength(contents.length), ...contents];
}

function derBitStringUnused0(bytes: Uint8Array): number[] {
  return [0x03, ...derLength(bytes.length + 1), 0x00, ...Array.from(bytes)];
}

async function importRsaPublicKey(certDer: Uint8Array): Promise<CryptoKey> {
  const spki = extractSpkiFromCertificate(certDer);
  if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
    throw new Error('WebCrypto required for public-key encryption');
  }
  try {
    return await globalThis.crypto.subtle.importKey(
      'spki',
      spki as BufferSource,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['encrypt'],
    );
  } catch {
    // Fallback: PKCS#1 v1.5 encrypt
    return globalThis.crypto.subtle.importKey(
      'spki',
      spki as BufferSource,
      { name: 'RSA-PKCS1-v1_5' } as AlgorithmIdentifier,
      false,
      ['encrypt'],
    );
  }
}

async function rsaEncryptKey(publicKey: CryptoKey, fileKey: Uint8Array): Promise<Uint8Array> {
  try {
    const enc = await globalThis.crypto.subtle.encrypt(
      { name: 'RSA-OAEP' },
      publicKey,
      fileKey as BufferSource,
    );
    return new Uint8Array(enc);
  } catch {
    const enc = await globalThis.crypto.subtle.encrypt(
      { name: 'RSA-PKCS1-v1_5' } as AlgorithmIdentifier,
      publicKey,
      fileKey as BufferSource,
    );
    return new Uint8Array(enc);
  }
}

/**
 * Build a minimal CMS EnvelopedData ContentInfo wrapping `fileKey` for one cert.
 * Structure is Adobe.PubSec-compatible enough for Bloom round-trips.
 */
export async function buildRecipientCms(
  certificateDer: Uint8Array,
  fileKey: Uint8Array,
  algorithm: 'AES-128' | 'AES-256' = 'AES-256',
): Promise<Uint8Array> {
  const publicKey = await importRsaPublicKey(certificateDer);
  const encryptedKey = await rsaEncryptKey(publicKey, fileKey);
  const iv = randomBytes(16);
  const contentEncOid = algorithm === 'AES-128' ? OID_AES128_CBC : OID_AES256_CBC;

  // IssuerAndSerialNumber — use serial from cert when possible; else dummy
  const serial = extractSerial(certificateDer) ?? new Uint8Array([0x01]);
  const issuer = extractIssuerDer(certificateDer) ?? derSequence([]);

  const rid = derSequence([...issuer, ...derInteger(serial)]);
  const keyEncAlgo = derSequence([...derObjectIdentifier(OID_RSA_ENCRYPTION), ...derNull()]);
  const recipientInfo = derSequence([
    ...derInteger(0), // version
    ...rid,
    ...keyEncAlgo,
    ...derOctetString(encryptedKey),
  ]);

  const contentEncAlgo = derSequence([
    ...derObjectIdentifier(contentEncOid),
    ...derOctetString(iv),
  ]);

  // EncryptedContentInfo with empty encrypted content (key transport only —
  // PDF encrypts streams separately with the file key).
  const encryptedContentInfo = derSequence([
    ...derObjectIdentifier(OID_PKCS7_DATA),
    ...contentEncAlgo,
    // [0] IMPLICIT OCTET STRING empty
    0x80, 0x00,
  ]);

  const enveloped = derSequence([
    ...derInteger(0),
    ...derSet(recipientInfo),
    ...encryptedContentInfo,
  ]);

  const contentInfo = derSequence([
    ...derObjectIdentifier(OID_PKCS7_ENVELOPED),
    ...derContext(0, enveloped),
  ]);

  return new Uint8Array(contentInfo);
}

function extractSerial(certDer: Uint8Array): Uint8Array | null {
  try {
    const root = parseDERNode(certDer, 0);
    const tbs = root.children?.[0];
    if (!tbs?.children) return null;
    let idx = 0;
    if (tbs.children[0]?.class === 'context') idx = 1;
    const serial = tbs.children[idx];
    return serial?.content ?? null;
  } catch {
    return null;
  }
}

function extractIssuerDer(certDer: Uint8Array): number[] | null {
  try {
    const root = parseDERNode(certDer, 0);
    const tbs = root.children?.[0];
    if (!tbs?.children || tbs.offset == null) return null;
    let idx = 0;
    if (tbs.children[0]?.class === 'context') idx = 1;
    idx += 2; // serial, signature → issuer
    const issuer = tbs.children[idx];
    if (!issuer || issuer.offset == null || issuer.length == null) return null;
    return Array.from(certDer.subarray(issuer.offset, issuer.offset + issuer.length));
  } catch {
    return null;
  }
}

/**
 * Unwrap file key from a CMS EnvelopedData blob using a private key.
 */
export async function unwrapFileKeyFromCms(
  cmsBytes: Uint8Array,
  privateKey: CryptoKey,
): Promise<Uint8Array | null> {
  try {
    const root = parseDERNode(cmsBytes, 0);
    // ContentInfo → [0] EnvelopedData → RecipientInfos SET → RecipientInfo → encryptedKey
    const enveloped = root.children?.find((c) => c.class === 'context') ?? root.children?.[1];
    const envSeq = enveloped?.children?.[0] ?? enveloped;
    const recipientSet = envSeq?.children?.find((c) => c.tag === 0x31) ?? envSeq?.children?.[1];
    const ri = recipientSet?.children?.[0];
    const encryptedKeyNode = ri?.children?.[ri.children.length - 1];
    if (!encryptedKeyNode) return null;
    const encryptedKey = encryptedKeyNode.content;

    try {
      const plain = await globalThis.crypto.subtle.decrypt(
        { name: 'RSA-OAEP' },
        privateKey,
        encryptedKey as BufferSource,
      );
      return new Uint8Array(plain);
    } catch {
      const plain = await globalThis.crypto.subtle.decrypt(
        { name: 'RSA-PKCS1-v1_5' } as AlgorithmIdentifier,
        privateKey,
        encryptedKey as BufferSource,
      );
      return new Uint8Array(plain);
    }
  } catch {
    return null;
  }
}

export function describeCmsRecipient(cmsBytes: Uint8Array): {
  serialNumberHex?: string;
} {
  try {
    const root = parseDERNode(cmsBytes, 0);
    const enveloped = root.children?.find((c) => c.class === 'context') ?? root.children?.[1];
    const envSeq = enveloped?.children?.[0] ?? enveloped;
    const recipientSet = envSeq?.children?.find((c) => c.tag === 0x31) ?? envSeq?.children?.[1];
    const ri = recipientSet?.children?.[0];
    const rid = ri?.children?.[1];
    const serial = rid?.children?.[1]?.content;
    if (!serial) return {};
    return {
      serialNumberHex: Array.from(serial)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(''),
    };
  } catch {
    return {};
  }
}

void derBitStringUnused0;
