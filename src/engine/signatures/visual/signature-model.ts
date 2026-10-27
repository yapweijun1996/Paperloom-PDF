/**
 * Visual signature model helpers — create, hit-test, transform.
 */

import type { VisualSignature, SignatureAppearanceType } from './visual-types';
import { DEFAULT_SIGNATURE_SIZE } from './visual-types';

let _sigId = 0;

export function nextSignatureId(prefix = 'sig'): string {
  return `${prefix}-${Date.now().toString(36)}-${++_sigId}`;
}

export function resetSignatureIdCounter(): void {
  _sigId = 0;
}

export interface CreateSignatureOpts {
  pageIndex: number;
  x: number;
  y: number;
  appearanceId: string;
  appearanceType: SignatureAppearanceType;
  width?: number;
  height?: number;
  rotation?: number;
  opacity?: number;
  locked?: boolean;
}

/** Create a new placed signature centered near (x, y) in PDF user space. */
export function createVisualSignature(opts: CreateSignatureOpts): VisualSignature {
  const width = opts.width ?? DEFAULT_SIGNATURE_SIZE.width;
  const height = opts.height ?? DEFAULT_SIGNATURE_SIZE.height;
  return {
    id: nextSignatureId(),
    pageIndex: opts.pageIndex,
    x: opts.x - width / 2,
    y: opts.y - height / 2,
    width,
    height,
    rotation: opts.rotation ?? 0,
    opacity: opts.opacity ?? 1,
    locked: opts.locked ?? false,
    appearanceType: opts.appearanceType,
    appearanceId: opts.appearanceId,
  };
}

export function cloneVisualSignature(sig: VisualSignature, overrides?: Partial<VisualSignature>): VisualSignature {
  return {
    ...sig,
    ...overrides,
    id: overrides?.id ?? nextSignatureId(),
  };
}

/** Axis-aligned bbox hit-test (ignores rotation for selection hit — rotation handled by overlay). */
export function hitTestSignature(
  signatures: VisualSignature[],
  pageIndex: number,
  pdfX: number,
  pdfY: number,
): VisualSignature | null {
  const pageSigs = signatures.filter((s) => s.pageIndex === pageIndex);
  for (let i = pageSigs.length - 1; i >= 0; i--) {
    const s = pageSigs[i];
    if (pointInRotatedRect(pdfX, pdfY, s)) return s;
  }
  return null;
}

function pointInRotatedRect(
  px: number,
  py: number,
  s: VisualSignature,
): boolean {
  const cx = s.x + s.width / 2;
  const cy = s.y + s.height / 2;
  const rad = (-s.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = px - cx;
  const dy = py - cy;
  const localX = dx * cos - dy * sin;
  const localY = dx * sin + dy * cos;
  return (
    localX >= -s.width / 2 &&
    localX <= s.width / 2 &&
    localY >= -s.height / 2 &&
    localY <= s.height / 2
  );
}

export function moveSignature(sig: VisualSignature, dx: number, dy: number): VisualSignature {
  if (sig.locked) return sig;
  return { ...sig, x: sig.x + dx, y: sig.y + dy };
}

export function resizeSignature(
  sig: VisualSignature,
  width: number,
  height: number,
  anchor: 'se' | 'center' = 'se',
): VisualSignature {
  if (sig.locked) return sig;
  const w = Math.max(16, width);
  const h = Math.max(12, height);
  if (anchor === 'center') {
    const cx = sig.x + sig.width / 2;
    const cy = sig.y + sig.height / 2;
    return { ...sig, width: w, height: h, x: cx - w / 2, y: cy - h / 2 };
  }
  // SE: keep top-left (PDF: x fixed, y+height fixed)
  const top = sig.y + sig.height;
  return { ...sig, width: w, height: h, y: top - h };
}

export function rotateSignature(sig: VisualSignature, degrees: number): VisualSignature {
  if (sig.locked) return sig;
  let r = degrees % 360;
  if (r < 0) r += 360;
  return { ...sig, rotation: r };
}

export function setSignatureOpacity(sig: VisualSignature, opacity: number): VisualSignature {
  return { ...sig, opacity: Math.max(0, Math.min(1, opacity)) };
}

export function setSignatureLocked(sig: VisualSignature, locked: boolean): VisualSignature {
  return { ...sig, locked };
}

export function deleteSignature(
  signatures: VisualSignature[],
  id: string,
): VisualSignature[] {
  return signatures.filter((s) => s.id !== id);
}

export function updateSignature(
  signatures: VisualSignature[],
  id: string,
  updater: (s: VisualSignature) => VisualSignature,
): VisualSignature[] {
  return signatures.map((s) => (s.id === id ? updater(s) : s));
}

/** Convert a visual signature to a scene-like bbox for selection UI. */
export function signatureToBBox(sig: VisualSignature): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return { x: sig.x, y: sig.y, width: sig.width, height: sig.height };
}
