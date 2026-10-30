import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';
import { PDFArray, PDFHexString, PDFString } from '../types';
import { saveIncremental } from '../writer/incremental-writer';
import { serializeDocument } from '../writer/serializer';
import { saveQuick } from '../writer/save-pipeline';
import { serializeToString } from '../editor/stream-compiler';

const id = new PDFArray([
  new PDFHexString('00112233445566778899aabbccddeeff'),
  new PDFHexString('ffeeddccbbaa99887766554433221100'),
]);

async function fixture(withId = true) {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  if (withId) doc.xref.trailerDict.set('ID', id);
  else doc.xref.trailerDict.delete('ID');
  return parsePDF(await serializeDocument(doc));
}

describe('incremental PDF file identifiers', () => {
  it('keeps both identifier byte strings in every new trailer, including repeated revisions', async () => {
    let doc = await fixture();
    const expected = serializeToString(id);
    for (let revision = 0; revision < 3; revision++) {
      const prefix = doc.rawBytes.slice();
      const page = doc.pages[0];
      page.dict.set('RevisionMarker', new PDFString(`revision-${revision}`));
      const output = saveIncremental(doc, new Set([page.ref.toKey()]));
      expect(output.slice(0, prefix.length)).toEqual(prefix);
      const appended = Buffer.from(output.slice(prefix.length)).toString('latin1');
      expect(appended).toContain(`/ID ${expected}`);
      const independent = await PDFDocument.load(output);
      expect(independent.getPageCount()).toBe(1);
      expect(independent.context.trailerInfo.ID?.toString().replace(/\s/g, '').toLowerCase()).toBe(expected.replace(/\s/g, '').toLowerCase());
      doc = await parsePDF(output);
      expect(serializeToString(doc.xref.trailerDict.get('ID')!)).toBe(expected);
      expect(doc.pages[0].dict.getString('RevisionMarker')).toBe(`revision-${revision}`);
    }
  });

  it('preserves the identifier through quick-save incremental output', async () => {
    const doc = await fixture();
    const page = doc.pages[0];
    page.dict.set('RevisionMarker', new PDFString('quick'));
    const bytes = await saveQuick(doc, new Set([page.ref.toKey()]));
    expect(serializeToString((await parsePDF(bytes)).xref.trailerDict.get('ID')!)).toBe(serializeToString(id));
    expect((await PDFDocument.load(bytes)).context.trailerInfo.ID?.toString().replace(/\s/g, '').toLowerCase()).toBe(serializeToString(id).replace(/\s/g, '').toLowerCase());
  });

  it('does not invent an identifier for a document without one', async () => {
    const doc = await fixture(false);
    const bytes = saveIncremental(doc, new Set([doc.pages[0].ref.toKey()]));
    expect((await parsePDF(bytes)).xref.trailerDict.has('ID')).toBe(false);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });
});
