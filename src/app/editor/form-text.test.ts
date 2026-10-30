import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as engine from '@/engine/browser-core';
import { extractPagePlainText } from '@/engine/ai/compare';
import { parsePDF } from '@/engine/parser/parser';
import { SessionDocumentEditor } from '@/engine/session/document-edit';
import { rawPDF } from '@/engine/__tests__/audit-p1-fixtures';
import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream } from '@/engine/types';
import { assertCurrentReplaceSupported, DocumentSearchIndex, replaceSearchMatches, searchDocument } from './search-index';

const text = new TextEncoder();
function stream(body: string, dict = ''): string {
  return `<< /Length ${body.length} ${dict} >>\nstream\n${body}\nendstream`;
}
async function fixture() {
  return parsePDF(rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /XObject << /Outer 4 0 R >> /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    stream('BT /F1 12 Tf 1 0 0 1 10 10 Tm (Needle) Tj ET /Inner Do', '/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Matrix [1 0 0 1 5 7] /Resources << /Font << /F1 5 0 R >> /XObject << /Inner 7 0 R >> >>'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream('q 2 0 0 2 10 20 cm /Outer Do Q q 1 0 0 1 100 20 cm /Outer Do Q'),
    stream('BT /F1 10 Tf 1 0 0 1 20 30 Tm (Nested) Tj ET', '/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources << /Font << /F1 5 0 R >> >>'),
  ]));
}

function orderingFixture(): Uint8Array {
  return rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /XObject << /Outer 4 0 R >> /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    stream('BT /F1 12 Tf 1 0 0 1 10 220 Tm (Token FormStart) Tj ET /Inner Do BT /F1 12 Tf 1 0 0 1 10 140 Tm (Token FormEnd) Tj ET', '/Type /XObject /Subtype /Form /BBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> /XObject << /Inner 7 0 R >> >>'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream('BT /F1 12 Tf 1 0 0 1 10 260 Tm (Token PageFirst) Tj ET /Outer Do BT /F1 12 Tf 1 0 0 1 10 100 Tm (Token PageLast) Tj ET'),
    stream('BT /F1 12 Tf 1 0 0 1 10 180 Tm (Token Nested) Tj ET', '/Type /XObject /Subtype /Form /BBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >>'),
  ]);
}

function actualFormFixture(pageBody: string, formBody = 'BT /F1 12 Tf 1 0 0 1 10 220 Tm (Token Secret) Tj ET'): Uint8Array {
  return rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /XObject << /Outer 4 0 R >> /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    stream(formBody, '/Type /XObject /Subtype /Form /BBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >>'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', stream(pageBody),
  ]);
}

