/**
 * Stream Recompression — re-encode non-image PDF streams at maximum Flate level.
 *
 * Many PDF generators use fast/low-level deflate. Decompressing and re-compressing
 * with the browser's native CompressionStream at 'deflate' level often produces
 * 5–15% smaller output for text-heavy content streams, metadata, CIDToGIDMap, etc.
 *
 * Image streams (Subtype /Image) are skipped — they are handled by image-compress.
 * DCTDecode (JPEG) and JPXDecode (JPEG2000) streams are also skipped since they
 * are already in lossy compressed formats.
 */

import {
  PDFName,
  PDFNumber,
  PDFStream,
  type PDFObject,
} from '../types';
import { applyFilters } from '../parser/filters';
import { flateEncode } from '../parser/filters';

export interface RecompressResult {
  /** Number of streams that were successfully recompressed smaller */
  streamsRecompressed: number;
  /** Total bytes saved across all recompressed streams */
  bytesSaved: number;
}

/** Filters that are already maximally compressed or lossy — skip these */
const SKIP_FILTERS = new Set([
  'DCTDecode', 'DCT',
  'JPXDecode',
  'JBIG2Decode',
  'CCITTFaxDecode', 'CCF',
  'Crypt',
]);

function isImageStream(obj: PDFObject): boolean {
  return obj instanceof PDFStream && obj.dict.getName('Subtype') === 'Image';
}

function shouldSkip(stream: PDFStream): boolean {
  // Skip image XObjects
  if (stream.dict.getName('Subtype') === 'Image') return true;

  // Skip if any filter in the chain is lossy / non-deflatable
  const filters = stream.getFilters();
  for (const f of filters) {
    if (SKIP_FILTERS.has(f)) return true;
  }

  return false;
}

/**
 * Iterate all streams in the document, decode them, and re-encode with Flate.
 * Replaces streams in-place when the result is smaller.
 */
export async function recompressStreams(
  objects: Map<string, PDFObject>,
): Promise<RecompressResult> {
  let streamsRecompressed = 0;
  let bytesSaved = 0;

  for (const [, obj] of objects) {
    if (!(obj instanceof PDFStream)) continue;
    if (shouldSkip(obj)) continue;

    const originalRaw = obj.rawBytes;
    if (!originalRaw || originalRaw.length === 0) continue;

    const filters = obj.getFilters();

    // Already FlateDecode-only? Try re-encoding to see if we can beat it.
    // Unfiltered? Definitely compress.
    // Multi-filter chains we skip to be safe (e.g. FlateDecode + predictor).
    const isRawFlate = filters.length === 1 && (filters[0] === 'FlateDecode' || filters[0] === 'Fl');
    const isUnfiltered = filters.length === 0;

    if (!isRawFlate && !isUnfiltered) continue;

    try {
      // Get decoded bytes
      let decoded: Uint8Array;
      if (isUnfiltered) {
        decoded = originalRaw;
      } else {
        // Decompress existing flate
        const decodeParams = obj.getDecodeParams();
        // If there are DecodeParms (predictors etc.), skip — re-encoding without
        // the predictor would produce broken output, and re-applying predictors
        // is complex with diminishing returns.
        if (decodeParams.length > 0 && decodeParams[0] != null) continue;
        decoded = await applyFilters(originalRaw, filters, decodeParams);
      }

      if (decoded.length === 0) continue;

      // Re-compress
      const recompressed = await flateEncode(decoded);

      // Only accept if strictly smaller
      if (recompressed.length < originalRaw.length) {
        const saved = originalRaw.length - recompressed.length;
        bytesSaved += saved;
        streamsRecompressed++;

        // Replace in-place
        obj.rawBytes = recompressed;
        obj.decodedBytes = decoded;
        obj.dict.set('Filter', new PDFName('FlateDecode'));
        obj.dict.set('Length', new PDFNumber(recompressed.length));
        obj.dict.delete('DecodeParms');
      }
    } catch {
      // Skip streams that fail to decode — don't break the pipeline
      continue;
    }
  }

  return { streamsRecompressed, bytesSaved };
}
