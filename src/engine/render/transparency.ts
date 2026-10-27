/**
 * Transparency & Blend Modes — ISO 32000-1 §11
 *
 * Porter-Duff compositing for canvas. Maps PDF blend mode names to
 * CanvasRenderingContext2D globalCompositeOperation where supported.
 */

export type PDFBlendMode =
  | 'Normal' | 'Multiply' | 'Screen' | 'Overlay' | 'Darken' | 'Lighten'
  | 'ColorDodge' | 'ColorBurn' | 'HardLight' | 'SoftLight' | 'Difference'
  | 'Exclusion' | 'Hue' | 'Saturation' | 'Color' | 'Luminosity';

const BLEND_TO_CANVAS: Record<string, GlobalCompositeOperation> = {
  Normal: 'source-over',
  Multiply: 'multiply',
  Screen: 'screen',
  Overlay: 'overlay',
  Darken: 'darken',
  Lighten: 'lighten',
  ColorDodge: 'color-dodge',
  ColorBurn: 'color-burn',
  HardLight: 'hard-light',
  SoftLight: 'soft-light',
  Difference: 'difference',
  Exclusion: 'exclusion',
  Hue: 'hue',
  Saturation: 'saturation',
  Color: 'color',
  Luminosity: 'luminosity',
};

export function toCanvasBlendMode(pdfMode: string): GlobalCompositeOperation {
  return BLEND_TO_CANVAS[pdfMode] ?? 'source-over';
}

export interface AlphaState {
  fillAlpha: number;
  strokeAlpha: number;
  blendMode: GlobalCompositeOperation;
}

export function applyAlphaState(
  ctx: CanvasRenderingContext2D,
  fillAlpha: number,
  strokeAlpha: number,
  blendMode: string,
  paintingFill: boolean,
): void {
  ctx.globalCompositeOperation = toCanvasBlendMode(blendMode);
  ctx.globalAlpha = paintingFill ? fillAlpha : strokeAlpha;
}

/** Porter-Duff "over" — standard alpha compositing. */
export function compositeOver(
  src: [number, number, number, number],
  dst: [number, number, number, number],
): [number, number, number, number] {
  const sa = src[3];
  const da = dst[3];
  const outA = sa + da * (1 - sa);
  if (outA < 1e-6) return [0, 0, 0, 0];

  const f = (s: number, d: number) => (s * sa + d * da * (1 - sa)) / outA;
  return [f(src[0], dst[0]), f(src[1], dst[1]), f(src[2], dst[2]), outA];
}
