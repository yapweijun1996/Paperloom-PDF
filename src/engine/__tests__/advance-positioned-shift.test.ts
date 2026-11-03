/**
 * Runs placed only by the advance of earlier show operators (no Td/Tm of
 * their own, typical of per-glyph Type3 CJK fonts) must keep that advance
 * when shifted. A Td restarts at the line matrix and discards it.
 */

import { describe, it, expect } from 'vitest';
import { applyRunPositionShifts } from '../editor/text-editor';
import { interpretPage } from '../content/interpreter';
import {
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFArray,
  type PDFPageInfo,
  type PDFObject,
} from '../types';

function makePage(content: string): { page: PDFPageInfo; objects: Map<string, PDFObject>; bytes: Uint8Array } {
  const fontDict = new PDFDict();
  for (const name of ['F1', 'F2', 'F3']) {
    const helv = new PDFDict();
    helv.set('Type', new PDFName('Font'));
    helv.set('Subtype', new PDFName('Type1'));
    helv.set('BaseFont', new PDFName('Helvetica'));
    fontDict.set(name, helv);
  }
  const resources = new PDFDict();
  resources.set('Font', fontDict);
  const pageDict = new PDFDict();
  pageDict.set('Resources', resources);
  pageDict.set('MediaBox', new PDFArray([
    new PDFNumber(0), new PDFNumber(0), new PDFNumber(612), new PDFNumber(792),
  ]));
  const page: PDFPageInfo = {
    index: 0,
    dict: pageDict,
    mediaBox: { x: 0, y: 0, width: 612, height: 792 },
    cropBox: { x: 0, y: 0, width: 612, height: 792 },
    rotate: 0,
    ref: new PDFRef(1, 0),
    resources,
    contentRefs: [new PDFRef(2, 0)],
  };
  const objects = new Map<string, PDFObject>();
  objects.set('1 0', pageDict);
  return { page, objects, bytes: new TextEncoder().encode(content) };
}

function startX(bytes: Uint8Array, page: PDFPageInfo, objects: Map<string, PDFObject>) {
  const runs = interpretPage(bytes, page, objects).textRuns;
  return new Map(runs.map(run => [run.text, run.glyphs[0].tRm.e]));
}

