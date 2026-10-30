import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { parsePDF, getPageContentBytes } from '../parser/parser';
import { PDFDict, PDFNumber, PDFRef, PDFStream } from '../types';
import { updatePageContent } from '../editor/stream-compiler';
import { extractPages, insertPagesFromDocument } from '../writer/page-operations';
import { serializeDocument } from '../writer/serializer';

async function page() {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  return parsePDF(await pdf.save({ useObjectStreams: false }));
}
const text = (value: string) => new TextEncoder().encode(value);
const read = (doc: Awaited<ReturnType<typeof page>>, index: number) =>
  new TextDecoder().decode(getPageContentBytes(doc.pages[index], doc.objects));

describe('independent page content integrity', () => {
  it('preserves and edits a root Contents reference alias without changing a colliding target', async () => {
    const source = await page(), target = await page();
    const streamRef = new PDFRef(900, 0), alias = new PDFRef(901, 0);
    const original = text('source contents');
    source.objects.set(streamRef.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(original.length)]]), original, original));
    source.objects.set(alias.toKey(), streamRef);
    source.pages[0].dict.set('Contents', alias);
    source.pages[0].contentRefs.splice(0, source.pages[0].contentRefs.length, streamRef);
    const different = text('target contents');
    target.objects.set(streamRef.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(different.length)]]), different, different));
    const sourceBefore = await serializeDocument(source);
    const extracted = extractPages(source, [0]);
    insertPagesFromDocument(target, source, 1);
    for (const [doc, index] of [[extracted, 0], [target, 1]] as const) {
      expect(read(doc, index)).toBe('source contents');
      await updatePageContent(doc.pages[index].contentRefs, text('updated contents'), doc.objects, false);
      expect(read(await parsePDF(await serializeDocument(doc)), index)).toBe('updated contents');
    }
    expect(new TextDecoder().decode((target.objects.get(streamRef.toKey()) as PDFStream).getBytes())).toBe('target contents');
    expect(await serializeDocument(source)).toEqual(sourceBefore);
  });

  it('rejects cyclic content aliases before changing target', async () => {
    const source = await page(), target = await page();
    const a = new PDFRef(900, 0), b = new PDFRef(901, 0);
    source.objects.set(a.toKey(), b); source.objects.set(b.toKey(), a);
    source.pages[0].dict.set('Contents', a);
    source.pages[0].contentRefs.splice(0, source.pages[0].contentRefs.length, a);
    const before = await serializeDocument(target);
    expect(() => extractPages(source, [0])).toThrow(/page content/i);
    expect(() => insertPagesFromDocument(target, source, 1)).toThrow(/page content/i);
    expect(await serializeDocument(target)).toEqual(before);
  });

  it('rejects a generation mismatch in cached content without changing target', async () => {
    const source = await page(), target = await page();
    const contents = new PDFRef(900, 0), bytes = text('abc');
    source.objects.set(contents.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(bytes.length)]]), bytes, bytes));
    source.pages[0].dict.set('Contents', contents);
    source.pages[0].contentRefs.splice(0, source.pages[0].contentRefs.length, new PDFRef(900, 1));
    const before = await serializeDocument(target);
    expect(() => extractPages(source, [0])).toThrow(/content cache/i);
    expect(() => insertPagesFromDocument(target, source, 1)).toThrow(/content cache/i);
    expect(await serializeDocument(target)).toEqual(before);
  });
});
