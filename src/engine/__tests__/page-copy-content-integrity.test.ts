import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { parsePDF, getPageContentBytes } from '../parser/parser';
import { PDFArray, PDFDict, PDFNumber, PDFRef, PDFStream, type PDFDocumentData } from '../types';
import { updatePageContent } from '../editor/stream-compiler';
import { extractPages, insertPagesFromDocument } from '../writer/page-operations';
import { serializeDocument } from '../writer/serializer';

const encode = (text: string) => new TextEncoder().encode(text);
const decoded = (doc: PDFDocumentData, index: number) => new TextDecoder().decode(getPageContentBytes(doc.pages[index], doc.objects));
const stream = (text: string) => {
  const bytes = encode(text);
  return new PDFStream(new PDFDict([['Length', new PDFNumber(bytes.length)]]), bytes, bytes);
};
async function document() {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 300]);
  return parsePDF(await pdf.save({ useObjectStreams: false }));
}
async function fixture() {
  const doc = await document();
  const one = new PDFRef(900, 0), two = new PDFRef(901, 0), arrayRef = new PDFRef(902, 0);
  doc.objects.set(one.toKey(), stream('first'));
  doc.objects.set(two.toKey(), stream('second'));
  doc.objects.set(arrayRef.toKey(), new PDFArray([one, two]));
  doc.pages[0].dict.set('Contents', arrayRef);
  doc.pages[0].contentRefs.splice(0, doc.pages[0].contentRefs.length, one, two);
  return { doc, one, two, arrayRef };
}

describe('page copy content ownership', () => {
  it('copies indirect arrays to independently mapped streams and retains editable content', async () => {
    const { doc, one } = await fixture();
    const target = await document();
    target.objects.set(one.toKey(), stream('unrelated target'));
    const beforeSource = await serializeDocument(doc);
    const copies = [extractPages(doc, [0])];
    insertPagesFromDocument(target, doc, 1);
    copies.push(target);
    for (const [index, copy] of copies.entries()) {
      const page = index === 0 ? 0 : 1;
      expect(decoded(copy, page)).toBe('first second');
      const reopened = await parsePDF(await serializeDocument(copy));
      expect(decoded(reopened, page)).toBe('first second');
      await updatePageContent(copy.pages[page].contentRefs, encode('edited content'), copy.objects, false);
      const edited = await parsePDF(await serializeDocument(copy));
      expect(decoded(edited, page)).toBe('edited content');
    }
    expect(new TextDecoder().decode((target.objects.get(one.toKey()) as PDFStream).getBytes())).toBe('unrelated target');
    expect(await serializeDocument(doc)).toEqual(beforeSource);
  });

  it('maps the resolved stream when an indirect array contains a reference alias', async () => {
    const { doc, one, two, arrayRef } = await fixture();
    const alias = new PDFRef(904, 0);
    doc.objects.set(alias.toKey(), one);
    doc.objects.set(arrayRef.toKey(), new PDFArray([alias, two]));
    const target = await document();
    const extracted = extractPages(doc, [0]);
    insertPagesFromDocument(target, doc, 1);
    for (const [copy, page] of [[extracted, 0], [target, 1]] as const) {
      expect(decoded(copy, page)).toBe('first second');
      const reopened = await parsePDF(await serializeDocument(copy));
      expect(decoded(reopened, page)).toBe('first second');
    }
  });

  it('copies an empty page and can attach content after copying', async () => {
    const source = await document(), target = await document();
    const extracted = extractPages(source, [0]);
    insertPagesFromDocument(target, source, 1);
    for (const [copy, page] of [[extracted, 0], [target, 1]] as const) {
      expect(decoded(copy, page)).toBe('');
      await updatePageContent(copy.pages[page].contentRefs, encode('new content'), copy.objects, false);
      const reopened = await parsePDF(await serializeDocument(copy));
      expect(decoded(reopened, page)).toBe('new content');
    }
  });

  it('preserves shared source streams and isolates edits after repeated insertion', async () => {
    const sourcePdf = await PDFDocument.create();
    sourcePdf.addPage([300, 300]); sourcePdf.addPage([300, 300]);
    const source = await parsePDF(await sourcePdf.save({ useObjectStreams: false }));
    const shared = new PDFRef(900, 0);
    source.objects.set(shared.toKey(), stream('shared'));
    for (const page of source.pages) {
      page.dict.set('Contents', shared);
      page.contentRefs.splice(0, page.contentRefs.length, shared);
    }
    const before = await serializeDocument(source), target = await document();
    insertPagesFromDocument(target, source, 1);
    insertPagesFromDocument(target, source, 3);
    expect(target.pages.slice(1).map((_page, index) => decoded(target, index + 1))).toEqual(['shared', 'shared', 'shared', 'shared']);
    await updatePageContent(target.pages[1].contentRefs, encode('changed'), target.objects, false);
    const reopened = await parsePDF(await serializeDocument(target));
    expect(reopened.pages.slice(1).map((_page, index) => decoded(reopened, index + 1))).toEqual(['changed', 'shared', 'shared', 'shared']);
    expect(await serializeDocument(source)).toEqual(before);
  });

  it.each(['added', 'removed', 'reordered', 'changed-graph', 'unresolved'] as const)(
    'refuses %s content inconsistency before modifying source or target', async variant => {
      const { doc, one, two, arrayRef } = await fixture();
      const target = await document();
      if (variant === 'added') doc.pages[0].contentRefs.push(one);
      if (variant === 'removed') doc.pages[0].contentRefs.pop();
      if (variant === 'reordered') doc.pages[0].contentRefs.reverse();
      if (variant === 'changed-graph') doc.pages[0].dict.set('Contents', two);
      if (variant === 'unresolved') doc.pages[0].dict.set('Contents', new PDFRef(903, 0));
      const sourceBefore = await serializeDocument(doc), targetBefore = await serializeDocument(target);
      expect(() => extractPages(doc, [0])).toThrow(/page content|content cache/i);
      expect(() => insertPagesFromDocument(target, doc, 1)).toThrow(/page content|content cache/i);
      expect(await serializeDocument(doc)).toEqual(sourceBefore);
      expect(await serializeDocument(target)).toEqual(targetBefore);
      expect(doc.objects.get(arrayRef.toKey())).toBeInstanceOf(PDFArray);
    },
  );
});
