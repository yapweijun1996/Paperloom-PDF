import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';
import { PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, PDFString } from '../types';
import { sanitizationEngine } from '../security/sanitization/sanitization-engine';
import { saveQuick } from '../writer/save-pipeline';

const options = { metadata: true, javascript: false, embeddedFiles: false, comments: false,
  annotations: false, unusedObjects: false, hiddenLayers: false, alternativeImages: false };

async function fixture() {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  const info = doc.xref.trailerDict.getRef('Info');
  if (info) doc.objects.delete(info.toKey());
  doc.xref.trailerDict.delete('Info');
  doc.info = {};
  return doc;
}

describe('sanitization metadata reports', () => {
  it('does not report metadata removal when no metadata is present', async () => {
    const doc = await fixture();
    const result = await sanitizationEngine.sanitize(doc, options);
    expect(result.detail.metadataRemoved).toBe(false);
    expect(result.report).toEqual(['Nothing to sanitize']);
  });

  it('reports only document information when no XMP is present', async () => {
    const doc = await fixture();
    doc.xref.trailerDict.set('Info', new PDFDict([['Title', new PDFString('PRIVATE')]]));
    const result = await sanitizationEngine.sanitize(doc, options);
    expect(result.detail.metadataRemoved).toBe(true);
    expect(result.report.join(' ')).toMatch(/information/i);
    expect(result.report.join(' ')).not.toMatch(/XMP|component/i);
    const saved = await saveQuick(doc);
    expect((await PDFDocument.load(saved, { updateMetadata: false })).getTitle()).toBeUndefined();
    const reopened = await parsePDF(saved);
    expect((reopened.xref.trailerDict.get('Info') as PDFDict).size).toBe(0);
  });

  it('reports removal when only component XMP is present', async () => {
    const doc = await fixture();
    const ref = new PDFRef(900, 0), bytes = new TextEncoder().encode('PRIVATE-COMPONENT-XMP');
    doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([
      ['Type', new PDFName('Metadata')], ['Subtype', new PDFName('XML')], ['Length', new PDFNumber(bytes.length)],
    ]), bytes, bytes));
    doc.pages[0].dict.set('Metadata', ref);
    const result = await sanitizationEngine.sanitize(doc, options);
    expect(result.detail.metadataRemoved).toBe(true);
    expect(result.report.join(' ')).toMatch(/component/i);
    expect(result.report.join(' ')).not.toMatch(/document information/i);
    const saved = await saveQuick(doc);
    expect(new TextDecoder().decode(saved)).not.toContain('PRIVATE-COMPONENT-XMP');
    expect((await PDFDocument.load(saved, { updateMetadata: false })).getPageCount()).toBe(1);
    expect((await parsePDF(saved)).pages[0].dict.has('Metadata')).toBe(false);
  });

  it('reports document XMP without claiming document information was removed', async () => {
    const doc = await fixture();
    const ref = new PDFRef(900, 0), bytes = new TextEncoder().encode('PRIVATE-DOCUMENT-XMP');
    doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([
      ['Type', new PDFName('Metadata')], ['Subtype', new PDFName('XML')], ['Length', new PDFNumber(bytes.length)],
    ]), bytes, bytes));
    doc.catalog.set('Metadata', ref);
    const result = await sanitizationEngine.sanitize(doc, options);
    expect(result.detail.metadataRemoved).toBe(true);
    expect(result.report.join(' ')).toMatch(/document XMP/i);
    expect(result.report.join(' ')).not.toMatch(/information|component/i);
    const saved = await saveQuick(doc);
    expect(new TextDecoder().decode(saved)).not.toContain('PRIVATE-DOCUMENT-XMP');
    expect((await PDFDocument.load(saved, { updateMetadata: false })).getPageCount()).toBe(1);
    expect((await parsePDF(saved)).catalog.has('Metadata')).toBe(false);
  });
});
