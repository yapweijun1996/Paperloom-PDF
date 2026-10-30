import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName as LibName, PDFRawStream } from 'pdf-lib';
import { parsePDF } from '../parser/parser';
import { saveQuick, saveOptimized } from '../writer/save-pipeline';
import { saveQuick as saveWithWorker, resetPDFWorkerForTests } from '../worker/client';
import { PDFNumber, PDFRef, PDFString } from '../types';
import { metadataEngine } from '../security/metadata/metadata-engine';
import { securityEngine } from '../security';
import { serializeDocument } from '../writer/serializer';
import { handleWorkerCommand } from '../worker/handler';
import { dehydrateDocument } from '../worker/codec';
import { spawnSync } from 'node:child_process';

const originalXmp = `<?xpacket begin="\uFEFF"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:custom="urn:custom" xmp:ModifyDate='2001-01-01T00:00:00Z' custom:keep="原样 &amp; 😀"><pdf:Producer>Original producer</pdf:Producer><custom:field>unchanged &amp; retained</custom:field></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
async function fixture(xmp: string | null = originalXmp) {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.addPage();
  pdf.setProducer('Original producer');
  pdf.setModificationDate(new Date('2001-01-01T00:00:00Z'));
  if (xmp !== null) {
    const stream = pdf.context.stream(new TextEncoder().encode(xmp), { Type: 'Metadata', Subtype: 'XML' });
    pdf.catalog.set(LibName.of('Metadata'), pdf.context.register(stream));
  }
  return pdf.save({ useObjectStreams: false });
}
function edit(doc: Awaited<ReturnType<typeof parsePDF>>) {
  doc.catalog.set('Lang', PDFString.fromText('en'));
  const root = doc.xref.trailerDict.get('Root');
  if (!(root instanceof PDFRef)) throw new Error('missing root');
  return new Set([root.toKey()]);
}
async function independentlyRead(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const ref = pdf.catalog.get(LibName.of('Metadata'));
  const stream = ref ? pdf.context.lookup(ref) : undefined;
  return { producer: pdf.getProducer(), date: pdf.getModificationDate(), xmp: stream instanceof PDFRawStream ? new TextDecoder().decode(stream.contents) : null };
}

describe('save metadata', () => {
  it.each(['quick', 'optimized', 'worker'] as const)('synchronizes existing fields on %s edits and preserves other XMP', async mode => {
    const doc = await parsePDF(await fixture());
    const keys = edit(doc);
    const out = mode === 'quick' ? await saveQuick(doc, keys) : mode === 'worker' ? await saveWithWorker(doc, keys) : await saveOptimized(doc);
    const read = await independentlyRead(out);
    expect(read.producer).toBe('Paperloom PDF');
    expect(read.date).toBeInstanceOf(Date);
    const date = read.date!.toISOString().replace('.000Z', 'Z');
    expect(read.xmp).toBe(originalXmp.replace('2001-01-01T00:00:00Z', date).replace('Original producer', 'Paperloom PDF'));
    if (mode !== 'optimized') {
      expect(metadataEngine.readInfo(doc).Producer).toBe('Paperloom PDF');
      expect(metadataEngine.readXmp(doc)).toBe(read.xmp);
      const second = await saveQuick(doc, keys);
      expect((await independentlyRead(second)).xmp).toBe(read.xmp);
    }
  });
  it('does not recreate stripped fields and does not add metadata to an unedited document', async () => {
    const untouched = await parsePDF(await fixture());
    const noEdit = await independentlyRead(await saveOptimized(untouched));
    expect(noEdit.producer).toBe('Original producer');
    expect(noEdit.xmp).toBe(originalXmp);
    const stripped = await parsePDF(await fixture());
    metadataEngine.stripMetadata(stripped);
    stripped.requiresFullRewrite = true;
    edit(stripped);
    const read = await independentlyRead(await saveOptimized(stripped));
    expect(read.producer).toBeUndefined();
    expect(read.xmp).toBeNull();
  });
  it('fails safely on malformed or ambiguous XMP without changing live metadata', async () => {
    for (const xmp of ['<bad', originalXmp.replace('custom:keep=', 'xmp:ModifyDate="extra" custom:keep=')]) {
      const doc = await parsePDF(await fixture(xmp));
      const keys = edit(doc);
      await expect(saveQuick(doc, keys)).rejects.toThrow();
      expect(metadataEngine.readInfo(doc).Producer).toBe('Original producer');
      expect(metadataEngine.readXmp(doc)).toBe(xmp);
    }
  });
  it('rejects malformed Info fields and shared metadata without changing the graph', async () => {
    const bad = await parsePDF(await fixture());
    const info = metadataEngine.serializeInfo(bad);
    info.set('Producer', new PDFNumber(42));
    await expect(saveQuick(bad, edit(bad))).rejects.toThrow(/Invalid Info Producer/);
    expect(info.getNumber('Producer')).toBe(42);

    const shared = await parsePDF(await fixture());
    const metadata = shared.catalog.get('Metadata');
    if (!metadata) throw new Error('missing metadata');
    shared.pages[0].dict.set('SharedMetadata', metadata);
    await expect(saveOptimized(shared)).rejects.toThrow(/Shared metadata/);
    expect(metadataEngine.readXmp(shared)).toBe(originalXmp);
  });
  it('publishes a worker save patch to the live graph and can save again', async () => {
    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      onmessageerror: ((event: MessageEvent) => void) | null = null;
      terminate() {}
      postMessage(command: Parameters<typeof handleWorkerCommand>[0]) {
        void handleWorkerCommand(command).then(response => this.onmessage?.({ data: response } as MessageEvent));
      }
    }
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
    try {
      const doc = await parsePDF(await fixture());
      const keys = edit(doc);
      const output = await saveWithWorker(doc, keys);
      expect(metadataEngine.readXmp(doc)).toBe((await independentlyRead(output)).xmp);
      expect(doc.rawBytes).toBe(output);
      const second = await saveWithWorker(doc, keys);
      expect((await independentlyRead(second)).producer).toBe('Paperloom PDF');
    } finally {
      resetPDFWorkerForTests();
      delete (globalThis as { Worker?: unknown }).Worker;
    }
  });
  it('preserves UTF-16 encoding and unrelated XML bytes', async () => {
    const pdf = await PDFDocument.create({ updateMetadata: false });
    pdf.addPage();
    pdf.setProducer('Original producer');
    pdf.setModificationDate(new Date('2001-01-01T00:00:00Z'));
    const xml = `<?xml version="1.0" encoding="UTF-16"?>${originalXmp}`;
    const input = new Uint8Array(2 + xml.length * 2);
    input.set([0xff, 0xfe]);
    for (let i = 0; i < xml.length; i++) { input[2 + i * 2] = xml.charCodeAt(i) & 255; input[3 + i * 2] = xml.charCodeAt(i) >>> 8; }
    pdf.catalog.set(LibName.of('Metadata'), pdf.context.register(pdf.context.stream(input, { Type: 'Metadata', Subtype: 'XML' })));
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    const output = await saveQuick(doc, edit(doc));
    const reopened = await PDFDocument.load(output, { updateMetadata: false });
    const stream = reopened.context.lookup(reopened.catalog.get(LibName.of('Metadata'))!);
    if (!(stream instanceof PDFRawStream)) throw new Error('missing XMP');
    expect([...stream.contents.slice(0, 2)]).toEqual([0xff, 0xfe]);
    const date = reopened.getModificationDate()!.toISOString().replace('.000Z', 'Z');
    expect(new TextDecoder('utf-16le').decode(stream.contents)).toBe(xml.replace('2001-01-01T00:00:00Z', date).replace('Original producer', 'Paperloom PDF'));
  });
  it('returns metadata patches through the worker protocol', async () => {
    const doc = await parsePDF(await fixture());
    const keys = edit(doc);
    const response = await handleWorkerCommand({ type: 'SAVE_PDF', requestId: 'test', document: dehydrateDocument(doc), modifiedKeys: [...keys] });
    expect(response.type).toBe('RESULT');
    if (response.type !== 'RESULT' || !response.bytes) throw new Error('missing response');
    expect(response.metadata?.producer).toBe('Paperloom PDF');
    expect(new TextDecoder().decode(response.metadata!.xmpBytes)).toBe((await independentlyRead(response.bytes)).xmp);
  });
  it('updates decrypted metadata before an encrypted full rewrite', async () => {
    const original = await parsePDF(await fixture());
    await securityEngine.encrypt(original, { algorithm: 'AES-128', userPassword: 'open', ownerPassword: 'owner' });
    const encrypted = await serializeDocument(original);
    const doc = (await securityEngine.open(await parsePDF(encrypted), 'open')).doc;
    const keys = edit(doc);
    const output = await saveQuick(doc, keys);
    expect(new TextDecoder().decode(output)).not.toContain('Paperloom PDF');
    const reopened = (await securityEngine.open(await parsePDF(output), 'open')).doc;
    expect(metadataEngine.readInfo(reopened).Producer).toBe('Paperloom PDF');
    expect(metadataEngine.readXmp(reopened)).toContain('<pdf:Producer>Paperloom PDF</pdf:Producer>');
    const reader = spawnSync('pdfinfo', ['-upw', 'open', '-'], { input: output, encoding: 'utf8' });
    if (!reader.error) {
      expect(reader.status).toBe(0);
      expect(reader.stdout).toMatch(/Producer:\s+Paperloom PDF/);
    }
  });

});