describe('shifting advance-positioned runs', () => {
  const content =
    'BT\n/F1 12 Tf\n1 0 0 1 50 700 Tm\n100 0 Td\n(AB) Tj\n/F2 12 Tf\n(CD) Tj\n/F3 12 Tf\n(EF) Tj\nET\n';

  it('moves later runs by the requested delta from their advanced origin', () => {
    const { page, objects, bytes } = makePage(content);
    const runs = interpretPage(bytes, page, objects).textRuns;
    expect(runs.map(run => run.text)).toEqual(['AB', 'CD', 'EF']);
    const before = startX(bytes, page, objects);

    const shifted = applyRunPositionShifts(bytes, [
      { run: runs[1], dx: 10, dy: 0 },
      { run: runs[2], dx: 10, dy: 0 },
    ]);
    const after = startX(shifted, page, objects);

    expect(after.get('AB')).toBeCloseTo(before.get('AB')!, 3);
    expect(after.get('CD')).toBeCloseTo(before.get('CD')! + 10, 3);
    expect(after.get('EF')).toBeCloseTo(before.get('EF')! + 10, 3);
  });

  it('applies a per-run delta that differs between later runs', () => {
    const { page, objects, bytes } = makePage(content);
    const runs = interpretPage(bytes, page, objects).textRuns;
    const before = startX(bytes, page, objects);

    const shifted = applyRunPositionShifts(bytes, [
      { run: runs[2], dx: 24, dy: 0 },
    ]);
    const after = startX(shifted, page, objects);

    expect(after.get('AB')).toBeCloseTo(before.get('AB')!, 3);
    expect(after.get('CD')).toBeCloseTo(before.get('CD')!, 3);
    expect(after.get('EF')).toBeCloseTo(before.get('EF')! + 24, 3);
  });

  it('does not shift a run that follows a re-encoded run at its pen advance', () => {
    const { page, objects, bytes } = makePage(content);
    const runs = interpretPage(bytes, page, objects).textRuns;
    const before = startX(bytes, page, objects);

    const shifted = applyRunPositionShifts(
      bytes,
      [{ run: runs[2], dx: 12, dy: 0 }],
      [runs[1]],
      [runs[1]],
    );
    const after = startX(shifted, page, objects);

    expect(after.get('CD')).toBeCloseTo(before.get('CD')!, 3);
    expect(after.get('EF')).toBeCloseTo(before.get('EF')!, 3);
  });

  it('leaves a later Td-positioned run in place', () => {
    const { page, objects, bytes } = makePage(
      'BT\n/F1 12 Tf\n1 0 0 1 50 700 Tm\n(AB) Tj\n/F2 12 Tf\n(CD) Tj\n/F3 12 Tf\n200 0 Td\n(EF) Tj\nET\n',
    );
    const runs = interpretPage(bytes, page, objects).textRuns;
    const before = startX(bytes, page, objects);

    const shifted = applyRunPositionShifts(bytes, [{ run: runs[1], dx: 15, dy: 0 }]);
    const after = startX(shifted, page, objects);

    expect(after.get('CD')).toBeCloseTo(before.get('CD')! + 15, 3);
    expect(after.get('EF')).toBeCloseTo(before.get('EF')!, 3);
  });

  it('moves every glyph of a run drawn one Tj per glyph and keeps the next line in place', () => {
    // Browser-printed PDFs draw each glyph with its own Tj and step with relative Td.
    const { page, objects, bytes } = makePage(
      'BT\n/F1 12 Tf\n1 0 0 1 50 700 Tm\n(A) Tj\n8.004 0 Td\n(B) Tj\n8.004 0 Td\n(C) Tj\n-16.008 -20 Td\n(DEF) Tj\nET\n',
    );
    const runs = interpretPage(bytes, page, objects).textRuns;
    const line = runs.find(run => run.text === 'ABC')!;
    expect(line.sourceInstructionIndices!.length).toBeGreaterThan(1);
    const glyphY = (content: Uint8Array) => interpretPage(content, page, objects).textRuns
      .flatMap(run => run.glyphs.map(glyph => [glyph.unicode, glyph.tRm.f] as const));

    const shifted = applyRunPositionShifts(bytes, [{ run: line, dx: 0, dy: -30 }]);
    const before = new Map(glyphY(bytes));
    const after = new Map(glyphY(shifted));
    for (const ch of 'ABC') expect(after.get(ch)).toBeCloseTo(before.get(ch)! - 30, 3);
    for (const ch of 'DEF') expect(after.get(ch)).toBeCloseTo(before.get(ch)!, 3);
  });

  it('moves a list number and its text together when both runs are shifted', () => {
    const { page, objects, bytes } = makePage(
      'BT\n/F1 12 Tf\n1 0 0 1 50 700 Tm\n(1.) Tj\n30 0 Td\n(Item) Tj\n-30 -20 Td\n(Next) Tj\nET\n',
    );
    const runs = interpretPage(bytes, page, objects).textRuns;
    const number = runs.find(run => run.text === '1.')!;
    const item = runs.find(run => run.text === 'Item')!;
    const startY = (content: Uint8Array) => new Map(interpretPage(content, page, objects).textRuns
      .map(run => [run.text, run.glyphs[0].tRm.f] as const));

    const before = startY(bytes);
    const after = startY(applyRunPositionShifts(bytes, [number, item].map(run => ({ run, dx: 0, dy: -40 }))));
    expect(after.get('1.')).toBeCloseTo(before.get('1.')! - 40, 3);
    expect(after.get('Item')).toBeCloseTo(before.get('Item')! - 40, 3);
    expect(after.get('Next')).toBeCloseTo(before.get('Next')!, 3);
  });

  it('moves a run that continues into a second text block', () => {
    // Browsers print a list marker in its own BT and the item text in the next.
    const { page, objects, bytes } = makePage(
      'BT\n/F1 12 Tf\n1 0 0 1 50 700 Tm\n(1.) Tj\nET\nBT\n/F1 12 Tf\n1 0 0 1 60.008 700 Tm\n(ABC) Tj\nET\nBT\n/F1 12 Tf\n1 0 0 1 50 680 Tm\n(XYZ) Tj\nET\n',
    );
    const runs = interpretPage(bytes, page, objects).textRuns;
    const line = runs.filter(run => run.y > 690);
    expect(line.map(run => run.text)).toEqual(['1.ABC']);
    const glyphY = (content: Uint8Array) => new Map(interpretPage(content, page, objects).textRuns
      .flatMap(run => run.glyphs.map(glyph => [glyph.unicode, glyph.tRm.f] as const)));

    const before = glyphY(bytes);
    const after = glyphY(applyRunPositionShifts(bytes, line.map(run => ({ run, dx: 0, dy: -40 }))));
    for (const ch of '1.ABC') expect(after.get(ch)).toBeCloseTo(before.get(ch)! - 40, 3);
    for (const ch of 'XYZ') expect(after.get(ch)).toBeCloseTo(before.get(ch)!, 3);
  });
});

