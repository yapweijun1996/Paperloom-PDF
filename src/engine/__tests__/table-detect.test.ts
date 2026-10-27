/**
 * Column / table split tests for multi-cell PDF rows.
 */

import { describe, it, expect } from 'vitest';
import { detectColumnSplitIndices } from '../flow/justification-detect';
import { reconstructLines, resetLineIdCounter } from '../flow/line-reconstruction';
import { detectTablesOnPage } from '../flow/table-detect';
import type { TextRun, GlyphPosition } from '../content/interpreter';
import { identityMatrix } from '../render/graphics-state';

function glyph(ch: string, x: number, fontSize = 12): GlyphPosition {
  const w = fontSize * 0.5;
  return {
    charCode: ch.charCodeAt(0),
    unicode: ch,
    x,
    y: 700,
    width: w,
    fontSize,
    textSpaceWidth: 0.5,
    tRm: { a: fontSize, b: 0, c: 0, d: fontSize, e: x, f: 700 },
  };
}

function run(text: string, fontName: string, fontSize: number, startX: number, y = 700): TextRun {
  const glyphs = [...text].map((ch, i) => {
    const g = glyph(ch, startX + i * fontSize * 0.5, fontSize);
    g.y = y;
    g.tRm.f = y;
    return g;
  });
  return {
    type: 'text',
    text,
    glyphs,
    x: startX,
    y,
    width: text.length * fontSize * 0.5,
    height: fontSize,
    fontName,
    fontSize,
    textMatrix: identityMatrix(),
    fillColor: [0, 0, 0],
    fillAlpha: 1,
    blendMode: 'Normal',
    softMask: null,
    clipPaths: [],
  };
}

describe('detectColumnSplitIndices', () => {
  it('splits a 4-column table row with equal gutters', () => {
    // Course | Year | Institution | Remarks — large equal gaps
    const runs = [
      run('CA Final', 'F1', 11, 50),
      run('May 2025', 'F1', 11, 160),
      run('ICAI', 'F1', 11, 280),
      run('Scored exemption', 'F1', 11, 380),
    ];
    const splits = detectColumnSplitIndices(runs, 11);
    expect(splits.length).toBe(3);
    expect(splits).toEqual([0, 1, 2]);
  });

  it('does not split normal word-spaced body text', () => {
    const runs = [
      run('Hello ', 'F1', 12, 50),
      run('world ', 'F1', 12, 86),
      run('today', 'F1', 12, 122),
    ];
    expect(detectColumnSplitIndices(runs, 12)).toEqual([]);
  });
});

describe('reconstructLines table cells', () => {
  it('emits one TextLine per table cell', () => {
    resetLineIdCounter();
    const runs = [
      run('CA Final', 'F1', 11, 50, 700),
      run('May 2025', 'F1', 11, 160, 700),
      run('ICAI', 'F1', 11, 280, 700),
      run('Remark', 'F1', 11, 380, 700),
      run('CA Inter', 'F1', 11, 50, 680),
      run('Jan 2021', 'F1', 11, 160, 680),
      run('ICAI', 'F1', 11, 280, 680),
      run('Group 2', 'F1', 11, 380, 680),
    ];
    const lines = reconstructLines(runs);
    expect(lines.length).toBe(8);
    expect(lines.filter(l => l.text === 'CA Final').length).toBe(1);
    expect(lines.filter(l => l.text === 'May 2025').length).toBe(1);

    const tables = detectTablesOnPage(lines, []);
    expect(tables.length).toBeGreaterThanOrEqual(1);
    expect(tables[0].cols).toBe(4);
    expect(tables[0].rows).toBe(2);
  });
});
