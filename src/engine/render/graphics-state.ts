/**
 * Graphics State Stack — ISO 32000-1 §8.4
 *
 * Manages CTM, line art, color, text, and clipping state via q/Q operators.
 * Complexity: push O(1), pop O(1), multiply O(1). Memory: O(d) for stack depth d.
 */

export interface Matrix {
  a: number; b: number;
  c: number; d: number;
  e: number; f: number;
}

export interface ClipPathNode {
  segments: Array<{ type: 'M' | 'L' | 'C' | 'Z'; points: number[] }>;
  windingRule: 'nonzero' | 'evenodd';
}

export interface GraphicsState {
  ctm: Matrix;
  fillColor: [number, number, number];
  strokeColor: [number, number, number];
  fillAlpha: number;
  strokeAlpha: number;
  blendMode: string;
  softMask: unknown | null;
  lineWidth: number;
  lineCap: number;
  lineJoin: number;
  miterLimit: number;
  dashPattern: number[];
  dashPhase: number;
  clipPaths: ClipPathNode[];
}

export function identityMatrix(): Matrix {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

/** 2×3 affine composition: M_result = M1 × M2 (PDF convention). */
export function multiplyMatrices(m1: Matrix, m2: Matrix): Matrix {
  return {
    a: m1.a * m2.a + m1.b * m2.c,
    b: m1.a * m2.b + m1.b * m2.d,
    c: m1.c * m2.a + m1.d * m2.c,
    d: m1.c * m2.b + m1.d * m2.d,
    e: m1.e * m2.a + m1.f * m2.c + m2.e,
    f: m1.e * m2.b + m1.f * m2.d + m2.f,
  };
}

export function transformPoint(m: Matrix, x: number, y: number): [number, number] {
  return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}

export function defaultGraphicsState(): GraphicsState {
  return {
    ctm: identityMatrix(),
    fillColor: [0, 0, 0],
    strokeColor: [0, 0, 0],
    fillAlpha: 1,
    strokeAlpha: 1,
    blendMode: 'Normal',
    softMask: null,
    lineWidth: 1,
    lineCap: 0,
    lineJoin: 0,
    miterLimit: 10,
    dashPattern: [],
    dashPhase: 0,
    clipPaths: [],
  };
}

export function cloneGraphicsState(gs: GraphicsState): GraphicsState {
  return {
    ...gs,
    ctm: { ...gs.ctm },
    fillColor: [...gs.fillColor] as [number, number, number],
    strokeColor: [...gs.strokeColor] as [number, number, number],
    dashPattern: [...gs.dashPattern],
    clipPaths: gs.clipPaths.map(p => ({
      segments: p.segments.map(s => ({ type: s.type, points: [...s.points] })),
      windingRule: p.windingRule,
    })),
  };
}

/** LIFO graphics state stack (q/Q). Max depth guard prevents stack overflow attacks. */
export class GraphicsStateStack {
  private stack: GraphicsState[] = [];
  private current: GraphicsState;
  private readonly maxDepth: number;

  constructor(maxDepth = 256) {
    this.maxDepth = maxDepth;
    this.current = defaultGraphicsState();
  }

  get state(): GraphicsState {
    return this.current;
  }

  push(): void {
    if (this.stack.length >= this.maxDepth) {
      throw new Error(`Graphics state stack overflow (max ${this.maxDepth})`);
    }
    this.stack.push(cloneGraphicsState(this.current));
  }

  pop(): void {
    const prev = this.stack.pop();
    if (!prev) return;
    this.current = prev;
  }

  setState(gs: GraphicsState): void {
    this.current = gs;
  }

  multiplyCTM(m: Matrix): void {
    this.current.ctm = multiplyMatrices(this.current.ctm, m);
  }

  depth(): number {
    return this.stack.length;
  }
}
