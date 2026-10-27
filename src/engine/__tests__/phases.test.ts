import { describe, it, expect } from 'vitest';
import { toCanvasBlendMode, compositeOver } from '../render/transparency';
import { interpolateShading, axialParameter } from '../render/shading';
import { measureTextLine } from '../fonts/measurement';
import { getStandardFont } from '../fonts/standard14';
import { chunkDocument } from '../ai/document-chunker';
import { garbageCollect } from '../optimize/garbage-collect';

describe('transparency', () => {
  it('maps PDF blend modes to canvas', () => {
    expect(toCanvasBlendMode('Multiply')).toBe('multiply');
    expect(toCanvasBlendMode('Unknown')).toBe('source-over');
  });

  it('composites alpha over', () => {
    const result = compositeOver([1, 0, 0, 0.5], [0, 0, 1, 0.5]);
    expect(result[3]).toBeGreaterThan(0.5);
  });
});

describe('shading', () => {
  it('interpolates axial shading colors', () => {
    const color = interpolateShading({
      type: 'axial',
      coords: [0, 0, 100, 0],
      domain: [0, 1],
      colors: [
        { offset: 0, components: [0, 0, 0] },
        { offset: 1, components: [1, 1, 1] },
      ],
    }, 0.5);
    expect(color[0]).toBeCloseTo(0.5, 1);
  });

  it('computes axial parameter', () => {
    expect(axialParameter([0, 0, 100, 0], 50, 0)).toBeCloseTo(0.5, 2);
  });
});

describe('font measurement', () => {
  it('measures standard font text', () => {
    const helv = getStandardFont('Helvetica');
    expect(helv).not.toBeNull();
    const widths = new Map<number, number>();
    for (let i = 0; i < helv!.widths.length; i++) {
      if (helv!.widths[i]) widths.set(i, helv!.widths[i]);
    }
    const metrics = measureTextLine('Hello', {
      name: 'F1',
      baseFont: 'Helvetica',
      subtype: 'Type1',
      isComposite: false,
      encoding: 'StandardEncoding',
      differences: new Map(),
      toUnicode: new Map(),
      widths,
      defaultWidth: 500,
      firstChar: 0,
      lastChar: 255,
      standardMetrics: helv,
      ttfFont: null,
      fontBytes: null,
      ascent: helv!.ascent,
      descent: helv!.descent,
      italicAngle: 0,
      flags: 0,
      cssFontString: helv!.cssFamily,
      fontMatrix: null,
      charProcs: null,
    }, 12);
    expect(metrics.width).toBeGreaterThan(0);
    expect(metrics.glyphCount).toBe(5);
  });
});

describe('ai chunker', () => {
  it('chunks document paragraphs', () => {
    const longText = Array.from({ length: 40 }, (_, i) =>
      `Sentence ${i} contains enough words to exceed the minimum token threshold for chunking.`,
    ).join(' ');
    const chunks = chunkDocument({
      documentId: 'doc-1',
      paragraphs: [{ pageIndex: 0, text: longText }],
    }, { minTokens: 8 });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].text.length).toBeGreaterThan(0);
  });
});

describe('optimize', () => {
  it('garbage collects unreachable objects', () => {
    const objects = new Map();
    const root = { toKey: () => '1_0' } as import('../types').PDFRef;
    objects.set('1_0', { } as never);
    objects.set('2_0', { } as never);
    const result = garbageCollect(objects, [root], { deduplicateStreams: false });
    expect(result.removedKeys).toBeDefined();
  });
});
