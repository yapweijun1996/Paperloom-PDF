/**
 * Phase 8 — ByteRange calculator.
 *
 * PDF signatures exclude the /Contents hex string from the digest:
 *   ByteRange = [0, contentsStart, contentsEnd, fileLength - contentsEnd]
 * where contentsStart/End span the `<` … `>` hex inclusive.
 */

import { bytesToHex, hashByteRanges, type HashAlgorithm } from './hash-engine';

export const BYTERANGE_DIGIT_WIDTH = 10;
export const DEFAULT_CONTENTS_SIZE = 8192;

export type ByteRange = [number, number, number, number];

export interface ContentsSpan {
  /** Index of `<` */
  start: number;
  /** Index after `>` */
  end: number;
  /** First hex digit index */
  hexStart: number;
  /** Index of `>` */
  hexEnd: number;
}

export interface ByteRangeCalculation {
  byteRange: ByteRange;
  contentsSpan: ContentsSpan;
  fileLength: number;
  /** Hex chars reserved for CMS (excluding < >). */
  hexCapacity: number;
  /** Raw CMS byte capacity. */
  contentsCapacity: number;
}

/** Build zero-filled Contents hex of `size` bytes. */
export function makeContentsPlaceholder(size: number): string {
  if (size < 1) throw new Error('Contents placeholder size must be >= 1');
  return '0'.repeat(size * 2);
}

export function padByteRangeNumber(n: number, width = BYTERANGE_DIGIT_WIDTH): string {
  const s = Math.max(0, Math.floor(n)).toString();
  if (s.length > width) {
    throw new Error(`ByteRange value ${n} exceeds ${width} digits`);
  }
  return s.padStart(width, '0');
}

function binaryToLatin1(bytes: Uint8Array): string {
  // Chunk to avoid argument limits on huge PDFs
  const CHUNK = 0x8000;
  if (bytes.length <= CHUNK) {
    return String.fromCharCode.apply(null, Array.from(bytes) as unknown as number[]);
  }
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    s += String.fromCharCode.apply(null, Array.from(slice) as unknown as number[]);
  }
  return s;
}

/**
 * Locate `/Contents <hex>` placeholder.
 * Prefers exact placeholder match; falls back to a long zero-run hex string.
 */
export function findContentsHexSpan(
  pdfBytes: Uint8Array,
  placeholderHex?: string,
): ContentsSpan | null {
  const text = binaryToLatin1(pdfBytes);

  if (placeholderHex) {
    const needle = `<${placeholderHex}>`;
    const idx = text.indexOf(needle);
    if (idx >= 0) {
      return {
        start: idx,
        end: idx + needle.length,
        hexStart: idx + 1,
        hexEnd: idx + 1 + placeholderHex.length,
      };
    }
  }

  // Fallback: longest `<000…0>` near /Contents
  const contentsIdx = text.lastIndexOf('/Contents');
  if (contentsIdx < 0) return null;
  const region = text.slice(contentsIdx, contentsIdx + 64 + (placeholderHex?.length ?? 16384) + 8);
  const m = /<\s*([0-9a-fA-F]{32,})\s*>/.exec(region);
  if (!m || m.index == null) return null;
  const abs = contentsIdx + m.index;
  const hex = m[1].replace(/\s/g, '');
  // Re-find exact `<hex>` without whitespace for span math
  const exact = text.indexOf(`<${hex}>`, contentsIdx);
  if (exact < 0) {
    return {
      start: abs,
      end: abs + m[0].length,
      hexStart: abs + m[0].indexOf(hex[0]),
      hexEnd: abs + m[0].indexOf(hex[0]) + hex.length,
    };
  }
  return {
    start: exact,
    end: exact + hex.length + 2,
    hexStart: exact + 1,
    hexEnd: exact + 1 + hex.length,
  };
}

/** Compute ByteRange that excludes the Contents hex including angle brackets. */
export function computeByteRangeFromContentsSpan(
  fileLength: number,
  contentsStart: number,
  contentsEnd: number,
): ByteRange {
  if (contentsStart < 0 || contentsEnd > fileLength || contentsStart >= contentsEnd) {
    throw new Error(
      `Invalid Contents span [${contentsStart}, ${contentsEnd}) for file length ${fileLength}`,
    );
  }
  return [0, contentsStart, contentsEnd, fileLength - contentsEnd];
}