describe('Form XObject text extraction and search', () => {
  it('extracts text from a Form without reading nested image bytes', async () => {
    const doc = await parsePDF(rawPDF([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /XObject << /Outer 4 0 R >> >> /Contents 6 0 R >>',
      stream('BT /F1 12 Tf 1 0 0 1 10 10 Tm (Needle) Tj ET /Image Do', '/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources << /Font << /F1 5 0 R >> /XObject << /Image 7 0 R >> >>'),
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      stream('/Outer Do'),
      stream('abc', '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8'),
    ]));
    const page = doc.pages[0];
    const visibility = new engine.OptionalContentVisibility(doc.catalog, doc.objects);
    const interpreted = engine.interpretPage(engine.getPageContentBytes(page, doc.objects), page, doc.objects, visibility);
    const image = doc.objects.get('7_0') as PDFStream;
    Object.defineProperty(image, 'rawBytes', { get() { throw new Error('Image bytes were read'); } });
    const runs = engine.extractPageTextRuns(page, doc.objects, visibility, interpreted);
    expect(runs.map(entry => entry.run.text)).toContain('Needle');
  });

  it.skipIf(spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status !== 0)(
    'uses enclosing ActualText for a Form and prevents unsafe replacement', async () => {
      const bytes = actualFormFixture('/Span << /ActualText (Token Substitute) >> BDC /Outer Do EMC');
      const doc = await parsePDF(bytes);
      const matches = await searchDocument(doc, 'Token', false, '1', new DocumentSearchIndex(), engine, () => true);
      expect(matches?.map(match => [match.runText, match.source, match.runIndex]))
        .toEqual([['Token Substitute', 'form', -1]]);
      expect(() => assertCurrentReplaceSupported(matches![0])).toThrow(/Form XObject/);
      await expect(replaceSearchMatches(doc, 'Token Substitute', 'Changed', false, engine)).rejects.toThrow(/Form XObject/);
      expect(await searchDocument(doc, 'Token Secret', false, '2', new DocumentSearchIndex(), engine, () => true)).toEqual([]);
      const dir = mkdtempSync(join(tmpdir(), 'paperloom-form-actual-'));
      try {
        const path = join(dir, 'actual.pdf'); writeFileSync(path, bytes);
        expect(execFileSync('pdftotext', ['-raw', path, '-'], { encoding: 'utf8' }).trim()).toBe('Token Substitute');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
  );

  it('treats page and Form text inside one ActualText span as one read-only match', async () => {
    const doc = await parsePDF(actualFormFixture('/Span << /ActualText (Token Logical) >> BDC BT /F1 12 Tf 1 0 0 1 10 260 Tm (Token Before) Tj ET /Outer Do BT /F1 12 Tf 1 0 0 1 10 100 Tm (Token After) Tj ET EMC BT /F1 12 Tf 1 0 0 1 10 60 Tm (Token Outside) Tj ET'));
    const matches = await searchDocument(doc, 'Token', false, '1', new DocumentSearchIndex(), engine, () => true);
    expect(matches?.map(match => [match.runText, match.source, match.runIndex]))
      .toEqual([['Token Logical', 'form', -1], ['Token Outside', 'page', 1]]);
    await expect(replaceSearchMatches(doc, 'Token Logical', 'Changed', false, engine)).rejects.toThrow(/Form XObject/);
  });

  it.each([
    '/Span << /ActualText (Token Outer) >> BDC /Span << /ActualText (Token Inner) >> BDC /Outer Do EMC EMC',
    '/Span << /ActualText (Token Outer) >> BDC /Span << /ActualText (Token Inner) >> BDC BT /F1 12 Tf (Token Page) Tj ET EMC /Outer Do EMC',
    '/Span << /ActualText (Token Unclosed) >> BDC /Outer Do',
  ])('refuses unsafe nested or unterminated Form ActualText scopes before replacement', async body => {
    const doc = await parsePDF(actualFormFixture(body));
    await expect(searchDocument(doc, 'Token', false, '1', new DocumentSearchIndex(), engine, () => true))
      .rejects.toThrow(/safely inspect page/);
    await expect(replaceSearchMatches(doc, 'Token', 'Changed', false, engine)).rejects.toThrow(/ActualText/);
  });

  it('refuses nested ActualText spanning a page and a Form stream', async () => {
    const doc = await parsePDF(actualFormFixture('/Span << /ActualText (Token Outer) >> BDC /Outer Do EMC',
      '/Span << /ActualText (Token Inner) >> BDC BT /F1 12 Tf 1 0 0 1 10 220 Tm (Token Secret) Tj ET EMC'));
    await expect(searchDocument(doc, 'Token', false, '1', new DocumentSearchIndex(), engine, () => true))
      .rejects.toThrow(/safely inspect page/);
    await expect(replaceSearchMatches(doc, 'Token', 'Changed', false, engine)).rejects.toThrow(/Nested ActualText/);
  });

  it('does not expose an ActualText Form scope hidden by optional content', async () => {
    const doc = await parsePDF(actualFormFixture('/OC /Hidden BDC /Span << /ActualText (Token Hidden) >> BDC /Outer Do EMC EMC BT /F1 12 Tf 1 0 0 1 10 60 Tm (Token Visible) Tj ET'));
    const off = new PDFRef(20, 0);
    doc.objects.set(off.toKey(), new PDFDict([['Type', new PDFName('OCG')]]));
    doc.catalog.set('OCProperties', new PDFDict([['OCGs', new PDFArray([off])], ['D', new PDFDict([['OFF', new PDFArray([off])]])]]));
    doc.pages[0].resources.set('Properties', new PDFDict([['Hidden', off]]));
    const matches = await searchDocument(doc, 'Token', false, '1', new DocumentSearchIndex(), engine, () => true);
    expect(matches?.map(match => match.runText)).toEqual(['Token Visible']);
  });

  it('replace all changes an outside match without altering raw page text inside an ActualText Form span', async () => {
    const doc = await parsePDF(actualFormFixture('/Span << /ActualText (Logical Substitute) >> BDC BT /F1 12 Tf 1 0 0 1 10 260 Tm (Token Raw) Tj ET /Outer Do EMC BT /F1 12 Tf 1 0 0 1 10 60 Tm (Token Raw) Tj ET'));
    const formBefore = (doc.objects.get('4_0') as PDFStream).getBytes().slice();
    const before = await searchDocument(doc, 'Token Raw', false, '1', new DocumentSearchIndex(), engine, () => true);
    expect(before?.map(match => match.source)).toEqual(['page']);
    let replaced = 0;
    await new SessionDocumentEditor().edit(doc, 'replace-all', async staged => {
      replaced = await replaceSearchMatches(staged, 'Token Raw', 'Changed', false, engine);
    });
    expect(replaced).toBe(1);
    expect((doc.objects.get('4_0') as PDFStream).getBytes()).toEqual(formBefore);
    const pageBytes = engine.getPageContentBytes(doc.pages[0], doc.objects);
    expect(new TextDecoder().decode(pageBytes)).toContain('(Token Raw)');
    const after = await searchDocument(doc, 'Logical Substitute', false, '2', new DocumentSearchIndex(), engine, () => true);
    expect(after?.map(match => [match.runText, match.source])).toEqual([['Logical Substitute', 'form']]);
  });

  it('keeps text shows separated by a Form invocation inside one text object', async () => {
    const doc = await parsePDF(orderingFixture());
    const pageStream = doc.objects.get('6_0') as PDFStream;
    pageStream.decodedBytes = text.encode('BT /F1 12 Tf 1 0 0 1 10 260 Tm (Token First) Tj /Outer Do (Token Last) Tj ET');
    const matches = await searchDocument(doc, 'Token', false, '1', new DocumentSearchIndex(), engine, () => true);
    expect(matches?.map(match => [match.runText, match.source, match.runIndex])).toEqual([
      ['Token First', 'page', 0], ['Token FormStart', 'form', -1], ['Token Nested', 'form', -1],
      ['Token FormEnd', 'form', -1], ['Token Last', 'page', 1],
    ]);
  });
  it('interleaves page, Form and nested Form matches in content-stream order', async () => {
    const doc = await parsePDF(orderingFixture());
    const matches = await searchDocument(doc, 'Token', false, '1', new DocumentSearchIndex(), engine, () => true);
    expect(matches?.map(match => [match.runText, match.source, match.runIndex])).toEqual([
      ['Token PageFirst', 'page', 0], ['Token FormStart', 'form', -1],
      ['Token Nested', 'form', -1], ['Token FormEnd', 'form', -1], ['Token PageLast', 'page', 1],
    ]);
  });

  it.skipIf(spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status !== 0)(
    'matches Poppler raw text order for page and nested Form invocations', async () => {
      const bytes = orderingFixture();
      const doc = await parsePDF(bytes);
      const matches = await searchDocument(doc, 'Token', false, '1', new DocumentSearchIndex(), engine, () => true);
      const dir = mkdtempSync(join(tmpdir(), 'paperloom-form-order-'));
      try {
        const path = join(dir, 'order.pdf');
        writeFileSync(path, bytes);
        const actual = execFileSync('pdftotext', ['-raw', path, '-'], { encoding: 'utf8' });
        const lines = actual.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('Token'));
        expect(matches?.map(match => match.runText)).toEqual(lines);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
  );

  it('preserves logical ActualText when mixed paint modes are followed by a Form', async () => {
    const doc = await parsePDF(orderingFixture());
    const pageStream = doc.objects.get('6_0') as PDFStream;
    pageStream.decodedBytes = text.encode('/Span << /ActualText (Token Actual) >> BDC BT /F1 12 Tf 1 0 0 1 10 260 Tm 0 Tr (visible) Tj 3 Tr (hidden) Tj ET EMC /Outer Do BT /F1 12 Tf 1 0 0 1 10 100 Tm (Token PageLast) Tj ET');
    const matches = await searchDocument(doc, 'Token', false, '1', new DocumentSearchIndex(), engine, () => true);
    expect(matches?.map(match => match.runText)).toEqual(['Token Actual', 'Token FormStart', 'Token Nested', 'Token FormEnd', 'Token PageLast']);
    expect(matches?.[0].runIndex).toBe(0);
    expect(matches?.at(-1)?.runIndex).toBe(1);
  });

  it('retains each repeated Form invocation between its surrounding page runs', async () => {
    const doc = await parsePDF(orderingFixture());
    const pageStream = doc.objects.get('6_0') as PDFStream;
    pageStream.decodedBytes = text.encode('BT /F1 12 Tf 1 0 0 1 10 280 Tm (Token First) Tj ET /Outer Do BT /F1 12 Tf 1 0 0 1 10 90 Tm (Token Middle) Tj ET /Outer Do BT /F1 12 Tf 1 0 0 1 10 10 Tm (Token Last) Tj ET');
    const matches = await searchDocument(doc, 'Token', false, '1', new DocumentSearchIndex(), engine, () => true);
    expect(matches?.map(match => [match.runText, match.runIndex])).toEqual([
      ['Token First', 0], ['Token FormStart', -1], ['Token Nested', -1], ['Token FormEnd', -1],
      ['Token Middle', 1], ['Token FormStart', -1], ['Token Nested', -1], ['Token FormEnd', -1], ['Token Last', 2],
    ]);
  });
  it('extracts nested and repeated instances with page-space coordinates and read-only origins', async () => {
    const doc = await fixture();
    const page = doc.pages[0];
    const visibility = new engine.OptionalContentVisibility(doc.catalog, doc.objects);
    const interpreted = engine.interpretPage(engine.getPageContentBytes(page, doc.objects), page, doc.objects, visibility);
    expect(interpreted.textRuns).toHaveLength(0);
    const runs = engine.extractPageTextRuns(page, doc.objects, visibility, interpreted);
    expect(runs.map(entry => entry.run.text)).toEqual(['Needle', 'Nested', 'Needle', 'Nested']);
    expect(runs.map(entry => entry.run.x)).toEqual([40, 60, 115, 125]);
    expect(extractPagePlainText(doc, 0)).toContain('Needle');
    expect(extractPagePlainText(doc, 0)).toContain('Nested');
    const matches = await searchDocument(doc, 'Needle', false, '1', new DocumentSearchIndex(), engine, () => true);
    expect(matches?.map(match => [match.source, match.runIndex, match.pdfX])).toEqual([['form', -1, 40], ['form', -1, 115]]);
  });

  it('respects hidden Form layers and guards cycles without dropping repeated instances', async () => {
    const doc = await fixture();
    const outer = doc.objects.get('4_0') as PDFStream;
    const nested = doc.objects.get('7_0') as PDFStream;
    const off = new PDFRef(20, 0);
    doc.objects.set(off.toKey(), new PDFDict([['Type', new PDFName('OCG')]]));
    doc.catalog.set('OCProperties', new PDFDict([['OCGs', new PDFArray([off])], ['D', new PDFDict([['OFF', new PDFArray([off])]])]]));
    nested.dict.set('OC', off);
    const visible = await searchDocument(doc, 'Nested', false, '1', new DocumentSearchIndex(), engine, () => true);
    expect(visible).toEqual([]);
    nested.dict.delete('OC');
    const nestedResources = nested.dict.get('Resources') as PDFDict;
    nestedResources.set('XObject', new PDFDict([['Cycle', new PDFRef(4, 0)]]));
    nested.decodedBytes = text.encode('BT /F1 10 Tf (Nested) Tj ET /Cycle Do');
    const matches = await searchDocument(doc, 'Nested', false, '2', new DocumentSearchIndex(), engine, () => true);
    expect(matches).toHaveLength(2);
    expect(outer).toBeInstanceOf(PDFStream);
  });

  it('fails closed for unavailable decoded streams and bounded traversal', async () => {
    const doc = await fixture();
    const outer = doc.objects.get('4_0') as PDFStream;
    outer.dict.set('Filter', new PDFName('FlateDecode'));
    outer.decodedBytes = null;
    await expect(searchDocument(doc, 'Needle', false, '1', new DocumentSearchIndex(), engine, () => true)).rejects.toThrow('safely inspect page');
    outer.dict.delete('Filter');
    outer.decodedBytes = outer.rawBytes;
    const pageStream = doc.objects.get('6_0') as PDFStream;
    pageStream.decodedBytes = text.encode('/Outer Do '.repeat(513));
    await expect(searchDocument(doc, 'Needle', false, '2', new DocumentSearchIndex(), engine, () => true)).rejects.toThrow('safely inspect page');
  });

  it('transforms rotated Form geometry to an axis-aligned page highlight', async () => {
    const doc = await fixture();
    const pageStream = doc.objects.get('6_0') as PDFStream;
    pageStream.decodedBytes = text.encode('q 0 1 -1 0 200 0 cm /Outer Do Q');
    const matches = await searchDocument(doc, 'Needle', false, '1', new DocumentSearchIndex(), engine, () => true);
    expect(matches).toHaveLength(1);
    expect(matches?.[0].pdfX).toBeLessThan(183);
    expect(matches?.[0].pdfY).toBeCloseTo(15);
    expect(matches?.[0].pdfHeight).toBeGreaterThan(matches![0].pdfWidth);
  });

  it('rejects current Form matches, including a stale or invalid origin, before editing', async () => {
    const doc = await fixture();
    const matches = await searchDocument(doc, 'Needle', false, '1', new DocumentSearchIndex(), engine, () => true);
    const match = matches![0];
    expect(() => assertCurrentReplaceSupported(match)).toThrow(/Form XObject/);
    expect(() => assertCurrentReplaceSupported({ ...match, source: 'page' })).toThrow(/Form XObject/);
    expect(() => assertCurrentReplaceSupported({ ...match, source: 'page', runIndex: 0 })).not.toThrow();
  });

  it('rescans the staged graph before replace all and leaves content unchanged when an index is stale', async () => {
    const doc = await fixture();
    const pageStream = doc.objects.get('6_0') as PDFStream;
    const outer = doc.objects.get('4_0') as PDFStream;
    pageStream.decodedBytes = text.encode('BT /F1 12 Tf (Needle) Tj ET /Outer Do');
    outer.decodedBytes = text.encode('BT /F1 12 Tf (Other) Tj ET');
    const stale = await searchDocument(doc, 'Needle', false, '1', new DocumentSearchIndex(), engine, () => true);
    expect(stale?.map(match => match.source)).toEqual(['page']);
    outer.decodedBytes = text.encode('BT /F1 12 Tf (Needle) Tj ET');
    const before = pageStream.getBytes().slice();
    let writes = 0;
    const wrapped = { ...engine, updatePageContent: async (...args: Parameters<typeof engine.updatePageContent>) => {
      writes++;
      return engine.updatePageContent(...args);
    } };
    const editor = new SessionDocumentEditor();
    await expect(editor.edit(doc, 'replace-all', async staged => {
      await replaceSearchMatches(staged, 'Needle', 'Changed', false, wrapped);
    })).rejects.toThrow(/Form XObject/);
    expect(writes).toBe(0);
    expect(pageStream.getBytes()).toEqual(before);
    expect(outer.getBytes()).toEqual(text.encode('BT /F1 12 Tf (Needle) Tj ET'));
  });

  it('uses literal, case-sensitive matching for replace all', async () => {
    const doc = await fixture();
    const outer = doc.objects.get('4_0') as PDFStream;
    outer.decodedBytes = text.encode('BT /F1 12 Tf (AxB) Tj ET');
    expect(await replaceSearchMatches(doc, 'A.B', 'New', true, engine)).toBe(0);
    outer.decodedBytes = text.encode('BT /F1 12 Tf (a.b) Tj ET');
    expect(await replaceSearchMatches(doc, 'A.B', 'New', true, engine)).toBe(0);
    await expect(replaceSearchMatches(doc, 'A.B', 'New', false, engine)).rejects.toThrow(/Form XObject/);
  });

  it('rejects a cloned parser fallback before replace all can write', async () => {
    const doc = await fixture();
    const outer = doc.objects.get('4_0') as PDFStream;
    outer.dict.set('Filter', new PDFName('FlateDecode'));
    outer.decodedBytes = outer.rawBytes;
    let writes = 0;
    const wrapped = { ...engine, updatePageContent: async (...args: Parameters<typeof engine.updatePageContent>) => {
      writes++;
      return engine.updatePageContent(...args);
    } };
    await expect(new SessionDocumentEditor().edit(doc, 'replace-all', async staged => {
      await replaceSearchMatches(staged, 'Needle', 'Changed', false, wrapped);
    })).rejects.toThrow(/decoded stream/);
    expect(writes).toBe(0);
  });
});
