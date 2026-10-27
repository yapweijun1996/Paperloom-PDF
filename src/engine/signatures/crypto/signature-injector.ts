/**
 * Phase 8 — Signature injector.
 * Patches /ByteRange in place and fills /Contents hex with CMS bytes.
 */

import { bytesToHex } from './hash-engine';
import {
  padByteRangeNumber,
  type ByteRange,
  type ContentsSpan,
} from './byterange';

function binaryToLatin1(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    s += String.fromCharCode.apply(null, Array.from(slice) as unknown as number[]);
  }
  return s;
}

function writeLatin1(bytes: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    bytes[offset + i] = text.charCodeAt(i) & 0xff;
  }
}

/**
 * Patch `/ByteRange [...]` preserving the original bracket span length
 * so subsequent Contents offsets stay valid.
 */
export function patchByteRangeInPlace(
  pdfBytes: Uint8Array,
  byteRange: ByteRange,
  searchFrom = 0,
): boolean {
  const text = binaryToLatin1(pdfBytes);
  const re = /\/ByteRange\s*\[([^\]]*)\]/g;
  re.lastIndex = searchFrom;
  const match = re.exec(text);
  if (!match || match.index == null) return false;

  const full = match[0];
  const openIdx = full.indexOf('[');
  const closeIdx = full.lastIndexOf(']');
  if (openIdx < 0 || closeIdx < 0) return false;

  const innerWidth = closeIdx - openIdx - 1;
  const compact = `${byteRange[0]} ${byteRange[1]} ${byteRange[2]} ${byteRange[3]}`;
  const paddedNums = `${padByteRangeNumber(byteRange[0])} ${padByteRangeNumber(byteRange[1])} ${padByteRangeNumber(byteRange[2])} ${padByteRangeNumber(byteRange[3])}`;

  let inner: string;
  if (paddedNums.length === innerWidth) {
    inner = paddedNums;
  } else if (paddedNums.length < innerWidth) {
    inner = paddedNums + ' '.repeat(innerWidth - paddedNums.length);
  } else if (compact.length <= innerWidth) {
    inner = compact + ' '.repeat(innerWidth - compact.length);
  } else {
    return false;
  }

  const exact = full.slice(0, openIdx + 1) + inner + full.slice(closeIdx);
  if (exact.length !== full.length) return false;
  writeLatin1(pdfBytes, match.index, exact);
  return true;
}

/**
 * Write CMS into Contents hex span (zero-padded to capacity).
 * Mutates pdfBytes in place — does not shift offsets.
 */
export function injectSignatureContents(
  pdfBytes: Uint8Array,
  span: ContentsSpan,
  cms: Uint8Array,
): void {
  const capacity = span.hexEnd - span.hexStart;
  const cmsHex = bytesToHex(cms);
  if (cmsHex.length > capacity) {
    throw new Error(
      `CMS hex length ${cmsHex.length} exceeds Contents capacity ${capacity} ` +
        `(reserve larger contentsSize)`,
    );
  }
  const padded = cmsHex + '0'.repeat(capacity - cmsHex.length);
  writeLatin1(pdfBytes, span.hexStart, padded);
}

/** @deprecated alias */
export const fillContentsHex = (
  pdfBytes: Uint8Array,
  hexStart: number,
  hexEnd: number,
  cms: Uint8Array,
): void => {
  injectSignatureContents(pdfBytes, {
    start: hexStart - 1,
    end: hexEnd + 1,
    hexStart,
    hexEnd,
  }, cms);
};

/**
 * Inject ByteRange + CMS after calculation.
 * Order: patch ByteRange first (inside hashed region), then fill Contents (excluded).
 */
export function injectSignature(
  pdfBytes: Uint8Array,
  opts: {
    byteRange: ByteRange;
    contentsSpan: ContentsSpan;
    cms: Uint8Array;
    /** Search start for /ByteRange (typically near Contents). */
    byteRangeSearchFrom?: number;
  },
): { byteRangePatched: boolean } {
  const searchFrom =
    opts.byteRangeSearchFrom ?? Math.max(0, opts.contentsSpan.start - 800);
  let byteRangePatched = patchByteRangeInPlace(
    pdfBytes,
    opts.byteRange,
    searchFrom,
  );
  if (!byteRangePatched) {
    byteRangePatched = patchByteRangeInPlace(pdfBytes, opts.byteRange, 0);
  }
  injectSignatureContents(pdfBytes, opts.contentsSpan, opts.cms);
  return { byteRangePatched };
}
