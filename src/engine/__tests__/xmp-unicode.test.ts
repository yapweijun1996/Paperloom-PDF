import { PDFDocument, PDFName as LibName, PDFRawStream } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';
import { metadataEngine } from '../security/metadata/metadata-engine';
import { PDFDict, PDFName, PDFNumber, PDFRef, PDFStream } from '../types';
import { serializeDocument } from '../writer/serializer';

async function fixture() {
  const source = await PDFDocument.create();
  source.addPage([100, 100]);
  return parsePDF(await source.save({ useObjectStreams: false }));
}

describe('XMP metadata Unicode', () => {
  it('preserves multilingual text and supplementary characters after save and independent reopen', async () => {
    const doc = await fixture();
    const xml = '<?xml version="1.0" encoding="UTF-8"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><title>你好 résumé 😀</title></x:xmpmeta>';
    metadataEngine.setXmp(doc, xml);
    const saved = await serializeDocument(doc);
    expect(metadataEngine.readXmp(await parsePDF(saved))).toBe(xml);
    const independent = await PDFDocument.load(saved);
    const stream = independent.catalog.lookup(LibName.of('Metadata'));
    expect(stream).toBeInstanceOf(PDFRawStream);
    expect(new TextDecoder('utf-8', { fatal: true }).decode((stream as PDFRawStream).contents)).toBe(xml);
  });

  it.each([['le', true], ['be', true], ['le', false], ['be', false]] as const)('reads UTF-16%s XMP with BOM=%s after save and reopen', async (endian, bom) => {
    const doc = await fixture();
    const xml = '<?xml version="1.0" encoding="UTF-16"?><xmp>你好 résumé 😀</xmp>';
    const offset = bom ? 2 : 0;
    const bytes = new Uint8Array(offset + xml.length * 2);
    if (bom) bytes.set(endian === 'le' ? [0xff, 0xfe] : [0xfe, 0xff]);
    for (let index = 0; index < xml.length; index++) {
      const code = xml.charCodeAt(index);
      bytes[offset + index * 2] = endian === 'le' ? code & 255 : code >>> 8;
      bytes[offset + 1 + index * 2] = endian === 'le' ? code >>> 8 : code & 255;
    }
    const ref = new PDFRef(900, 0);
    doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([
      ['Type', new PDFName('Metadata')], ['Subtype', new PDFName('XML')], ['Length', new PDFNumber(bytes.length)],
    ]), bytes));
    doc.catalog.set('Metadata', ref);
    expect(metadataEngine.readXmp(await parsePDF(await serializeDocument(doc)))).toBe(xml);
  });

  it.each(['UTF-16', 'UTF-16LE', 'UTF-16BE'])('writes declared %s XML without corrupting characters', async encoding => {
    const doc = await fixture();
    const xml = `<?xml version="1.0" encoding="${encoding}"?><xmp>你好 😀</xmp>`;
    metadataEngine.setXmp(doc, xml);
    expect(metadataEngine.readXmp(await parsePDF(await serializeDocument(doc)))).toBe(xml);
  });

  it('rejects an incompatible declared encoding without changing existing metadata', async () => {
    const doc = await fixture();
    metadataEngine.setXmp(doc, '<xmp>existing</xmp>');
    const before = await serializeDocument(doc);
    expect(() => metadataEngine.setXmp(doc, '<?xml version="1.0" encoding="ISO-8859-1"?><xmp>新</xmp>'))
      .toThrow(/UTF-8/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(() => metadataEngine.setXmp(doc, '<xmp>\ud800</xmp>')).toThrow(/surrogate/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });
});
