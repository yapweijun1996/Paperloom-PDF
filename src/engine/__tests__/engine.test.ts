import { describe, it, expect } from 'vitest';
import { multiplyMatrices, identityMatrix, transformPoint } from '../render/graphics-state';
import { shouldUseFlowDraw } from '../flow/justification-detect';
import type { TextLine } from '../flow/types';
import { QuadTree, hitTestSpatial } from '../editing/spatial-index';
import { TransactionStack } from '../editing/transactions';
import { parseICCProfile } from '../color/icc-profile';

describe('graphics-state', () => {
  it('identity transform preserves points', () => {
    const m = identityMatrix();
    expect(transformPoint(m, 10, 20)).toEqual([10, 20]);
  });

  it('multiplies translation correctly', () => {
    const t1 = { a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 };
    const t2 = { a: 1, b: 0, c: 0, d: 1, e: 5, f: 5 };
    const r = multiplyMatrices(t1, t2);
    expect(transformPoint(r, 0, 0)).toEqual([15, 25]);
  });
});

describe('justification-detect', () => {
  it('rejects tab-aligned lines', () => {
    const line: TextLine = {
      id: 't1',
      runs: [],
      text: 'University Name2022 - 2026',
      segments: [],
      baseline: 700,
      x: 72, y: 690, width: 460, height: 14,
      leftMargin: 72, rightEdge: 532,
      fontSize: 11,
      isJustified: false,
      tabSplitIndex: 0,
    };
    expect(shouldUseFlowDraw(line)).toBe(false);
  });
});

describe('spatial-index', () => {
  it('hit tests topmost entry', () => {
    const tree = new QuadTree<string>({ x: 0, y: 0, width: 600, height: 800 });
    tree.insert({ id: 'a', bounds: { x: 10, y: 10, width: 100, height: 20 }, data: 'first' });
    tree.insert({ id: 'b', bounds: { x: 10, y: 10, width: 100, height: 20 }, data: 'second' });
    const hit = hitTestSpatial(tree, 50, 15);
    expect(hit?.data).toBe('second');
  });
});

describe('transactions', () => {
  it('undo/redo roundtrip', () => {
    const stack = new TransactionStack();
    stack.push({ pageIndex: 0, contentBytes: new Uint8Array([1]), label: 'a', timestamp: 1 });
    stack.push({ pageIndex: 0, contentBytes: new Uint8Array([2]), label: 'b', timestamp: 2 });
    const prev = stack.undo();
    expect(prev?.contentBytes[0]).toBe(1);
    const next = stack.redo();
    expect(next?.contentBytes[0]).toBe(2);
  });
});

describe('icc-profile', () => {
  it('returns null for short data', () => {
    expect(parseICCProfile(new Uint8Array(10))).toBeNull();
  });
});
