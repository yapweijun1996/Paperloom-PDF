import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { parsePDF, getPageContentBytes } from '../parser/parser';
import { updatePageContent } from '../editor/stream-compiler';
import { PDFArray, PDFDict, PDFRef } from '../types';
import { serializeDocument } from '../writer/serializer';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { prepareWholePageRedaction } from '../security/redaction/whole-page-redaction';
import { preparePartialGraphicsRedaction } from '../security/redaction/partial-graphics-redaction';

async function fixture() {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  pdf.addPage([200, 200]);
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  for (let i = 0; i < 2; i++) {
    const content = i === 0 ? '15 15 10 10 re f' : '60 60 20 30 re f';
    await updatePageContent(doc.pages[i].contentRefs, new TextEncoder().encode(content), doc.objects, false);
  }
  return doc;
}

function rootKids(doc: Awaited<ReturnType<typeof fixture>>): PDFArray {
  const root = doc.objects.get(doc.catalog.getRef('Pages')!.toKey());
  if (!(root instanceof PDFDict)) throw new Error('Invalid test fixture');
  const kids = root.getArray('Kids');
  if (!kids) throw new Error('Invalid test fixture');
  return kids;
}

describe('secure redaction page tree validation', () => {
  it.each(['whole', 'partial'] as const)('rejects an omitted marked page for %s redaction without modifying the saved document', async kind => {
    const doc = await fixture();
    const areas = kind === 'whole'
      ? [{ x: 0, y: 0, width: 200, height: 200 }, { x: 0, y: 0, width: 200, height: 200 }]
      : [{ x: 14, y: 14, width: 12, height: 12 }, { x: 59, y: 59, width: 22, height: 32 }];
    redactionEngine.markRegion(doc, 0, areas[0]);
    redactionEngine.markRegion(doc, 1, areas[1]);
    doc.pages.pop();
    const before = await serializeDocument(doc);
    expect(() => prepareWholePageRedaction(doc)).toThrow(/cached pages/);
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/cached pages/);
    await expect(redactionEngine.applySecureRedactions(doc)).rejects.toThrow(/cached pages/);
    const after = await serializeDocument(doc);
    expect(after).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
    const reopened = await parsePDF(after);
    expect(reopened.pages).toHaveLength(2);
    expect(reopened.pages.every(page => page.dict.has('Annots'))).toBe(true);
    expect(new TextDecoder().decode(getPageContentBytes(reopened.pages[1], reopened.objects))).toContain('60 60 20 30 re f');
  });

  it('rejects incomplete cached pages even when no cached page has a mark', async () => {
    const doc = await fixture();
    redactionEngine.markRegion(doc, 1, { x: 59, y: 59, width: 22, height: 32 });
    doc.pages.pop();
    const before = await serializeDocument(doc);
    await expect(redactionEngine.applySecureRedactions(doc)).rejects.toThrow(/cached pages/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it.each(['reordered cache', 'duplicate child', 'missing child', 'cycle', 'wrong parent'] as const)(
    'rejects %s before changing the document even without marks', async kind => {
      const doc = await fixture();
      const root = doc.objects.get(doc.catalog.getRef('Pages')!.toKey()) as PDFDict;
      const kids = rootKids(doc);
      if (kind === 'reordered cache') doc.pages.reverse();
      else if (kind === 'duplicate child') kids.items.push(kids.items[0]);
      else if (kind === 'missing child') kids.items.push(new PDFRef(999999, 0));
      else if (kind === 'cycle') kids.items.push(doc.catalog.getRef('Pages')!);
      else doc.pages[0].dict.set('Parent', doc.pages[1].ref);
      const before = await serializeDocument(doc);
      expect(() => prepareWholePageRedaction(doc)).toThrow();
      expect(() => preparePartialGraphicsRedaction(doc)).toThrow();
      await expect(redactionEngine.applySecureRedactions(doc)).rejects.toThrow();
      expect(await serializeDocument(doc)).toEqual(before);
      expect(doc.requiresFullRewrite).toBeUndefined();
      expect(root).toBeInstanceOf(PDFDict);
    },
  );

  it('accepts a valid unmarked document', async () => {
    const doc = await fixture();
    const before = await serializeDocument(doc);
    expect(await redactionEngine.applySecureRedactions(doc)).toMatchObject({ pagesProcessed: 0 });
    expect(await serializeDocument(doc)).toEqual(before);
  });
});
