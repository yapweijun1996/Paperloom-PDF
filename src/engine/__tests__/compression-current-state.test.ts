import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { parsePDF } from '../parser/parser';
import { PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, PDFString } from '../types';
import { compressDocumentImages } from '../optimize/image-compress';
import { serializeDocument, serializeDocumentCompact } from '../writer/serializer';
import { javaScriptSecurityEngine } from '../security/javascript/javascript-engine';

function tinyFixture(): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += 'xref\n0 4\n0000000000 65535 f \n';
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

async function editedFixture() {
  const source = await PDFDocument.create();
  source.addPage([200, 200]);
  const doc = await parsePDF(await source.save({ useObjectStreams: false }));
  // Make the current page content larger than the tiny uploaded document.
  let seed = 123;
  const lines = ['q 1 0 0 rg 10 10 20 20 re f Q'];
  for (let i = 0; i < 500; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    lines.push(`% edited content ${seed}`);
  }
  const content = new TextEncoder().encode(lines.join('\n'));
  const ref = new PDFRef(20, 0);
  doc.objects.set(ref.toKey(), new PDFStream(
    new PDFDict([['Length', new PDFNumber(content.length)]]), content,
  ));
  doc.pages[0].dict.set('Contents', ref);
  doc.pages[0].contentRefs = [ref];
  return { doc, content };
}

describe('compression of the current document', () => {
  it('never grows a tiny upload explicitly known to be current', async () => {
    const input = tinyFixture();
    const doc = await parsePDF(input);
    expect((await serializeDocumentCompact(doc)).length).toBeGreaterThan(input.length);

    const result = await compressDocumentImages(doc, {
      quality: 0.7, dpi: 150, originalIsCurrent: true,
    });
    expect(result.bytes.length).toBeLessThanOrEqual(input.length);
    const reopened = await parsePDF(result.bytes);
    expect(reopened.pages[0].mediaBox).toEqual(doc.pages[0].mediaBox);
  });

  it.each([undefined, false])('retains edited content with originalIsCurrent=%s even when the upload is smaller', async (originalIsCurrent) => {
    const { doc, content } = await editedFixture();
    const baseline = await serializeDocumentCompact(doc);
    expect(baseline.length).toBeGreaterThan(doc.rawBytes.length);

    const result = await compressDocumentImages(doc, { quality: 0.7, dpi: 150, originalIsCurrent });
    const reopened = await parsePDF(result.bytes);
    const stream = reopened.objects.get(reopened.pages[0].contentRefs[0].toKey());
    expect(stream).toBeInstanceOf(PDFStream);
    expect((stream as PDFStream).getBytes()).toEqual(content);
  });

  it('never returns original bytes after cleanup even when the caller says they are current', async () => {
    const source = await parsePDF(tinyFixture());
    source.catalog.set('OpenAction', new PDFDict([
      ['S', new PDFName('JavaScript')], ['JS', new PDFString('HISTORICAL_SCRIPT_MARKER')],
    ]));
    const doc = await parsePDF(await serializeDocument(source));
    expect(new TextDecoder().decode(doc.rawBytes)).toContain('HISTORICAL_SCRIPT_MARKER');
    javaScriptSecurityEngine.removeJavaScript(doc);
    const { doc: edited, content } = await editedFixture();
    const contentRef = edited.pages[0].contentRefs[0];
    doc.objects.set(contentRef.toKey(), edited.objects.get(contentRef.toKey())!);
    doc.pages[0].dict.set('Contents', contentRef);
    doc.pages[0].contentRefs = [contentRef];
    expect((await serializeDocumentCompact(doc)).length).toBeGreaterThan(doc.rawBytes.length);

    const output = await compressDocumentImages(doc, { quality: 0.7, dpi: null, originalIsCurrent: true });
    expect(new TextDecoder().decode(output.bytes)).not.toContain('HISTORICAL_SCRIPT_MARKER');
    expect(output.method).not.toBe('unchanged');
    const reopened = await parsePDF(output.bytes);
    expect((reopened.objects.get(reopened.pages[0].contentRefs[0].toKey()) as PDFStream).getBytes()).toEqual(content);
    expect(javaScriptSecurityEngine.analyze(reopened).hasJavaScript).toBe(false);
  });

  it('preserves a signed source byte-for-byte and refuses compression after edits or cleanup', async () => {
    const source = tinyFixture();
    const marker = new TextEncoder().encode('\n% /ByteRange [0 10 20 10] /Contents <01020304>\n');
    const signedBytes = new Uint8Array(source.length + marker.length);
    signedBytes.set(source);
    signedBytes.set(marker, source.length);
    const doc = await parsePDF(signedBytes);
    const result = await compressDocumentImages(doc, { quality: 0.7, dpi: 150 });
    expect(result.bytes).toEqual(signedBytes);
    expect(result.message).toMatch(/signed.*unchanged/i);

    doc.pages[0].dict.set('Rotate', new PDFNumber(90));
    await expect(compressDocumentImages(doc, { quality: 0.7, dpi: 150 })).rejects.toMatchObject({
      name: 'SignedDocumentEditError',
    });
    const cleaned = await parsePDF(signedBytes);
    cleaned.requiresFullRewrite = true;
    await expect(compressDocumentImages(cleaned, { quality: 0.7, dpi: null, originalIsCurrent: true }))
      .rejects.toMatchObject({ name: 'SignedDocumentEditError' });
  });
});
