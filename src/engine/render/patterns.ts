/**
 * Tiling pattern color spaces — ISO 32000-1 §8.7
 *
 * Parses pattern dictionaries and builds CanvasPattern fills for colored
 * tiling patterns. Uncolored patterns require current color at paint time.
 */

import { PDFDict, PDFName, PDFNumber, PDFStream, PDFArray, type PDFObject } from '../types';
import { resolveRef } from '../parser/parser';

export type PatternPaintType = 1 | 2; // 1 = colored, 2 = uncolored

export interface TilingPattern {
  paintType: PatternPaintType;
  tilingType: 1 | 2 | 3;
  bbox: [number, number, number, number];
  xStep: number;
  yStep: number;
  matrix: [number, number, number, number, number, number];
  stream: PDFStream;
}

function readMatrix(obj: PDFObject | undefined): [number, number, number, number, number, number] {
  if (!(obj instanceof PDFArray) || obj.length < 6) {
    return [1, 0, 0, 1, 0, 0];
  }
  const n = obj.asNumbers();
  return [n[0] ?? 1, n[1] ?? 0, n[2] ?? 0, n[3] ?? 1, n[4] ?? 0, n[5] ?? 0];
}

/** Parse a tiling pattern stream dictionary (PatternType 1). */
export function parseTilingPattern(
  pattern: PDFObject,
  objects: Map<string, PDFObject>,
): TilingPattern | null {
  const resolved = resolveRef(pattern, objects);
  if (!(resolved instanceof PDFStream)) return null;

  const dict = resolved.dict;
  const patternType = dict.get('PatternType');
  if (!(patternType instanceof PDFNumber) || patternType.value !== 1) return null;

  const paintType = dict.get('PaintType');
  const tilingType = dict.get('TilingType');
  const bboxArr = dict.get('BBox');
  if (!(bboxArr instanceof PDFArray) || bboxArr.length < 4) return null;

  const bboxNums = bboxArr.asNumbers();
  const xStep = dict.get('XStep');
  const yStep = dict.get('YStep');

  return {
    paintType: (paintType instanceof PDFNumber ? paintType.value : 1) as PatternPaintType,
    tilingType: (tilingType instanceof PDFNumber ? tilingType.value : 1) as 1 | 2 | 3,
    bbox: [bboxNums[0] ?? 0, bboxNums[1] ?? 0, bboxNums[2] ?? 0, bboxNums[3] ?? 0],
    xStep: xStep instanceof PDFNumber ? xStep.value : bboxNums[2]! - bboxNums[0]!,
    yStep: yStep instanceof PDFNumber ? yStep.value : bboxNums[3]! - bboxNums[1]!,
    matrix: readMatrix(dict.get('Matrix')),
    stream: resolved,
  };
}

/**
 * Create a repeating canvas pattern from decoded RGBA tile pixels.
 * Caller supplies rasterized pattern tile (from pattern content stream).
 */
export function createCanvasPattern(
  ctx: CanvasRenderingContext2D,
  tileCanvas: HTMLCanvasElement | OffscreenCanvas,
  repetition: 'repeat' | 'repeat-x' | 'repeat-y' | 'no-repeat' = 'repeat',
): CanvasPattern | null {
  try {
    return ctx.createPattern(tileCanvas as unknown as CanvasImageSource, repetition);
  } catch {
    return null;
  }
}

/** Whether a color-space name refers to a pattern. */
export function isPatternColorSpace(name: string): boolean {
  return name === 'Pattern' || name.startsWith('P');
}
