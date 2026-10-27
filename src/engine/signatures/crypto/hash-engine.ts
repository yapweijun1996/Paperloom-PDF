/**
 * Hash engine — SHA-256 / SHA-384 / SHA-512 via Web Crypto (Phase 7).
 */

export type HashAlgorithm = 'sha256' | 'sha384' | 'sha512';

export const HASH_ALGORITHMS: readonly HashAlgorithm[] = ['sha256', 'sha384', 'sha512'] as const;

/** WebCrypto algorithm name. */
export function toSubtleHashName(algo: HashAlgorithm): AlgorithmIdentifier {
  switch (algo) {
    case 'sha384':
      return 'SHA-384';
    case 'sha512':
      return 'SHA-512';
    default:
      return 'SHA-256';
  }
}

/** Digest algorithm OID for CMS AlgorithmIdentifier. */
export function hashAlgorithmOID(algo: HashAlgorithm): number[] {
  switch (algo) {
    case 'sha384':
      return [2, 16, 840, 1, 101, 3, 4, 2, 2];
    case 'sha512':
      return [2, 16, 840, 1, 101, 3, 4, 2, 3];
    default:
      return [2, 16, 840, 1, 101, 3, 4, 2, 1]; // sha256
  }
}

export function hashDigestLength(algo: HashAlgorithm): number {
  switch (algo) {
    case 'sha384':
      return 48;
    case 'sha512':
      return 64;
    default:
      return 32;
  }
}

/**
 * Hash arbitrary bytes with the selected algorithm.
 * Prefers WebCrypto; falls back to Node crypto in non-browser environments.
 */
export async function hashBytes(
  data: Uint8Array,
  algorithm: HashAlgorithm = 'sha256',
): Promise<Uint8Array> {
  const subtleName = toSubtleHashName(algorithm);
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    const digest = await globalThis.crypto.subtle.digest(subtleName, copy);
    return new Uint8Array(digest);
  }
  const { createHash } = await import('crypto');
  return new Uint8Array(createHash(algorithm).update(data).digest());
}

/**
 * Hash concatenated PDF ByteRange segments: bytes[s1..s1+l1) || bytes[s2..s2+l2).
 */
export async function hashByteRanges(
  pdfBytes: Uint8Array,
  byteRange: [number, number, number, number],
  algorithm: HashAlgorithm = 'sha256',
): Promise<Uint8Array> {
  const [s1, l1, s2, l2] = byteRange;
  if (s1 < 0 || l1 < 0 || s2 < 0 || l2 < 0) {
    throw new Error('Invalid ByteRange: negative values');
  }
  if (s1 + l1 > pdfBytes.length || s2 + l2 > pdfBytes.length) {
    throw new Error('Invalid ByteRange: out of bounds');
  }
  const part1 = pdfBytes.subarray(s1, s1 + l1);
  const part2 = pdfBytes.subarray(s2, s2 + l2);
  const total = new Uint8Array(part1.length + part2.length);
  total.set(part1, 0);
  total.set(part2, part1.length);
  return hashBytes(total, algorithm);
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0');
  }
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s/g, '');
  const padded = clean.length % 2 === 1 ? clean + '0' : clean;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(padded.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}
