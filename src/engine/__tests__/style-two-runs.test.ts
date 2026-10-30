/**
 * A title made of two separate BT blocks (different colour) must have BOTH runs
 * resized when a whole-line font size is applied.
 */
import { describe, it, expect } from 'vitest';
import { buildDocumentFlow } from '../flow/index';
import { applyStyleToSelection } from '../flow/style-edit';
import { interpretPage } from '../content/interpreter';
import {
  PDFDict, PDFName, PDFNumber, PDFRef, PDFArray,
  type PDFPageInfo, type PDFObject,
} from '../types';

function makePage(content: string) {
  const bytes = new TextEncoder().encode(content);
  const fontDict = new PDFDict();
  const helv = new PDFDict();
  helv.set('Type', new PDFName('Font'));
  helv.set('Subtype', new PDFName('Type1'));
  helv.set('BaseFont', new PDFName('Helvetica'));
  fontDict.set('F1', helv);
  const resources = new PDFDict();
  resources.set('Font', fontDict);
  const pageDict = new PDFDict();
  pageDict.set('Resources', resources);
  pageDict.set('MediaBox', new PDFArray([new PDFNumber(0), new PDFNumber(0), new PDFNumber(612), new PDFNumber(792)]));
  const page: PDFPageInfo = {
    index: 0, dict: pageDict,
    mediaBox: { x: 0, y: 0, width: 612, height: 792 },
    cropBox: { x: 0, y: 0, width: 612, height: 792 },
    rotate: 0, ref: new PDFRef(1, 0), resources, contentRefs: [new PDFRef(2, 0)],
  };
  const objects = new Map<string, PDFObject>();
  objects.set('1 0', pageDict);
  return { bytes, page, objects };
}

