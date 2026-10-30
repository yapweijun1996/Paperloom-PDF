import { expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import * as engine from '@/engine/browser-core';
import { parsePDF } from '@/engine/parser/parser';
import { serializeDocument } from '@/engine/writer/serializer';
import { PDFDict, PDFName } from '@/engine/types';
import { updatePageContent } from '@/engine/editor/stream-compiler';
import { SessionDocumentEditor } from '@/engine/session/document-edit';
import { replaceSearchMatches } from './search-index';

it('rolls back a late update failure from Replace All through the actual editor transaction', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([500,500]); pdf.addPage([500,500]);
  let doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  for (const page of doc.pages) {
    page.resources.set('Font', new PDFDict([['F1', new PDFDict([
      ['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')], ['BaseFont', new PDFName('Helvetica')],
    ])]]));
    await updatePageContent(page.contentRefs, new TextEncoder().encode('BT /F1 12 Tf (HELLO) Tj ET'), doc.objects, false);
  }
  doc = await parsePDF(await serializeDocument(doc));
  const before = await serializeDocument(doc);
  let updates = 0;
  const failSecond: typeof engine.updatePageContent = async (...args) => {
    if (++updates === 2) throw new Error('injected failure');
    return engine.updatePageContent(...args);
  };
  await expect(new SessionDocumentEditor().edit(doc, 'replace-all', async staged => {
    await replaceSearchMatches(staged, 'HELLO', 'THERE', true, { ...engine, updatePageContent: failSecond });
  })).rejects.toThrow('injected failure');
  expect(updates).toBe(2);
  expect(await serializeDocument(doc)).toEqual(before);
});
