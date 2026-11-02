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
});