describe('whole-line font size over two BT blocks', () => {
  it('resizes both runs', () => {
    const content =
      '0 0 1 rg BT\n14 0 0 14 34 500 Tm\n/F1 1 Tf\n[(PROJECT:)] TJ\nET\n' +
      '0 0 0 rg BT\n14 0 0 14 103.2 500 Tm\n/F1 1 Tf\n[( 30 SCIENCE PARK)] TJ\nET\n';
    const { bytes, page, objects } = makePage(content);
    const before = interpretPage(bytes, page, objects);
    const flow = buildDocumentFlow(before.displayList.filter(item => item.type === 'text'));
    expect(flow.lines.length).toBe(1);
    const line = flow.lines[0];
    const res = applyStyleToSelection(bytes, page, objects, line, 0, line.text.length, { fontSize: 30 });
    const after = interpretPage(res.newContentBytes, page, objects);
    const text = new TextDecoder().decode(res.newContentBytes);
    const tms = [...text.matchAll(/([\d.]+) 0 0 ([\d.]+) ([\d.]+) [\d.]+ Tm/g)].map((m) => [Number(m[1]), Number(m[3])]);
    expect(tms.length).toBe(2);
    expect(tms.every(([sz]) => Math.abs(sz - 30) < 0.6)).toBe(true);
    // second block must not sit on top of the (now larger) first one
    const painted = after.displayList.filter(item => item.type === 'text');
    expect(painted.length).toBe(2);
    expect(painted[0].fillColor).toEqual([0, 0, 1]);
    expect(painted[1].fillColor).toEqual([0, 0, 0]);
    expect(painted[1].x).toBeGreaterThanOrEqual(painted[0].x + painted[0].width - 1);
  });

  it('keeps three differently colored blocks ordered inside their clip', () => {
    const content = 'q 0 0 500 700 re W n\n' +
      '0 0 1 rg BT 14 0 0 14 34 500 Tm /F1 1 Tf (AAAA) Tj ET\n' +
      '1 0 0 rg BT 14 0 0 14 72 500 Tm /F1 1 Tf (BBBB) Tj ET\n' +
      '0 0 0 rg BT 14 0 0 14 110 500 Tm /F1 1 Tf (CCCC) Tj ET\nQ\n';
    const { bytes, page, objects } = makePage(content);
    const before = interpretPage(bytes, page, objects);
    const line = buildDocumentFlow(before.displayList.filter(item => item.type === 'text')).lines[0];
    const result = applyStyleToSelection(bytes, page, objects, line, 0, line.text.length, { fontSize: 28 });
    const after = interpretPage(result.newContentBytes, page, objects);
    const painted = after.displayList.filter(item => item.type === 'text');
    expect(painted.map(run => run.fillColor)).toEqual([[0, 0, 1], [1, 0, 0], [0, 0, 0]]);
    expect(painted.every(run => run.clipPaths.length === 1)).toBe(true);
    for (let i = 1; i < painted.length; i++) {
      expect(painted[i].x).toBeGreaterThanOrEqual(painted[i - 1].x + painted[i - 1].width - 1);
    }
  });

  it('does not double-shift differently colored text advancing within one BT block', () => {
    const content = 'BT 14 0 0 14 34 500 Tm /F1 1 Tf 0 0 1 rg (AAAA) Tj 1 0 0 rg (BBBB) Tj ET';
    const { bytes, page, objects } = makePage(content);
    const before = interpretPage(bytes, page, objects);
    const line = buildDocumentFlow(before.displayList.filter(item => item.type === 'text')).lines[0];
    const result = applyStyleToSelection(bytes, page, objects, line, 0, line.text.length, { fontSize: 28 });
    const painted = interpretPage(result.newContentBytes, page, objects).displayList.filter(item => item.type === 'text');
    expect(painted.map(run => run.fillColor)).toEqual([[0, 0, 1], [1, 0, 0]]);
    expect(painted[1].x).toBeCloseTo(painted[0].x + painted[0].width, 0);
  });

  it('moves independent blocks closer when the whole line shrinks', () => {
    const content = '0 0 1 rg BT 28 0 0 28 34 500 Tm /F1 1 Tf (AAAA) Tj ET\n' +
      '1 0 0 rg BT 28 0 0 28 110 500 Tm /F1 1 Tf (BBBB) Tj ET';
    const { bytes, page, objects } = makePage(content);
    const before = interpretPage(bytes, page, objects).displayList.filter(item => item.type === 'text');
    const line = buildDocumentFlow(before).lines[0];
    const result = applyStyleToSelection(bytes, page, objects, line, 0, line.text.length, { fontSize: 14 });
    const painted = interpretPage(result.newContentBytes, page, objects).displayList.filter(item => item.type === 'text');
    expect(painted[1].x).toBeLessThan(before[1].x);
    expect(painted[1].x).toBeGreaterThanOrEqual(painted[0].x + painted[0].width - 1);
    expect(painted.map(run => run.fillColor)).toEqual([[0, 0, 1], [1, 0, 0]]);
  });

  it('uses page-space offsets under a scaled graphics matrix', () => {
    const content = 'q 2 0 0 2 0 0 cm\n' +
      '0 0 1 rg BT 14 0 0 14 34 250 Tm /F1 1 Tf (AAAA) Tj ET\n' +
      '1 0 0 rg BT 14 0 0 14 72 250 Tm /F1 1 Tf (BBBB) Tj ET\nQ';
    const { bytes, page, objects } = makePage(content);
    const before = interpretPage(bytes, page, objects).displayList.filter(item => item.type === 'text');
    const line = buildDocumentFlow(before).lines[0];
    const result = applyStyleToSelection(bytes, page, objects, line, 0, line.text.length, { fontSize: 40 });
    const painted = interpretPage(result.newContentBytes, page, objects).displayList.filter(item => item.type === 'text');
    expect(painted[1].x).toBeGreaterThan(before[1].x);
    expect(painted[1].x).toBeGreaterThanOrEqual(painted[0].x + painted[0].width - 1);
    expect(painted.map(run => run.fillColor)).toEqual([[0, 0, 1], [1, 0, 0]]);
  });
});
