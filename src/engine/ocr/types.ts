/**
 * OCR preprocessing types — grayscale buffers, projection profiles,
 * layout regions, and deskew results.
 *
 * Phase 7 focuses on classical layout/deskew (no ML recognition yet).
 */

/** Single-channel 8-bit grayscale raster. */
export interface GrayscaleImage {
  width: number;
  height: number;
  /** Row-major pixels, 0 = black, 255 = white. */
  data: Uint8Array;
  /** Pixels per inch when known (affects angle math). */
  dpi: number;
}

/** Horizontal or vertical ink projection (sum of inverted intensity per row/col). */
export interface ProjectionProfile {
  axis: 'horizontal' | 'vertical';
  /** One value per row (horizontal) or column (vertical). */
  values: Float64Array;
  length: number;
}

/** Axis-aligned layout region from projection valley detection. */
export interface LayoutRegion {
  id: string;
  /** Bounding box in image coordinates (origin top-left). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Estimated region class from geometry heuristics. */
  kind: 'text-block' | 'column' | 'margin' | 'figure';
  /** Mean ink density 0–1 within region. */
  inkDensity: number;
}

/** Detected page layout from projection analysis. */
export interface PageLayout {
  regions: LayoutRegion[];
  columnCount: number;
  /** Estimated text angle in degrees (0 = horizontal). */
  skewAngle: number;
  /** Confidence 0–1 for layout detection. */
  confidence: number;
}

/** Deskew estimation result. */
export interface DeskewResult {
  /** Optimal rotation in degrees (counter-clockwise to deskew). */
  angle: number;
  /** Projection variance at optimal angle (lower = straighter). */
  score: number;
  /** Angles sampled during search. */
  samples: Array<{ angle: number; score: number }>;
}

export interface ProjectionOptions {
  /** Invert threshold: pixels darker than this contribute ink (0–255). */
  inkThreshold: number;
  /** Minimum gap width (px) to split layout regions. */
  minGap: number;
  /** Minimum region area (px²) to keep. */
  minRegionArea: number;
}

export const DEFAULT_PROJECTION_OPTIONS: ProjectionOptions = {
  inkThreshold: 200,
  minGap: 8,
  minRegionArea: 400,
};

export interface DeskewOptions {
  /** Search range ±degrees around 0. */
  searchRange: number;
  /** Step size in degrees. */
  step: number;
  /** Fine refinement step after coarse pass. */
  refineStep: number;
}

export const DEFAULT_DESKEW_OPTIONS: DeskewOptions = {
  searchRange: 15,
  step: 1,
  refineStep: 0.25,
};
