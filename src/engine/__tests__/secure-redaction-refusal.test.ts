import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { getPageContentBytes, parsePDF } from '../parser/parser';
import { updatePageContent } from '../editor/stream-compiler';
import { redactionEngine, UnsupportedSecureRedactionError } from '../security/redaction/redaction-engine';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream } from '../types';
import { getNextObjNum, serializeDocument } from '../writer/serializer';

async function fixture() {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]).drawText('FIRST PAGE');
  pdf.addPage([200, 200]).drawText('SECOND PAGE');
  return parsePDF(await pdf.save({ useObjectStreams: false }));
}

describe('secure redaction refuses unsupported exports', () => {
  it('preserves vector paths, image resources, source bytes and every mark across pages', async () => {
    const doc = await fixture();
    const imageBytes = new TextEncoder().encode('SENSITIVE_IMAGE_BYTES');
    const imageRef = new PDFRef(getNextObjNum(doc), 0);
    doc.objects.set(imageRef.toKey(), new PDFStream(new PDFDict([
      ['Type', new PDFName('XObject')], ['Subtype', new PDFName('Image')],
      ['Width', new PDFNumber(1)], ['Height', new PDFNumber(1)],
      ['Length', new PDFNumber(imageBytes.length)],
    ]), imageBytes, imageBytes));
    doc.pages[1].resources.set('XObject', new PDFDict([['Im1', imageRef]]));
    await updatePageContent(doc.pages[0].contentRefs, new TextEncoder().encode('0 0 30 30 re f'), doc.objects, false);
    await updatePageContent(doc.pages[1].contentRefs, new TextEncoder().encode('q 30 0 0 30 0 0 cm /Im1 Do Q'), doc.objects, false);
    const marks = doc.pages.map((_, pageIndex) => redactionEngine.markRegion(doc, pageIndex, { x: 0, y: 0, width: 30, height: 30 }));
    const before = await serializeDocument(doc);
    const original = doc.rawBytes.slice();

    await expect(redactionEngine.applySecureRedactions(doc, { images: false, vectors: false }))
      .rejects.toBeInstanceOf(UnsupportedSecureRedactionError);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.rawBytes).toEqual(original);
    expect(new TextDecoder().decode(getPageContentBytes(doc.pages[0], doc.objects))).toContain('re f');
    expect(new TextDecoder().decode(getPageContentBytes(doc.pages[1], doc.objects))).toContain('/Im1 Do');
    expect((doc.objects.get(imageRef.toKey()) as PDFStream).rawBytes).toEqual(imageBytes);
    for (const ref of marks) expect(doc.objects.has(ref.toKey())).toBe(true);
  });

  it('returns an honest no-op when there are no marks', async () => {
    const doc = await fixture();
    const before = await serializeDocument(doc);
    expect(await redactionEngine.applySecureRedactions(doc)).toMatchObject({
      pagesProcessed: 0, textOperatorsRemoved: 0, imageOperatorsRemoved: 0,
      pathOperatorsRemoved: 0, metadataStripped: false,
    });
    expect(await serializeDocument(doc)).toEqual(before);
    await expect(redactionEngine.applySecureRedactions(doc, { metadata: true }))
      .rejects.toBeInstanceOf(UnsupportedSecureRedactionError);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('fails closed when annotations cannot be examined', async () => {
    const doc = await fixture();
    doc.pages[0].dict.set('Annots', new PDFArray([new PDFRef(987654, 0)]));
    const before = await serializeDocument(doc);
    await expect(redactionEngine.applySecureRedactions(doc)).rejects.toBeInstanceOf(UnsupportedSecureRedactionError);
    expect(await serializeDocument(doc)).toEqual(before);
    const cyclic = new PDFRef(987655, 0);
    doc.objects.set(cyclic.toKey(), cyclic);
    doc.pages[0].dict.set('Annots', cyclic);
    await expect(redactionEngine.applySecureRedactions(doc)).rejects.toBeInstanceOf(UnsupportedSecureRedactionError);
  });
});
