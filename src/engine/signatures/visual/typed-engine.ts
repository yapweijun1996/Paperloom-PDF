/**
 * Typed signature engine — render a name with script fonts to a transparent PNG.
 */

import { TYPED_SIGNATURE_FONTS } from './visual-types';

export interface TypedSignatureOptions {
  text: string;
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  padding?: number;
}

export interface TypedSignatureResult {
  imageDataUrl: string;
  width: number;
  height: number;
  text: string;
  fontFamily: string;
  color: string;
  fontSize: number;
}

export function listTypedSignatureFonts(): readonly string[] {
  return TYPED_SIGNATURE_FONTS;
}

/**
 * Measure and rasterize typed text onto a transparent canvas.
 * Requires a DOM (browser / happy-dom).
 */
export function renderTypedSignature(opts: TypedSignatureOptions): TypedSignatureResult {
  const text = (opts.text || '').trim() || 'Signature';
  const fontFamily = opts.fontFamily ?? TYPED_SIGNATURE_FONTS[0];
  const fontSize = opts.fontSize ?? 48;
  const color = opts.color ?? '#1a1a2e';
  const padding = opts.padding ?? 16;

  const measure = document.createElement('canvas');
  const mctx = measure.getContext('2d');
  if (!mctx) {
    throw new Error('Canvas 2D unavailable');
  }
  mctx.font = `${fontSize}px ${fontFamily}`;
  const metrics = mctx.measureText(text);
  const textW = Math.ceil(metrics.width);
  const ascent = metrics.actualBoundingBoxAscent || fontSize * 0.8;
  const descent = metrics.actualBoundingBoxDescent || fontSize * 0.2;
  const textH = Math.ceil(ascent + descent);

  const width = Math.max(32, textW + padding * 2);
  const height = Math.max(24, textH + padding * 2);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable');

  ctx.clearRect(0, 0, width, height);
  ctx.font = `${fontSize}px ${fontFamily}`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, padding, padding + ascent);

  return {
    imageDataUrl: canvas.toDataURL('image/png'),
    width,
    height,
    text,
    fontFamily,
    color,
    fontSize,
  };
}

/** SVG markup for a typed signature (vector). */
export function typedSignatureToSVG(opts: TypedSignatureOptions): string {
  const text = (opts.text || '').trim() || 'Signature';
  const fontFamily = opts.fontFamily ?? TYPED_SIGNATURE_FONTS[0];
  const fontSize = opts.fontSize ?? 48;
  const color = opts.color ?? '#1a1a2e';
  const padding = opts.padding ?? 16;
  const approxW = Math.ceil(text.length * fontSize * 0.55) + padding * 2;
  const approxH = Math.ceil(fontSize * 1.4) + padding * 2;
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${approxW}" height="${approxH}" viewBox="0 0 ${approxW} ${approxH}">`,
    `<text x="${padding}" y="${padding + fontSize * 0.85}" font-family="${fontFamily}" font-size="${fontSize}" fill="${color}">${escaped}</text>`,
    `</svg>`,
  ].join('');
}
