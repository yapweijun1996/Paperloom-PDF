/**
 * Flow-draw packing + justification evening tests.
 */

import { describe, it, expect } from 'vitest';
import {
  computeFlowDrawPositions,
  lineHasAnomalousIntraWordGaps,
  shouldPackLine,
} from '../flow/flow-draw';
import { shouldUseFlowDraw, measureWordGaps } from '../flow/justification-detect';
import type { TextLine } from '../flow/types';
import type { TextRun, GlyphPosition } from '../content/interpreter';
import { identityMatrix } from '../render/graphics-state';

function glyph(ch: string, x: number, fontSize = 11, width?: number): GlyphPosition {
  const w = width ?? fontSize * 0.5;
  return {
    charCode: ch.charCodeAt(0),
    unicode: ch,
    x,
    y: 700,
    width: w,
    fontSize,
    textSpaceWidth: w / fontSize,
    tRm: { a: fontSize, b: 0, c: 0, d: fontSize, e: x, f: 700 },
  };
}

function run(text: string, glyphs: GlyphPosition[], fontName: string): TextRun {
  const first = glyphs[0];
  const last = glyphs[glyphs.length - 1];
  return {
    type: 'text',
    text,
    glyphs,
    x: first.x,
    y: first.y,
    width: (last.x + last.width) - first.x,
    height: first.fontSize,
    fontName,
    fontSize: first.fontSize,
    textMatrix: identityMatrix(),
    fillColor: [0, 0, 0],
    fillAlpha: 1,
    blendMode: 'Normal',
    softMask: null,
    clipPaths: [],
  };
}

function makeLine(runs: TextRun[], text: string, extra?: Partial<TextLine>): TextLine {
  let minX = Infinity, maxX = -Infinity;
  for (const r of runs) {
    minX = Math.min(minX, r.x);
    maxX = Math.max(maxX, r.x + r.width);
  }
  return {
    id: 'l',
    runs,
    text,
    segments: [],
    baseline: 700,
    x: minX, y: 690, width: maxX - minX, height: 14,
    leftMargin: minX, rightEdge: maxX,
    fontSize: 11,
    isJustified: false,
    tabSplitIndex: -1,
    ...extra,
  };
}

/** Build a word of glyphs starting at x with equal advances. */
function wordGlyphs(word: string, startX: number, fontSize = 11): GlyphPosition[] {
  const adv = fontSize * 0.5;
  return [...word].map((ch, i) => glyph(ch, startX + i * adv, fontSize, adv));
}

