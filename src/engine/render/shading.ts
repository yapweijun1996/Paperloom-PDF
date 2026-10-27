/**
 * Gradient Shading — Phase 1
 *
 * Axial and radial shadings per ISO 32000-1 §8.9.
 */

export interface ShadingColor {
  offset: number;
  components: number[];
}

export interface AxialShading {
  type: 'axial';
  coords: [number, number, number, number];
  domain: [number, number];
  colors: ShadingColor[];
}

export interface RadialShading {
  type: 'radial';
  coords: [number, number, number, number, number, number];
  domain: [number, number];
  colors: ShadingColor[];
}

export type Shading = AxialShading | RadialShading;

/** Interpolate shading color at parameter t ∈ [0,1]. */
export function interpolateShading(shading: Shading, t: number): number[] {
  const colors = shading.colors;
  if (colors.length === 0) return [0, 0, 0];
  if (colors.length === 1) return [...colors[0].components];

  const clamped = Math.max(shading.domain[0], Math.min(shading.domain[1], t));
  const norm = shading.domain[1] - shading.domain[0];
  const param = norm > 0 ? (clamped - shading.domain[0]) / norm : 0;

  for (let i = 0; i < colors.length - 1; i++) {
    const c0 = colors[i];
    const c1 = colors[i + 1];
    if (param >= c0.offset && param <= c1.offset) {
      const range = c1.offset - c0.offset;
      const local = range > 0 ? (param - c0.offset) / range : 0;
      const out: number[] = [];
      const len = Math.max(c0.components.length, c1.components.length);
      for (let c = 0; c < len; c++) {
        out.push((c0.components[c] ?? 0) * (1 - local) + (c1.components[c] ?? 0) * local);
      }
      return out;
    }
  }

  return [...colors[colors.length - 1].components];
}

/** Map point (x,y) to axial shading parameter. */
export function axialParameter(
  coords: [number, number, number, number],
  x: number,
  y: number,
): number {
  const [x0, y0, x1, y1] = coords;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-10) return 0;
  return ((x - x0) * dx + (y - y0) * dy) / lenSq;
}
