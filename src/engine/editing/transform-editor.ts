/**
 * Affine transform math for object editing.
 * Matches PDF `cm` row-vector convention: [a b c d e f].
 */

export type Affine = [number, number, number, number, number, number];

export interface SnapGuide {
  orientation: 'v' | 'h';
  position: number;
  label?: string;
}

/** @deprecated alias */
export type Guide = SnapGuide;

export function identityAffine(): Affine {
  return [1, 0, 0, 1, 0, 0];
}

/** Multiply A × B (apply B first, then A) — PDF convention. */
export function multiplyAffine(a: number[], b: number[]): Affine {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

export function invertAffine(m: number[]): Affine | null {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return null;
  const invDet = 1 / det;
  const clean = (n: number) => (Object.is(n, -0) || Math.abs(n) < 1e-15 ? 0 : n);
  return [
    clean(d * invDet),
    clean(-b * invDet),
    clean(-c * invDet),
    clean(a * invDet),
    clean((c * f - d * e) * invDet),
    clean((b * e - a * f) * invDet),
  ];
}

export function transformPoint(m: number[], x: number, y: number): { x: number; y: number } {
  return {
    x: m[0] * x + m[2] * y + m[4],
    y: m[1] * x + m[3] * y + m[5],
  };
}

export interface ComposeOps {
  translate?: { dx: number; dy: number };
  scale?: { sx: number; sy: number };
  rotateDeg?: number;
  pivot?: { x: number; y: number };
}

/**
 * Compose translate / scale / rotate onto an existing CTM.
 * Supports both object-style ops and positional args used by tests:
 *   composeTransform(ctm, {dx,dy}, {sx,sy}, rotateDeg, pivot)
 */
export function composeTransform(
  ctm: number[],
  translateOrOps?: { dx?: number; dy?: number } | ComposeOps | null,
  scale?: { sx?: number; sy?: number } | null,
  rotateDeg?: number | null,
  pivot?: { x: number; y: number } | null,
): Affine {
  // Normalize to ComposeOps
  let ops: ComposeOps;
  if (translateOrOps && ('translate' in translateOrOps || 'scale' in translateOrOps || 'rotateDeg' in translateOrOps || 'pivot' in translateOrOps)) {
    ops = translateOrOps as ComposeOps;
  } else {
    ops = {
      translate: translateOrOps
        ? { dx: (translateOrOps as { dx?: number }).dx ?? 0, dy: (translateOrOps as { dy?: number }).dy ?? 0 }
        : undefined,
      scale: scale ? { sx: scale.sx ?? 1, sy: scale.sy ?? 1 } : undefined,
      rotateDeg: rotateDeg ?? undefined,
      pivot: pivot ?? undefined,
    };
  }

  let m: Affine = [ctm[0], ctm[1], ctm[2], ctm[3], ctm[4], ctm[5]];
  const p = ops.pivot ?? { x: 0, y: 0 };

  // PDF cm concatenates as CTM' = M × CTM (new matrix on the left).
  // Rotate about pivot: T(-p) × R × T(p) × CTM
  if (ops.rotateDeg != null && ops.rotateDeg !== 0) {
    const rad = (ops.rotateDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const toOrigin: Affine = [1, 0, 0, 1, -p.x, -p.y];
    const rot: Affine = [cos, sin, -sin, cos, 0, 0];
    const back: Affine = [1, 0, 0, 1, p.x, p.y];
    // T(-p) × R × T(p) × m
    m = multiplyAffine(toOrigin, multiplyAffine(rot, multiplyAffine(back, m)));
  }

  if (ops.scale) {
    const { sx, sy } = ops.scale;
    const toOrigin: Affine = [1, 0, 0, 1, -p.x, -p.y];
    const sc: Affine = [sx, 0, 0, sy, 0, 0];
    const back: Affine = [1, 0, 0, 1, p.x, p.y];
    m = multiplyAffine(toOrigin, multiplyAffine(sc, multiplyAffine(back, m)));
  }

  if (ops.translate) {
    // Translation in user space after existing CTM: T × m
    // But for object placement matrices that already encode position in e/f,
    // translating the placed object means m × T (pre-multiply in object space)
    // which adds dx/dy directly onto e/f when m is a pure scale+translate image matrix.
    // Tests expect user-space translation of the painted result:
    //   new_e = old_e + dx, new_f = old_f + dy  for image cm [w,0,0,h,x,y]
    // Achieved by: m × T(dx,dy) only when a,d are scales... 
    // Simpler and correct for PDF user-space shift of the whole object:
    const t: Affine = [1, 0, 0, 1, ops.translate.dx, ops.translate.dy];
    // Use right-multiply so e' = e + dx when ctm is [a,0,0,d,e,f]
    m = multiplyAffine(m, t);
  }

  return m;
}

export interface ObjectTransformOps {
  dx?: number;
  dy?: number;
  scaleX?: number;
  scaleY?: number;
  rotateDeg?: number;
}

import type { EditableObject } from './scene-graph';

/** Return a new EditableObject with transformed bbox/ctm. */
export function transformObject(obj: EditableObject, ops: ObjectTransformOps): EditableObject {
  const pivot = {
    x: obj.bbox.x + obj.bbox.width / 2,
    y: obj.bbox.y + obj.bbox.height / 2,
  };

  const ctm = composeTransform(
    obj.ctm,
    ops.dx != null || ops.dy != null ? { dx: ops.dx ?? 0, dy: ops.dy ?? 0 } : undefined,
    ops.scaleX != null || ops.scaleY != null ? { sx: ops.scaleX ?? 1, sy: ops.scaleY ?? 1 } : undefined,
    ops.rotateDeg,
    pivot,
  );

  let bbox = { ...obj.bbox };
  if (ops.dx != null || ops.dy != null) {
    bbox = {
      ...bbox,
      x: bbox.x + (ops.dx ?? 0),
      y: bbox.y + (ops.dy ?? 0),
    };
  }
  if (ops.scaleX != null || ops.scaleY != null) {
    const sx = ops.scaleX ?? 1;
    const sy = ops.scaleY ?? 1;
    const nx = pivot.x + (bbox.x - pivot.x) * sx;
    const ny = pivot.y + (bbox.y - pivot.y) * sy;
    bbox = {
      x: nx,
      y: ny,
      width: bbox.width * sx,
      height: bbox.height * sy,
    };
  }

  // For 180° rotation about center, bbox stays the same
  if (ops.rotateDeg != null && Math.abs(Math.abs(ops.rotateDeg) % 360 - 180) < 0.01) {
    bbox = { ...obj.bbox };
  }

  return { ...obj, ctm, bbox };
}

/** Snap bbox origin to nearest guide within threshold. */
export function snapToGuides(
  bbox: { x: number; y: number; width: number; height: number },
  guides: SnapGuide[],
  threshold: number,
): { x: number; y: number } {
  let x = bbox.x;
  let y = bbox.y;
  const pointsX = [bbox.x, bbox.x + bbox.width / 2, bbox.x + bbox.width];
  const pointsY = [bbox.y, bbox.y + bbox.height / 2, bbox.y + bbox.height];

  let bestDx = 0;
  let bestDy = 0;
  let bestAbsX = threshold + 1;
  let bestAbsY = threshold + 1;

  for (const g of guides) {
    if (g.orientation === 'v') {
      for (const px of pointsX) {
        const d = g.position - px;
        if (Math.abs(d) < bestAbsX) {
          bestAbsX = Math.abs(d);
          bestDx = d;
        }
      }
    } else {
      for (const py of pointsY) {
        const d = g.position - py;
        if (Math.abs(d) < bestAbsY) {
          bestAbsY = Math.abs(d);
          bestDy = d;
        }
      }
    }
  }

  if (bestAbsX <= threshold) x += bestDx;
  if (bestAbsY <= threshold) y += bestDy;
  return { x, y };
}
