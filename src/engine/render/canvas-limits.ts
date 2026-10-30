/** Canvas surfaces and their RGBA copies must be bounded before allocation. */
export const MAX_CANVAS_DIMENSION = 32_767;
export const MAX_CANVAS_PIXELS = 32_000_000;

export class CanvasDimensionError extends Error {
  constructor() {
    super('Canvas dimensions or scale exceed the supported limit or are invalid');
    this.name = 'CanvasDimensionError';
  }
}

/** Round positive device dimensions and reject oversized/invalid surfaces. */
export function checkedCanvasDimensions(width: number, height: number): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new CanvasDimensionError();
  }
  const roundedWidth = Math.ceil(width);
  const roundedHeight = Math.ceil(height);
  if (!Number.isSafeInteger(roundedWidth) || !Number.isSafeInteger(roundedHeight) ||
      roundedWidth > MAX_CANVAS_DIMENSION || roundedHeight > MAX_CANVAS_DIMENSION ||
      roundedWidth * roundedHeight > MAX_CANVAS_PIXELS) {
    throw new CanvasDimensionError();
  }
  return { width: roundedWidth, height: roundedHeight };
}

export function assertCanvasScale(scale: number): void {
  if (!Number.isFinite(scale) || scale <= 0) throw new CanvasDimensionError();
}
