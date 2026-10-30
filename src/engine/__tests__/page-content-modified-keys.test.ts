import { describe, expect, it } from 'vitest';
import { parsePDF, getPageContentBytes } from '../parser/parser';
import { pageContentModifiedKeys, updatePageContent } from '../editor/stream-compiler';
import { saveQuick } from '../writer/save-pipeline';
import { SessionDocumentEditor } from '../session/document-edit';
import { PDFStream } from '../types';
import { rawPDF } from './audit-p1-fixtures';

const encoder = new TextEncoder(), decoder = new TextDecoder();
const stream = (text: string) => `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;
async function fixture(multiple: boolean) {
  return parsePDF(rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents ${multiple ? '[5 0 R 6 0 R]' : '5 0 R'} >>`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 7 0 R >>',
    stream('q 1 0 0 1 10 10 cm Q'), stream('q 1 0 0 1 20 20 cm Q'), stream('q 1 0 0 1 30 30 cm Q'),
  ]));
}

describe('page content modified keys', () => {
  it.each([false, true])('persists unbound %s-stream edits through explicit incremental saves', async multiple => {
    const doc = await fixture(multiple), page = doc.pages[0];
    const refs = [...page.contentRefs], oldKeys = refs.map(ref => ref.toKey());
    await updatePageContent(refs, encoder.encode('q 1 0 0 1 99 99 cm Q'), doc.objects, false);
    expect([...pageContentModifiedKeys(doc.objects)]).toEqual(expect.arrayContaining(oldKeys));
    const reopened = await parsePDF(await saveQuick(doc, new Set([doc.pages[1].ref.toKey()])));
    expect(decoder.decode(getPageContentBytes(reopened.pages[0], reopened.objects)).trim()).toBe('q 1 0 0 1 99 99 cm Q');
    expect(decoder.decode(getPageContentBytes(reopened.pages[1], reopened.objects))).toContain('30 30');
  });

  it('transfers in-place multi-stream changes from a session draft to the live document', async () => {
    const doc = await fixture(true), keys = doc.pages[0].contentRefs.map(ref => ref.toKey());
    await new SessionDocumentEditor().edit(doc, 'content', async staged => {
      await updatePageContent(staged.pages[0].contentRefs, encoder.encode('q 1 0 0 1 88 88 cm Q'), staged.objects, false);
    });
    expect([...pageContentModifiedKeys(doc.objects)]).toEqual(expect.arrayContaining(keys));
    const reopened = await parsePDF(await saveQuick(doc, new Set([doc.pages[1].ref.toKey()])));
    expect(decoder.decode(getPageContentBytes(reopened.pages[0], reopened.objects)).trim()).toBe('q 1 0 0 1 88 88 cm Q');
  });

  it('does not register a byte-identical in-place update as modified', async () => {
    const doc = await fixture(false), page = doc.pages[0], old = doc.objects.get(page.contentRefs[0].toKey());
    await updatePageContent(page.contentRefs, encoder.encode('q 1 0 0 1 10 10 cm Q'), doc.objects, false);
    expect([...pageContentModifiedKeys(doc.objects)]).toEqual([]);
    expect(doc.objects.get(page.contentRefs[0].toKey())).toBe(old);
  });

  it('refreshes a stale decoded cache without registering unchanged serialized bytes', async () => {
    const doc = await fixture(false), page = doc.pages[0];
    const stream = doc.objects.get(page.contentRefs[0].toKey()) as PDFStream;
    stream.decodedBytes = encoder.encode('stale');
    await updatePageContent(page.contentRefs, encoder.encode('q 1 0 0 1 10 10 cm Q'), doc.objects, false);
    expect(decoder.decode(getPageContentBytes(page, doc.objects))).toBe('q 1 0 0 1 10 10 cm Q');
    expect([...pageContentModifiedKeys(doc.objects)]).toEqual([]);
  });
});
