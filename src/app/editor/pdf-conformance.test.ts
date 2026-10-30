// @vitest-environment happy-dom
import { deflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parsePDF } from '@/engine/parser/parser';
import { PDFDict, PDFName, PDFRef, PDFStream, PDFString } from '@/engine/types';
import { serializeDocument } from '@/engine/writer/serializer';
import { detectPdfConformance } from './pdf-conformance';

const claim = `<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:RDF><rdf:Description xmlns:a="http://www.aiim.org/pdfa/ns/id/" a:part="2"><u:part xmlns:u="http://www.aiim.org/pdfua/ns/id/">1</u:part></rdf:Description></rdf:RDF></x:xmpmeta>`;

async function fixture(xml: string, compressed = false) {
  const input = await PDFDocument.create();
  input.addPage();
  const doc = await parsePDF(await input.save({ useObjectStreams: false }));
  const dict = new PDFDict([['Type', new PDFName('Metadata')], ['Subtype', new PDFName('XML')]]);
  const raw = new TextEncoder().encode(xml);
  if (compressed) dict.set('Filter', new PDFName('FlateDecode'));
  const stream = new PDFStream(dict, compressed ? deflateSync(raw) : raw);
  const id = Math.max(...Array.from(doc.objects.keys(), key => Number(key.split('_')[0]))) + 1;
  const ref = new PDFRef(id, 0);
  doc.objects.set(ref.toKey(), stream);
  doc.catalog.set('Metadata', ref);
  return parsePDF(await serializeDocument(doc));
}

describe('PDF conformance declarations', () => {
  it.each([false, true])('detects namespaced attribute and element claims after save/reopen (compressed=%s)', async compressed => {
    const doc = await fixture(claim, compressed);
    expect(detectPdfConformance(doc)).toEqual({ status: 'claimed', formats: ['PDF/A', 'PDF/UA'] });
  });

  it('reports no declaration only for readable XMP without a claimed namespace', async () => {
    const doc = await fixture('<xmp xmlns="urn:example"><part>1</part></xmp>');
    expect(detectPdfConformance(doc)).toEqual({ status: 'none' });
    doc.catalog.delete('Metadata');
    expect(detectPdfConformance(doc)).toEqual({ status: 'none' });
  });

  it('reports unknown for malformed, unresolved, filtered-but-undecoded and oversized metadata', async () => {
    const doc = await fixture('<not-closed>');
    expect(detectPdfConformance(doc)).toEqual({ status: 'unknown' });
    doc.catalog.set('Metadata', new PDFRef(999999, 0));
    expect(detectPdfConformance(doc)).toEqual({ status: 'unknown' });
    doc.catalog.set('Metadata', new PDFString('not a stream'));
    expect(detectPdfConformance(doc)).toEqual({ status: 'unknown' });
    doc.catalog.set('Metadata', new PDFStream(new PDFDict([['Filter', new PDFName('FlateDecode')]]), new Uint8Array([1, 2])));
    expect(detectPdfConformance(doc)).toEqual({ status: 'unknown' });
    doc.catalog.set('Metadata', new PDFStream(new PDFDict(), new Uint8Array(2 * 1024 * 1024 + 1)));
    expect(detectPdfConformance(doc)).toEqual({ status: 'unknown' });
  });
});
