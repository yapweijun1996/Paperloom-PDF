/**
 * Phase 8 — Signature finalizer.
 *
 * Process:
 * 1. Reserve Contents placeholder (already in Sig dict)
 * 2. Serialize / incremental-append PDF
 * 3. Calculate ByteRange
 * 4. Patch ByteRange, hash all bytes except Contents
 * 5. Generate CMS
 * 6. Inject signature
 * 7. Validate offsets
 */

import type { PDFDocumentData, PDFRef } from '../../types';
import type { HashAlgorithm } from './hash-engine';
import type { SignatureAlgorithmKind } from './cms-builder';
import {
  buildDetachedCMSAdvanced,
  getSignedAttributesForSigning,
} from './cms-builder';
import {
  calculateByteRange,
  hashExcludedContents,
  makeContentsPlaceholder,
  validateByteRange,
  DEFAULT_CONTENTS_SIZE,
  type ByteRange,
  type ByteRangeCalculation,
} from './byterange';
import { injectSignature } from './signature-injector';
import { derInteger, derSequence } from './cms-builder';

export interface FinalizeSignatureInput {
  /** PDF bytes after serialize/incremental write (with Contents placeholder). */
  pdfBytes: Uint8Array;
  privateKey: CryptoKey;
  hashAlgorithm?: HashAlgorithm;
  contentsSize?: number;
  certificateDer?: Uint8Array;
  includeSigningTime?: boolean;
  signingTime?: Date;
  /** Request RFC 3161 timestamp (graceful fallback if TSA unavailable). */
  enableTimestamp?: boolean;
  tsaUrl?: string;
  timestampFallbackUrls?: string[];
}

export interface FinalizeSignatureResult {
  bytes: Uint8Array;
  byteRange: ByteRange;
  calculation: ByteRangeCalculation;
  messageDigest: Uint8Array;
  messageDigestHex: string;
  hashAlgorithm: HashAlgorithm;
  signatureAlgorithm: SignatureAlgorithmKind;
  cms: Uint8Array;
  validation: { ok: boolean; errors: string[] };
  byteRangePatched: boolean;
  timestampApplied: boolean;
  timestampError?: string;
}

function detectSignatureKind(key: CryptoKey): SignatureAlgorithmKind {
  const name = (key.algorithm as { name?: string }).name ?? '';
  if (name.includes('ECDSA') || name.includes('ECDH')) return 'ECDSA';
  return 'RSA';
}

function ecdsaP1363ToDER(sig: Uint8Array): Uint8Array {
  const half = sig.length / 2;
  const r = sig.subarray(0, half);
  const s = sig.subarray(half);
  return new Uint8Array(derSequence([...derInteger(r), ...derInteger(s)]));
}

async function signWithKey(
  privateKey: CryptoKey,
  data: Uint8Array,
  hashAlgorithm: HashAlgorithm,
): Promise<{ signature: Uint8Array; kind: SignatureAlgorithmKind }> {
  const kind = detectSignatureKind(privateKey);
  const hashName =
    hashAlgorithm === 'sha512'
      ? 'SHA-512'
      : hashAlgorithm === 'sha384'
        ? 'SHA-384'
        : 'SHA-256';

  const copy = new Uint8Array(data.byteLength);
  copy.set(data);

  if (kind === 'ECDSA') {
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: hashName }, privateKey, copy),
    );
    return { signature: ecdsaP1363ToDER(raw), kind };
  }

  const algoName = (privateKey.algorithm as { name?: string }).name ?? '';
  if (algoName === 'RSA-PSS') {
    const raw = await crypto.subtle.sign(
      {
        name: 'RSA-PSS',
        saltLength:
          hashAlgorithm === 'sha512' ? 64 : hashAlgorithm === 'sha384' ? 48 : 32,
      },
      privateKey,
      copy,
    );
    return { signature: new Uint8Array(raw), kind };
  }

  const raw = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    privateKey,
    copy,
  );
  return { signature: new Uint8Array(raw), kind };
}

/**
 * Finalize a reserved Contents placeholder into a cryptographically valid signature.
 * Mutates a copy of pdfBytes (returns new buffer).
 */
