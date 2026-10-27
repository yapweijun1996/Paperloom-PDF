/**
 * AES-128/256 CBC for PDF encryption (AESV2 / AESV3).
 * Prefers Web Crypto for padded ops; pure AES for no-pad (R5/R6).
 */

import { randomBytes } from './bytes';
import {
  aesCbcDecryptNoPad,
  aesCbcEncryptNoPad,
  aesEcbEncryptBlockSync,
} from './aes-raw';

async function subtleAes(
  direction: 'encrypt' | 'decrypt',
  keyBytes: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const algo = { name: 'AES-CBC', iv: iv as BufferSource };
    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      keyBytes as BufferSource,
      { name: 'AES-CBC' },
      false,
      [direction],
    );
    if (direction === 'encrypt') {
      const result = await globalThis.crypto.subtle.encrypt(algo, key, data as BufferSource);
      return new Uint8Array(result);
    }
    const result = await globalThis.crypto.subtle.decrypt(algo, key, data as BufferSource);
    return new Uint8Array(result);
  }

  const { createCipheriv, createDecipheriv } = await import('crypto');
  const name = keyBytes.length === 16 ? 'aes-128-cbc' : 'aes-256-cbc';
  if (direction === 'encrypt') {
    const cipher = createCipheriv(name, Buffer.from(keyBytes), Buffer.from(iv));
    const enc = Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]);
    return new Uint8Array(enc);
  }
  const decipher = createDecipheriv(name, Buffer.from(keyBytes), Buffer.from(iv));
  const dec = Buffer.concat([decipher.update(Buffer.from(data)), decipher.final()]);
  return new Uint8Array(dec);
}

/**
 * Encrypt with random IV prepended (PDF AES stream/string format).
 */
export async function aesEncryptCbc(
  key: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const iv = randomBytes(16);
  const ciphertext = await subtleAes('encrypt', key, iv, plaintext);
  const out = new Uint8Array(16 + ciphertext.length);
  out.set(iv, 0);
  out.set(ciphertext, 16);
  return out;
}

/**
 * Decrypt PDF AES data (IV || ciphertext).
 */
export async function aesDecryptCbc(
  key: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  if (data.length < 16) return new Uint8Array(0);
  const iv = data.subarray(0, 16);
  const ciphertext = data.subarray(16);
  if (ciphertext.length === 0) return new Uint8Array(0);
  return subtleAes('decrypt', key, iv, ciphertext);
}

/**
 * Raw AES-CBC encrypt (optional PKCS#7). No-pad path uses pure AES (browser-safe).
 */
export async function aesEncryptRaw(
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array,
  pad = true,
): Promise<Uint8Array> {
  if (!pad) {
    return aesCbcEncryptNoPad(key, iv, data);
  }
  return subtleAes('encrypt', key, iv, data);
}

/**
 * Raw AES-CBC decrypt.
 */
export async function aesDecryptRaw(
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array,
  unpad = true,
): Promise<Uint8Array> {
  if (!unpad) {
    return aesCbcDecryptNoPad(key, iv, data);
  }
  return subtleAes('decrypt', key, iv, data);
}

/** AES-256 ECB single-block encrypt (R6 Perms). */
export async function aesEcbEncryptBlock(key: Uint8Array, block: Uint8Array): Promise<Uint8Array> {
  return aesEcbEncryptBlockSync(key, block);
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const copy = new Uint8Array(data);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', copy);
    return new Uint8Array(digest);
  }
  const { createHash } = await import('crypto');
  return new Uint8Array(createHash('sha256').update(data).digest());
}

export async function sha384(data: Uint8Array): Promise<Uint8Array> {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const copy = new Uint8Array(data);
    const digest = await globalThis.crypto.subtle.digest('SHA-384', copy);
    return new Uint8Array(digest);
  }
  const { createHash } = await import('crypto');
  return new Uint8Array(createHash('sha384').update(data).digest());
}

export async function sha512(data: Uint8Array): Promise<Uint8Array> {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const copy = new Uint8Array(data);
    const digest = await globalThis.crypto.subtle.digest('SHA-512', copy);
    return new Uint8Array(digest);
  }
  const { createHash } = await import('crypto');
  return new Uint8Array(createHash('sha512').update(data).digest());
}
