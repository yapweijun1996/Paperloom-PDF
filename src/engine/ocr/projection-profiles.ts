/**
 * Layout detection via projection profiles and deskew angle estimation.
 *
 * Classical document analysis used by Tesseract preprocessing and Acrobat
 * OCR pipelines before neural recognition.
 */

import type {
  DeskewOptions,
  DeskewResult,
  GrayscaleImage,
  LayoutRegion,
  PageLayout,
  ProjectionOptions,
  ProjectionProfile,
} from './types';
import { DEFAULT_DESKEW_OPTIONS, DEFAULT_PROJECTION_OPTIONS } from './types';

// ─── Projection profiles ────────────────────────────────────────────────────

function isInk(pixel: number, threshold: number): boolean {
  return pixel < threshold;
}

/**
 * Sum inverted ink along rows (horizontal profile) or columns (vertical).
 * Horizontal profile[i] = total ink in row i — used to find text bands.
 */
export function computeHorizontalProjection(
  image: GrayscaleImage,
  threshold = DEFAULT_PROJECTION_OPTIONS.inkThreshold,
): ProjectionProfile {
  const { width, height, data } = image;
  const values = new Float64Array(height);

  for (let y = 0; y < height; y++) {
    let sum = 0;
    const rowOff = y * width;
    for (let x = 0; x < width; x++) {
      if (isInk(data[rowOff + x]!, threshold)) sum += 255 - data[rowOff + x]!;
    }
    values[y] = sum;
  }

  return { axis: 'horizontal', values, length: height };
}

/** Vertical profile[j] = total ink in column j — used for column detection. */
export function computeVerticalProjection(
  image: GrayscaleImage,
  threshold = DEFAULT_PROJECTION_OPTIONS.inkThreshold,
): ProjectionProfile {
  const { width, height, data } = image;
  const values = new Float64Array(width);

  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = 0; y < height; y++) {
      const px = data[y * width + x]!;
      if (isInk(px, threshold)) sum += 255 - px;
    }
    values[x] = sum;
  }

  return { axis: 'vertical', values, length: width };
}

// ─── Layout region detection ────────────────────────────────────────────────

interface Interval {
  start: number;
  end: number;
}

function findValleys(
  profile: ProjectionProfile,
  minGap: number,
  maxInk: number,
): Interval[] {
  const intervals: Interval[] = [];
  let start = -1;

  for (let i = 0; i < profile.length; i++) {
    const low = profile.values[i]! <= maxInk;
    if (low && start < 0) start = i;
    if (!low && start >= 0) {
      if (i - start >= minGap) intervals.push({ start, end: i });
      start = -1;
    }
  }
  if (start >= 0 && profile.length - start >= minGap) {
    intervals.push({ start, end: profile.length });
  }
  return intervals;
}

function regionInkDensity(
  image: GrayscaleImage,
  x: number,
  y: number,
  w: number,
  h: number,
  threshold: number,
): number {
  let ink = 0;
  let total = 0;
  const x1 = Math.min(image.width, x + w);
  const y1 = Math.min(image.height, y + h);
  for (let row = y; row < y1; row++) {
    for (let col = x; col < x1; col++) {
      total++;
      if (isInk(image.data[row * image.width + col]!, threshold)) ink++;
    }
  }
  return total > 0 ? ink / total : 0;
}

let regionIdCounter = 0;

/**
 * Detect text blocks by horizontal valleys (line gaps) then split columns
 * via vertical valleys within each band.
 */