export async function finalizePdfSignature(
  input: FinalizeSignatureInput,
): Promise<FinalizeSignatureResult> {
  const hashAlgorithm = input.hashAlgorithm ?? 'sha256';
  const contentsSize = input.contentsSize ?? DEFAULT_CONTENTS_SIZE;
  const placeholderHex = makeContentsPlaceholder(contentsSize);
  const pdfBytes = new Uint8Array(input.pdfBytes); // copy so we can patch safely

  // 3. Calculate byte ranges
  const calculation = calculateByteRange(pdfBytes, placeholderHex);
  const { byteRange, contentsSpan } = calculation;

  // Patch ByteRange BEFORE hashing (values live in the hashed region)
  // Temporary: inject empty CMS later; first patch range with inject helper partially
  const searchFrom = Math.max(0, contentsSpan.start - 800);
  const { patchByteRangeInPlace } = await import('./signature-injector');
  let byteRangePatched = patchByteRangeInPlace(pdfBytes, byteRange, searchFrom);
  if (!byteRangePatched) {
    byteRangePatched = patchByteRangeInPlace(pdfBytes, byteRange, 0);
  }

  // 4. Hash all bytes except Contents
  const { digest: messageDigest, digestHex } = await hashExcludedContents(
    pdfBytes,
    byteRange,
    hashAlgorithm,
  );

  // 5. Generate CMS signature
  const signingTime = input.signingTime ?? new Date();
  const signedAttrs = getSignedAttributesForSigning({
    messageDigest,
    includeSigningTime: input.includeSigningTime !== false,
    signingTime,
  });
  const { signature, kind } = await signWithKey(
    input.privateKey,
    signedAttrs,
    hashAlgorithm,
  );

  // Phase 11 — optional RFC 3161 timestamp over signatureValue
  let timestampToken: Uint8Array | undefined;
  let timestampApplied = false;
  let timestampError: string | undefined;
  if (input.enableTimestamp) {
    try {
      const { requestTimestamp } = await import('../timestamp/timestamp-client');
      const ts = await requestTimestamp({
        data: signature,
        hashAlgorithm,
        tsaUrl: input.tsaUrl,
        fallbackUrls: input.timestampFallbackUrls,
      });
      if (ts.ok && ts.token) {
        timestampToken = ts.token.der;
        timestampApplied = true;
      } else {
        timestampError = ts.error;
      }
    } catch (e) {
      timestampError = e instanceof Error ? e.message : String(e);
    }
  }

  const cms = buildDetachedCMSAdvanced({
    messageDigest,
    signatureValue: signature,
    hashAlgorithm,
    signatureAlgorithm: kind,
    certificateDer: input.certificateDer,
    includeSigningTime: input.includeSigningTime !== false,
    signingTime,
    timestampToken,
  });

  // 6. Insert signature (Contents only — ByteRange already patched)
  const { injectSignatureContents } = await import('./signature-injector');
  injectSignatureContents(pdfBytes, contentsSpan, cms);

  // 7. Validate offsets
  const validation = validateByteRange(pdfBytes, byteRange, contentsSpan);

  return {
    bytes: pdfBytes,
    byteRange,
    calculation,
    messageDigest,
    messageDigestHex: digestHex,
    hashAlgorithm,
    signatureAlgorithm: kind,
    cms,
    validation,
    byteRangePatched,
    timestampApplied,
    timestampError,
  };
}

/**
 * Convenience: finalize and attach result metadata for pipeline callers.
 */
export async function finalizeSignatureOnDocument(
  doc: PDFDocumentData,
  pdfBytes: Uint8Array,
  privateKey: CryptoKey,
  opts: Omit<FinalizeSignatureInput, 'pdfBytes' | 'privateKey'> & {
    fieldRef?: PDFRef;
    sigRef?: PDFRef;
  } = {},
): Promise<FinalizeSignatureResult> {
  const result = await finalizePdfSignature({
    pdfBytes,
    privateKey,
    ...opts,
  });
  doc.rawBytes = result.bytes;
  return result;
}