describe('flow-draw punctuation packing', () => {
  it('packs anomalous gap before comma after bold run', () => {
    const bold = run('boards', wordGlyphs('boards', 100), 'FBold');
    const last = bold.glyphs[bold.glyphs.length - 1];
    const comma = run(',', [glyph(',', last.x + last.width + 6, 11, 2)], 'FReg');
    const line = makeLine([bold, comma], 'boards,');

    expect(lineHasAnomalousIntraWordGaps(line)).toBe(true);
    const positions = computeFlowDrawPositions(line);
    const sPos = positions.find(p => p.glyph.unicode === 's')!;
    const commaPos = positions.find(p => p.glyph.unicode === ',')!;
    expect(commaPos.x - (sPos.x + sPos.glyph.width)).toBeLessThan(11 * 0.12);
  });

  it('does NOT collapse tab gap between tech stack and date', () => {
    const left = run('Cloudflare', wordGlyphs('Cloudflare', 200), 'FReg');
    const right = run('Currently', wordGlyphs('Currently', 420), 'FBold');
    const line = makeLine([left, right], 'Cloudflare Currently');

    expect(lineHasAnomalousIntraWordGaps(line)).toBe(false);
    expect(shouldUseFlowDraw(line)).toBe(false);

    const positions = computeFlowDrawPositions(line);
    const ePos = positions.find(p => p.glyph.unicode === 'e' && p.x > 240)!;
    const cPos = positions.find(p => p.glyph.unicode === 'C' && p.x > 400)!;
    expect(cPos.x - (ePos.x + ePos.glyph.width)).toBeGreaterThan(100);
  });

  it('does not rewrite project title lines with pipes or underlines', () => {
    const title = run('Tool (Open Source)', wordGlyphs('Tool (Open Source)', 72), 'FBold');
    title.isUnderline = true;
    const pipe = run('|', [glyph('|', 200, 11, 3)], 'FReg');
    const tech = run('HTML, CSS', wordGlyphs('HTML, CSS', 210), 'FReg');
    const line = makeLine([title, pipe, tech], 'Tool (Open Source)|HTML, CSS');

    expect(shouldPackLine(line)).toBe(false);
    expect(shouldUseFlowDraw(line)).toBe(false);

    const positions = computeFlowDrawPositions(line);
    const pipePos = positions.find(p => p.glyph.unicode === '|')!;
    const hPos = positions.find(p => p.glyph.unicode === 'H')!;
    // Native positions preserved — H stays where the PDF placed it
    expect(hPos.x).toBe(210);
    expect(pipePos.x).toBe(200);
  });

  it('does NOT merge dash separators into words', () => {
    const email = run('a@b.com', wordGlyphs('a@b.com', 100), 'FReg');
    const dash = run('-', [glyph('-', 200, 11, 4)], 'FReg');
    const port = run('Portfolio', wordGlyphs('Portfolio', 220), 'FReg');
    const line = makeLine([email, dash, port], 'a@b.com-Portfolio');

    expect(lineHasAnomalousIntraWordGaps(line)).toBe(false);
    const positions = computeFlowDrawPositions(line);
    const mPos = positions.find(p => p.glyph.unicode === 'm')!;
    const pPos = positions.find(p => p.glyph.unicode === 'P')!;
    expect(pPos.x - (mPos.x + mPos.glyph.width)).toBeGreaterThan(50);
  });
});

describe('flow-draw keeps native word spacing (Acrobat parity)', () => {
  it('does NOT redistribute uneven TJ word gaps — preserves PDF positions', () => {
    // Simulate one TJ run: words with gaps 3, 14, 3, 12 (as encoded in the PDF)
    const fs = 11;
    const adv = fs * 0.5;
    const parts = ['Built', 'backend', 'and', 'REST', 'APIs', 'for', 'platform'];
    const gaps = [3, 14, 3, 12, 3, 14]; // uneven — Acrobat draws these as-is
    const glyphs: GlyphPosition[] = [];
    let x = 72;
    let text = '';
    const wordStarts: number[] = [];
    for (let wi = 0; wi < parts.length; wi++) {
      wordStarts.push(x);
      for (const ch of parts[wi]) {
        glyphs.push(glyph(ch, x, fs, adv));
        x += adv;
      }
      text += parts[wi];
      if (wi < parts.length - 1) {
        glyphs.push(glyph(' ', x, fs, gaps[wi]));
        x += gaps[wi];
        text += ' ';
      }
    }

    const body = run(text, glyphs, 'F1');
    const line = makeLine([body], text, {
      leftMargin: 72,
      rightEdge: x,
      width: x - 72,
      isJustified: true,
    });

    // Detection may still flag uneven gaps, but flow-draw must not rewrite them
    expect(shouldUseFlowDraw(line)).toBe(true);
    expect(shouldPackLine(line)).toBe(false);

    const positions = computeFlowDrawPositions(line);
    for (let wi = 0; wi < parts.length; wi++) {
      const firstChar = parts[wi][0];
      const pos = positions.find(
        p => p.glyph.unicode === firstChar && Math.abs(p.x - wordStarts[wi]) < 0.01,
      );
      expect(pos).toBeDefined();
      expect(pos!.x).toBeCloseTo(wordStarts[wi], 5);
    }
  });
});