/**
 * Full ByteRange calculation from PDF bytes + optional placeholder hex.
 */
export function calculateByteRange(
  pdfBytes: Uint8Array,
  placeholderHex?: string,
): ByteRangeCalculation {
  const span = findContentsHexSpan(pdfBytes, placeholderHex);
  if (!span) {
    throw new Error('Could not locate /Contents placeholder for ByteRange calculation');
  }
  const byteRange = computeByteRangeFromContentsSpan(
    pdfBytes.length,
    span.start,
    span.end,
  );
  const hexCapacity = span.hexEnd - span.hexStart;
  return {
    byteRange,
    contentsSpan: span,
    fileLength: pdfBytes.length,
    hexCapacity,
    contentsCapacity: Math.floor(hexCapacity / 2),
  };
}

/** Validate ByteRange offsets against file length and Contents span. */
export function validateByteRange(
  pdfBytes: Uint8Array,
  byteRange: ByteRange,
  contentsSpan?: ContentsSpan,
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const [s1, l1, s2, l2] = byteRange;
  const n = pdfBytes.length;

  if (s1 !== 0) errors.push(`ByteRange[0] should be 0, got ${s1}`);
  if (l1 < 0 || l2 < 0 || s2 < 0) errors.push('ByteRange has negative values');
  if (s1 + l1 > n) errors.push('First range exceeds file length');
  if (s2 + l2 > n) errors.push('Second range exceeds file length');
  if (s1 + l1 !== s2 && contentsSpan && s1 + l1 !== contentsSpan.start) {
    errors.push('Gap start does not match Contents start');
  }
  if (contentsSpan) {
    if (s1 + l1 !== contentsSpan.start) {
      errors.push(
        `Expected first length ${contentsSpan.start}, got ${l1}`,
      );
    }
    if (s2 !== contentsSpan.end) {
      errors.push(`Expected second offset ${contentsSpan.end}, got ${s2}`);
    }
    if (l2 !== n - contentsSpan.end) {
      errors.push(`Expected second length ${n - contentsSpan.end}, got ${l2}`);
    }
    // Gap must cover Contents
    if (contentsSpan.start < s1 + l1 || contentsSpan.end > s2) {
      errors.push('Contents span is not fully excluded by ByteRange gap');
    }
  }
  // Ranges must not overlap and should cover all but the gap
  if (s1 + l1 + (s2 - (s1 + l1)) + l2 !== n && s2 === s1 + l1) {
    // contiguous without gap — invalid for signatures
    errors.push('ByteRange has no gap for Contents');
  }
  if (s1 + l1 !== s2) {
    const gap = s2 - (s1 + l1);
    if (gap < 2) errors.push('Contents gap too small');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Hash ByteRange data. For large PDFs, prefers Node streaming hash when available
 * to avoid a giant intermediate concatenation where possible.
 */
export async function hashExcludedContents(
  pdfBytes: Uint8Array,
  byteRange: ByteRange,
  algorithm: HashAlgorithm = 'sha256',
): Promise<{ digest: Uint8Array; digestHex: string }> {
  const [s1, l1, s2, l2] = byteRange;
  const LARGE = 8 * 1024 * 1024; // 8 MiB

  if (
    typeof process !== 'undefined' &&
    process.versions?.node &&
    pdfBytes.length >= LARGE
  ) {
    const { createHash } = await import('crypto');
    const h = createHash(algorithm);
    // Stream in 1 MiB chunks
    const chunk = 1024 * 1024;
    for (let i = s1; i < s1 + l1; i += chunk) {
      h.update(pdfBytes.subarray(i, Math.min(i + chunk, s1 + l1)));
    }
    for (let i = s2; i < s2 + l2; i += chunk) {
      h.update(pdfBytes.subarray(i, Math.min(i + chunk, s2 + l2)));
    }
    const digest = new Uint8Array(h.digest());
    return { digest, digestHex: bytesToHex(digest) };
  }

  const digest = await hashByteRanges(pdfBytes, byteRange, algorithm);
  return { digest, digestHex: bytesToHex(digest) };
}
