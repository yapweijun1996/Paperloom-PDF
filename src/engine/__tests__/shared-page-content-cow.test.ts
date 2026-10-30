import { describe, expect, it } from 'vitest';
import { parsePDF, getPageContentBytes } from '../parser/parser';
import { bindPageContentRefs, updatePageContent } from '../editor/stream-compiler';
import { PDFArray, PDFDict, PDFRef, PDFStream } from '../types';
import { saveOptimized, saveQuick } from '../writer/save-pipeline';
import { serializeDocument } from '../writer/serializer';
import { captureHistoryEntry, EditorHistory, restoreDocumentStructure } from '../editing/editor-history';
import { SessionDocumentEditor } from '../session/document-edit';
import { dehydrateDocument, hydrateDocument } from '../worker/codec';
import { rawPDF } from './audit-p1-fixtures';

const encoder = new TextEncoder(), decoder = new TextDecoder();
const overlays = { drawnPaths: [], floatingTexts: [], floatingImages: [], signatures: [] };
const stream = (text: string) => `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;

async function fixture(kind: 'single' | 'direct-array' | 'indirect-array' | 'indirect-chain' = 'single') {
  const contents = kind === 'single' ? '5 0 R' : kind === 'direct-array' ? '[5 0 R 6 0 R]'
    : kind === 'indirect-array' ? '7 0 R' : '8 0 R';
  return parsePDF(rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents ${contents} >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents ${contents} >>`,
    stream('q 1 0 0 1 10 10 cm Q'), stream('q 1 0 0 1 20 20 cm Q'),
    '[5 0 R 6 0 R]', '7 0 R',
  ]));
}