export function detectLayoutRegions(
  image: GrayscaleImage,
  options: Partial<ProjectionOptions> = {},
): LayoutRegion[] {
  const opts = { ...DEFAULT_PROJECTION_OPTIONS, ...options };
  const hProj = computeHorizontalProjection(image, opts.inkThreshold);
  const vProj = computeVerticalProjection(image, opts.inkThreshold);

  const maxRowInk = Math.max(...Array.from(hProj.values)) * 0.05;
  const maxColInk = Math.max(...Array.from(vProj.values)) * 0.05;

  const rowBands = findValleys(hProj, opts.minGap, maxRowInk);
  const regions: LayoutRegion[] = [];

  for (const band of rowBands) {
    const colBands = findValleys(vProj, opts.minGap, maxColInk);
    for (const col of colBands) {
      const w = col.end - col.start;
      const h = band.end - band.start;
      if (w * h < opts.minRegionArea) continue;

      const density = regionInkDensity(
        image, col.start, band.start, w, h, opts.inkThreshold,
      );
      if (density < 0.01) continue;

      const kind: LayoutRegion['kind'] =
        w < image.width * 0.15 ? 'column' :
        h < image.height * 0.05 ? 'margin' :
        density > 0.35 ? 'figure' : 'text-block';

      regions.push({
        id: `region_${++regionIdCounter}`,
        x: col.start,
        y: band.start,
        width: w,
        height: h,
        kind,
        inkDensity: density,
      });
    }
  }

  return regions;
}

// ─── Deskew via projection variance ─────────────────────────────────────────

function rotateSample(
  image: GrayscaleImage,
  angleDeg: number,
): GrayscaleImage {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const { width, height } = image;
  const cx = width / 2;
  const cy = height / 2;
  const out = new Uint8Array(width * height);
  out.fill(255);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.round(cos * (x - cx) + sin * (y - cy) + cx);
      const sy = Math.round(-sin * (x - cx) + cos * (y - cy) + cy);
      if (sx >= 0 && sx < width && sy >= 0 && sy < height) {
        out[y * width + x] = image.data[sy * width + sx]!;
      }
    }
  }

  return { width, height, data: out, dpi: image.dpi };
}

/** Score = variance of horizontal projection — sharp text lines minimize variance derivative peaks. */
function projectionScore(profile: ProjectionProfile): number {
  const v = profile.values;
  if (v.length < 2) return Infinity;
  let mean = 0;
  for (let i = 0; i < v.length; i++) mean += v[i]!;
  mean /= v.length;
  let variance = 0;
  for (let i = 0; i < v.length; i++) {
    const d = v[i]! - mean;
    variance += d * d;
  }
  return variance / v.length;
}

/**
 * Estimate deskew angle by minimizing horizontal projection variance
 * over a coarse grid, then refining locally.
 */
export function detectDeskewAngle(
  image: GrayscaleImage,
  options: Partial<DeskewOptions> = {},
): DeskewResult {
  const opts = { ...DEFAULT_DESKEW_OPTIONS, ...options };
  const samples: Array<{ angle: number; score: number }> = [];

  let bestAngle = 0;
  let bestScore = Infinity;

  for (let a = -opts.searchRange; a <= opts.searchRange; a += opts.step) {
    const rotated = rotateSample(image, a);
    const profile = computeHorizontalProjection(rotated);
    const score = projectionScore(profile);
    samples.push({ angle: a, score });
    if (score < bestScore) {
      bestScore = score;
      bestAngle = a;
    }
  }

  const refineLo = bestAngle - opts.step;
  const refineHi = bestAngle + opts.step;
  for (let a = refineLo; a <= refineHi; a += opts.refineStep) {
    const rotated = rotateSample(image, a);
    const profile = computeHorizontalProjection(rotated);
    const score = projectionScore(profile);
    samples.push({ angle: a, score });
    if (score < bestScore) {
      bestScore = score;
      bestAngle = a;
    }
  }

  return { angle: -bestAngle, score: bestScore, samples };
}

/** Full page layout: deskew + region detection on corrected raster. */
export function analyzePageLayout(
  image: GrayscaleImage,
  projectionOpts?: Partial<ProjectionOptions>,
  deskewOpts?: Partial<DeskewOptions>,
): PageLayout {
  const deskew = detectDeskewAngle(image, deskewOpts);
  const corrected = rotateSample(image, deskew.angle);
  const regions = detectLayoutRegions(corrected, projectionOpts);
  const columns = regions.filter(r => r.kind === 'column' || r.kind === 'text-block').length;

  const confidence = Math.min(1, regions.length > 0 ? 0.5 + regions.length * 0.05 : 0.2);

  return {
    regions,
    columnCount: Math.max(1, Math.min(columns, 3)),
    skewAngle: deskew.angle,
    confidence,
  };
}

/** Reset region ID counter (for deterministic tests). */
export function resetRegionIdCounter(): void {
  regionIdCounter = 0;
}
