/**
 * Edit-phase style preservation: bold toggle-off, visual size, segment bounds.
 */

import { describe, it, expect } from 'vitest';
import { resolveStyledFontName } from '../flow/style-edit';
import { distributeTextToSegments, distributeTextChangeToSegments } from '../flow/reflow';
import { computeHorizontalShiftsFromEdits } from '../flow/layout';
import { visualFontSize, fontNameStyleFlags, resolveRunStyleFlags } from '../flow/metrics';
import type { TextLine } from '../flow/types';
import type { TextRun, GlyphPosition } from '../content/interpreter';
import { identityMatrix } from '../render/graphics-state';

function glyph(ch: string, x: number, fontSize = 24): GlyphPosition {
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

function run(text: string, fontName: string, fontSize: number, startX: number): TextRun {
  const glyphs = [...text].map((ch, i) => glyph(ch, startX + i * fontSize * 0.5, fontSize));
  return {
    type: 'text',
    text,
    glyphs,
    x: startX,
    y: 700,
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

describe('resolveStyledFontName', () => {
  it('removes bold from Helvetica-Bold when bold=false', () => {
    expect(resolveStyledFontName('Helvetica-Bold', false, false)).toBe('Helvetica');
  });

  it('adds bold to Helvetica', () => {
    expect(resolveStyledFontName('Helvetica', true, false)).toBe('Helvetica-Bold');
  });

  it('strips subset prefix and bold token', () => {
    expect(resolveStyledFontName('ABCDEF+Montserrat-Bold', false, false)).toMatch(/Montserrat/i);
    expect(resolveStyledFontName('ABCDEF+Montserrat-Bold', false, false)).not.toMatch(/Bold/i);
  });
});

describe('fontNameStyleFlags / visualFontSize', () => {
  it('detects bold and italic from names', () => {
    expect(fontNameStyleFlags('Helvetica-Bold')).toEqual({ bold: true, italic: false });
    expect(fontNameStyleFlags('Times-Italic')).toEqual({ bold: false, italic: true });
  });

  it('resolves style from FontData BaseFont when resource key is opaque', () => {
    expect(resolveRunStyleFlags('F2', { baseFont: 'ABCDEF+Montserrat-Bold' })).toEqual({
      bold: true,
      italic: false,
    });
    expect(resolveRunStyleFlags('F1', { standardMetrics: { isBold: true, isItalic: false } })).toEqual({
      bold: true,
      italic: false,
    });
  });

  it('uses glyph tRm for visual size when Tf is unit-sized', () => {
    const r = run('Hi', 'F1', 1, 100);
    // Override glyphs to simulate 1 Tf + 24 Tm
    r.glyphs = [glyph('H', 100, 24), glyph('i', 112, 24)];
    r.fontSize = 1;
    expect(visualFontSize(r)).toBeCloseTo(24, 0);
  });
});

describe('distributeTextToSegments style preservation', () => {
  it('keeps bold prefix segment when editing the regular middle', () => {
    const bold = run('JSS ', 'FBold', 12, 50);
    const regular = run('Academy', 'FReg', 12, 80);
    const line: TextLine = {
      id: 'l',
      runs: [bold, regular],
      text: 'JSS Academy',
      segments: [
        { run: bold, startIndex: 0, endIndex: 4, text: 'JSS ' },
        { run: regular, startIndex: 4, endIndex: 11, text: 'Academy' },
      ],
      baseline: 700,
      x: 50, y: 688, width: 100, height: 14,
      leftMargin: 50, rightEdge: 150,
      fontSize: 12,
      isJustified: false,
      tabSplitIndex: -1,
    };

    const edits = distributeTextToSegments(line, 'JSS College');
    expect(edits[0].newText).toBe('JSS ');
    expect(edits[1].newText).toBe('College');
  });

  it('keeps typing inside the active segment without stealing words', () => {
    const bold = run('Hello', 'FBold', 12, 50);
    const regular = run(' World', 'FReg', 12, 80);
    const line: TextLine = {
      id: 'l2',
      runs: [bold, regular],
      text: 'Hello World',
      segments: [
        { run: bold, startIndex: 0, endIndex: 5, text: 'Hello' },
        { run: regular, startIndex: 5, endIndex: 11, text: ' World' },
      ],
      baseline: 700,
      x: 50, y: 688, width: 100, height: 14,
      leftMargin: 50, rightEdge: 150,
      fontSize: 12,
      isJustified: false,
      tabSplitIndex: -1,
    };

    const edits = distributeTextChangeToSegments(line, 'Hello World', 'HelloX World', 6);
    expect(edits[0].newText).toBe('HelloX');
    expect(edits[1].newText).toBe(' World');
  });

  it('chain-shifts trailing run when the leading segment grows', () => {
    const bold = run('Hello', 'FBold', 12, 50); // width ~30
    const regular = run(' World', 'FReg', 12, 86); // starts after original "Hello"
    const line: TextLine = {
      id: 'l3',
      runs: [bold, regular],
      text: 'Hello World',
      segments: [
        { run: bold, startIndex: 0, endIndex: 5, text: 'Hello' },
        { run: regular, startIndex: 5, endIndex: 11, text: ' World' },
      ],
      baseline: 700,
      x: 50, y: 688, width: 72, height: 14,
      leftMargin: 50, rightEdge: 122,
      fontSize: 12,
      isJustified: false,
      tabSplitIndex: -1,
    };

    const edits = distributeTextChangeToSegments(line, 'Hello World', 'HelloXXX World', 8);
    const shifts = computeHorizontalShiftsFromEdits(line, edits);
    const trailing = shifts.find(s => s.run === regular);
    expect(trailing).toBeTruthy();
    expect(trailing!.dx).toBeGreaterThan(10);
  });
});