describe('shared page content editing', () => {
  it.each(['document-bound', 'document-alias', 'unbound-document'] as const)(
    'rejects a shared refs array with %s ownership without changing objects or caches', async mode => {
      const doc = await fixture('single'), [first, second] = doc.pages;
      const refs = [...first.contentRefs];
      first.contentRefs = refs;
      second.contentRefs = refs;
      bindPageContentRefs(first, mode === 'unbound-document' ? undefined : doc);
      if (mode !== 'document-alias') bindPageContentRefs(second, mode === 'unbound-document' ? undefined : doc);
      const before = dehydrateDocument(doc), entries = [...doc.objects];
      const firstContents = first.dict.get('Contents'), secondContents = second.dict.get('Contents');
      const oldStream = doc.objects.get(refs[0].toKey()) as PDFStream;
      const oldBytes = oldStream.rawBytes.slice();
      await expect(updatePageContent(refs, encoder.encode('incorrect page'), doc.objects, false)).rejects.toThrow();
      expect(dehydrateDocument(doc)).toEqual(before);
      expect([...doc.objects]).toEqual(entries);
      for (const [key, value] of entries) expect(doc.objects.get(key)).toBe(value);
      expect(first.contentRefs).toBe(refs);
      expect(second.contentRefs).toBe(refs);
      expect(first.dict.get('Contents')).toBe(firstContents);
      expect(second.dict.get('Contents')).toBe(secondContents);
      expect(oldStream.rawBytes).toEqual(oldBytes);
    },
  );

  it.each(['document-alias', 'unbound-document'] as const)(
    'rejects a new %s refs alias during compression', async mode => {
      const doc = await fixture('single'), [first, second] = doc.pages;
      const refs = [...first.contentRefs];
      first.contentRefs = refs;
      bindPageContentRefs(first, mode === 'document-alias' ? doc : undefined);
      const entries = [...doc.objects], firstContents = first.dict.get('Contents'), secondContents = second.dict.get('Contents');
      const pending = updatePageContent(refs, encoder.encode('incorrect page'), doc.objects, false);
      second.contentRefs = refs;
      if (mode === 'unbound-document') bindPageContentRefs(second);
      await expect(pending).rejects.toThrow(/ambiguous|changed during/);
      expect([...doc.objects]).toEqual(entries);
      for (const [key, value] of entries) expect(doc.objects.get(key)).toBe(value);
      expect(first.contentRefs).toBe(refs);
      expect(second.contentRefs).toBe(refs);
      expect(first.dict.get('Contents')).toBe(firstContents);
      expect(second.dict.get('Contents')).toBe(secondContents);
    },
  );

  it('allows repeated binding to the same page and ignores owners that moved to another refs array', async () => {
    const doc = await fixture('single'), [first, second] = doc.pages;
    const refs = [...first.contentRefs];
    first.contentRefs = refs;
    second.contentRefs = refs;
    bindPageContentRefs(second, doc);
    second.contentRefs = [...refs];
    bindPageContentRefs(second, doc);
    bindPageContentRefs(first, doc);
    bindPageContentRefs(first);
    bindPageContentRefs(first, doc);
    await updatePageContent(refs, encoder.encode('q Q'), doc.objects, false);
    expect(decoder.decode(getPageContentBytes(first, doc.objects))).toBe('q Q');
    expect(decoder.decode(getPageContentBytes(second, doc.objects))).toContain('10 10');
  });

  it.each(['single', 'direct-array', 'indirect-array', 'indirect-chain'] as const)(
    'isolates %s content through fast, incremental and optimized saves', async kind => {
      for (const mode of ['full', 'incremental', 'optimized'] as const) {
        const doc = await fixture(kind), first = doc.pages[0], other = doc.pages[1];
        const before = getPageContentBytes(other, doc.objects).slice();
        expect(before.length).toBeGreaterThan(0);
        await updatePageContent(first.contentRefs, encoder.encode('q 1 0 0 1 99 99 cm Q'), doc.objects, false);
        expect(getPageContentBytes(other, doc.objects)).toEqual(before);
        const bytes = mode === 'full' ? await serializeDocument(doc) : mode === 'optimized' ? await saveOptimized(doc)
          : await saveQuick(doc, new Set(first.contentRefs.map(ref => ref.toKey())));
        const reopened = await parsePDF(bytes);
        expect(decoder.decode(getPageContentBytes(reopened.pages[0], reopened.objects))).toContain('99 99');
        expect(getPageContentBytes(reopened.pages[1], reopened.objects)).toEqual(before);
      }
    }, 30000,
  );

  it('keeps the other page intact through undo and redo', async () => {
    const doc = await fixture('indirect-array'), history = new EditorHistory();
    const initial = getPageContentBytes(doc.pages[0], doc.objects).slice();
    history.seed(captureHistoryEntry(doc, 0, initial, overlays, 'initial'));
    await updatePageContent(doc.pages[0].contentRefs, encoder.encode('q 99 0 0 99 0 0 cm Q'), doc.objects, false);
    history.push(captureHistoryEntry(doc, 0, getPageContentBytes(doc.pages[0], doc.objects), overlays, 'edit'));
    await restoreDocumentStructure(doc, history.undo()!, updatePageContent);
    expect(getPageContentBytes(doc.pages[0], doc.objects)).toEqual(initial);
    expect(getPageContentBytes(doc.pages[1], doc.objects)).toEqual(initial);
    await restoreDocumentStructure(doc, history.redo()!, updatePageContent);
    expect(decoder.decode(getPageContentBytes(doc.pages[0], doc.objects))).toContain('99 0 0 99');
    expect(getPageContentBytes(doc.pages[1], doc.objects)).toEqual(initial);
  });

  it('transfers staged page and new stream keys for explicit incremental save', async () => {
    const doc = await fixture('single'), before = getPageContentBytes(doc.pages[1], doc.objects).slice();
    const editor = new SessionDocumentEditor();
    await editor.edit(doc, 'shared-content', async staged => {
      await updatePageContent(staged.pages[0].contentRefs, encoder.encode('q 1 0 0 1 88 88 cm Q'), staged.objects, false);
    });
    const reopened = await parsePDF(await saveQuick(doc, new Set(doc.pages[0].contentRefs.map(ref => ref.toKey()))));
    expect(decoder.decode(getPageContentBytes(reopened.pages[0], reopened.objects))).toContain('88 88');
    expect(getPageContentBytes(reopened.pages[1], reopened.objects)).toEqual(before);
  });

  it('rejects a stream modified during compression without overwriting the intervening work', async () => {
    const doc = await fixture('single'), page = doc.pages[0], ref = page.contentRefs[0];
    const pending = updatePageContent(page.contentRefs, encoder.encode('q 0 0 1 rg Q'), doc.objects, false);
    const intervening = new PDFStream(new PDFDict(), encoder.encode('INTERVENING'));
    doc.objects.set(ref.toKey(), intervening);
    await expect(pending).rejects.toThrow(/changed during/);
    expect(doc.objects.get(ref.toKey())).toBe(intervening);
    expect(doc.pages[0].contentRefs[0].toKey()).toBe(ref.toKey());
  });

  it.each(['page-reference', 'page-membership', 'contents-array', 'stream-bytes', 'decoded-cache'] as const)(
    'rejects %s changes during compression without publishing an edit', async change => {
      const doc = await fixture('direct-array'), page = doc.pages[0];
      const oldRef = page.contentRefs[0], oldStream = doc.objects.get(oldRef.toKey()) as PDFStream;
      const pending = updatePageContent(page.contentRefs, encoder.encode('q 0 0 1 rg Q'), doc.objects, false);
      if (change === 'page-reference') page.ref = new PDFRef(99, 0);
      else if (change === 'page-membership') doc.pages = [doc.pages[1]];
      else if (change === 'contents-array') (page.dict.get('Contents') as PDFArray).items.reverse();
      else if (change === 'stream-bytes') oldStream.rawBytes[0] ^= 1;
      else oldStream.decodedBytes = encoder.encode('intervening');
      await expect(pending).rejects.toThrow();
      expect(doc.objects.get(oldRef.toKey())).toBe(oldStream);
      expect(page.contentRefs[0].toKey()).toBe(oldRef.toKey());
    },
  );

  it('isolates a new alias introduced during compression', async () => {
    const doc = await fixture('single'), page = doc.pages[0], other = doc.pages[1];
    other.dict.set('Contents', new PDFRef(6, 0));
    other.contentRefs.splice(0, other.contentRefs.length, new PDFRef(6, 0));
    const old = page.contentRefs[0], original = getPageContentBytes(page, doc.objects).slice();
    const pending = updatePageContent(page.contentRefs, encoder.encode('q 0 0 1 rg Q'), doc.objects, false);
    doc.catalog.set('LateAlias', old);
    await pending;
    expect(page.contentRefs[0].toKey()).not.toBe(old.toKey());
    expect((doc.objects.get(old.toKey()) as PDFStream).rawBytes).toEqual(original);
    expect(doc.catalog.get('LateAlias')).toBe(old);
  });

  it('reuses an independently owned stream during repeated edits', async () => {
    const doc = await fixture('single'), page = doc.pages[0];
    await updatePageContent(page.contentRefs, encoder.encode('q Q'), doc.objects, false);
    const key = page.contentRefs[0].toKey(), count = doc.objects.size;
    for (let i = 0; i < 100; i++) await updatePageContent(page.contentRefs, encoder.encode(`q ${i} 0 0 1 0 0 cm Q`), doc.objects, false);
    expect(page.contentRefs[0].toKey()).toBe(key);
    expect(doc.objects.size).toBe(count);
    const reopened = await parsePDF(await saveOptimized(doc));
    expect(decoder.decode(getPageContentBytes(reopened.pages[0], reopened.objects))).toContain('99 0 0 1');
  });

  it('keeps unbound independent streams editable and rejects visible sharing', async () => {
    const ref = new PDFRef(1, 0), bytes = encoder.encode('old');
    const objects = new Map([['1_0', new PDFStream(new PDFDict(), bytes)]]) as Map<string, import('../types').PDFObject>;
    await updatePageContent([ref], encoder.encode('new'), objects, false);
    expect(decoder.decode((objects.get('1_0') as PDFStream).rawBytes)).toBe('new');
    objects.set('2_0', new PDFDict([['Contents', ref]]));
    objects.set('3_0', new PDFDict([['Contents', ref]]));
    await expect(updatePageContent([ref], encoder.encode('bad'), objects, false)).rejects.toThrow(/shared/);
    expect(decoder.decode((objects.get('1_0') as PDFStream).rawBytes)).toBe('new');
  });

  it('rejects an unbound stream used only as an XObject', async () => {
    const ref = new PDFRef(1, 0), original = new PDFStream(new PDFDict(), encoder.encode('image'));
    const objects = new Map<string, import('../types').PDFObject>([['1_0', original], ['2_0', new PDFDict([['XObject', ref]])]]);
    await expect(updatePageContent([ref], encoder.encode('bad'), objects, false)).rejects.toThrow(/shared/);
    expect(objects.get('1_0')).toBe(original);
  });

  it('allows an unbound copy of an independently owned multi-stream page', async () => {
    const doc = await fixture('direct-array');
    doc.pages[1].dict.set('Contents', new PDFArray());
    doc.pages[1].contentRefs.splice(0);
    doc.objects.delete('7_0');
    doc.objects.delete('8_0');
    await updatePageContent([...doc.pages[0].contentRefs], encoder.encode('q Q'), doc.objects, false);
    expect(decoder.decode(getPageContentBytes(doc.pages[0], doc.objects))).toBe('q Q ');
  });

  it('rejects an indirect stream dictionary dependency changed during compression', async () => {
    const doc = await fixture('single'), page = doc.pages[0];
    const old = doc.objects.get(page.contentRefs[0].toKey()) as PDFStream;
    old.dict.set('Filter', new PDFRef(9, 0));
    doc.objects.set('9_0', new PDFArray());
    const pending = updatePageContent(page.contentRefs, encoder.encode('q Q'), doc.objects, false);
    doc.objects.set('9_0', new PDFArray([new PDFRef(6, 0)]));
    await expect(pending).rejects.toThrow(/changed during/);
    expect(doc.objects.get(page.contentRefs[0].toKey())).toBe(old);
  });

  it.each(['invalid-stream', 'invalid-array', 'cyclic-reference'] as const)(
    'opens %s without treating an incomplete cache as complete, including worker roundtrip', async kind => {
      const content = kind === 'invalid-stream' ? '/Bad' : kind === 'invalid-array' ? '[6 0 R /Bad]' : '7 0 R';
      const pdf = rawPDF([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 5 0 R >>',
        'null', content, stream('q Q'), '5 0 R',
      ]);
      const parsed = await parsePDF(pdf);
      expect(parsed.pages[0].contentInspectionComplete).toBe(false);
      const doc = hydrateDocument(dehydrateDocument(parsed));
      expect(doc.pages[0].contentInspectionComplete).toBe(false);
      expect(() => getPageContentBytes(doc.pages[0], doc.objects)).toThrow(/cannot be fully inspected/i);
      const before = doc.pages[0].dict.get('Contents');
      await expect(updatePageContent(doc.pages[0].contentRefs, encoder.encode('q Q'), doc.objects, false)).rejects.toThrow();
      expect(doc.pages[0].dict.get('Contents')).toBe(before);
      doc.objects.set('5_0', new PDFStream(new PDFDict(), encoder.encode('q Q')));
      expect(decoder.decode(getPageContentBytes(doc.pages[0], doc.objects))).toBe('q Q');
      expect(doc.pages[0].contentInspectionComplete).toBe(true);
      await updatePageContent(doc.pages[0].contentRefs, encoder.encode('q 1 0 0 1 1 1 cm Q'), doc.objects, false);
      expect(decoder.decode(getPageContentBytes(doc.pages[0], doc.objects))).toContain('1 1');
    },
  );

  it('reads an old worker snapshot without the optional inspection status', async () => {
    const doc = await fixture('indirect-array'), wire = dehydrateDocument(doc);
    for (const page of wire.pages) delete page.contentInspectionComplete;
    const reopened = hydrateDocument(wire);
    expect(reopened.pages[0].contentInspectionComplete).toBeUndefined();
    expect(getPageContentBytes(reopened.pages[0], reopened.objects).length).toBeGreaterThan(0);
  });

  it('attaches new content to a page whose indirect content array is empty', async () => {
    const doc = await parsePDF(rawPDF([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 5 0 R >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 5 0 R >>',
      '[]',
    ]));
    await updatePageContent(doc.pages[0].contentRefs, encoder.encode('q Q'), doc.objects, false);
    expect(getPageContentBytes(doc.pages[1], doc.objects)).toHaveLength(0);
    const reopened = await parsePDF(await saveQuick(doc, new Set(doc.pages[0].contentRefs.map(ref => ref.toKey()))));
    expect(decoder.decode(getPageContentBytes(reopened.pages[0], reopened.objects))).toBe('q Q');
    expect(getPageContentBytes(reopened.pages[1], reopened.objects)).toHaveLength(0);
  });
});
