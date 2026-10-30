import { PDFDocument, PDFHexString as LibHexString, PDFName as LibName } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFRef } from '../../types';
import { parsePDF } from '../../parser/parser';
import { assertXrefProvenanceAsync } from '../../parser/xref-provenance';
import { finalizeSignatureOnDocument } from '../../signatures/crypto/finalizer';
import { dehydrateDocument } from '../../worker/codec';
import { appendIncrementalUpdate } from '../../writer/incremental-writer';

async function fixture(pageSize = 200, secondSignature = false) {
  const input = await PDFDocument.create();
  input.addPage([pageSize, pageSize]);
  const signature = input.context.obj({ Type: 'Sig', ByteRange: [0, 9999999999, 9999999999, 9999999999], Contents: LibHexString.of('0'.repeat(8192)) });
  const ref = input.context.register(signature);
  input.catalog.set(LibName.of('TestSig'), ref);
  if (secondSignature) {
    const other = input.context.obj({ Type: 'Sig', ByteRange: [0, 9999999999, 9999999999, 9999999999], Contents: LibHexString.of('0'.repeat(8192)) });
    input.catalog.set(LibName.of('OtherSig'), input.context.register(other));
  }
  const doc = await parsePDF(await input.save({ useObjectStreams: false }));
  const sigRef = new PDFRef(ref.objectNumber, ref.generationNumber);
  const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 1024,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  return { doc, sigRef, key: keys.privateKey };
}

describe('document finalizer integrity', () => {
  it('publishes the exact signature dictionary and matching xref', async () => {
    const { doc, sigRef, key } = await fixture();
    const sig = doc.objects.get(sigRef.toKey()) as PDFDict;
    const result = await finalizeSignatureOnDocument(doc, doc.rawBytes, key, { sigRef, contentsSize: 4096 });
    expect(doc.rawBytes).toEqual(result.bytes);
    expect(sig.get('Contents')).toBeInstanceOf(PDFHexString);
    expect((sig.get('ByteRange') as PDFArray).asNumbers()).toEqual(result.byteRange);
    expect(await assertXrefProvenanceAsync(doc.rawBytes, doc.xref)).toBe(true);
    const reopened = await parsePDF(result.bytes);
    expect((reopened.objects.get(sigRef.toKey()) as PDFDict).get('Contents')).toEqual(sig.get('Contents'));
    for (const trailerKey of ['Size', 'Prev', 'XRefStm']) {
      expect(doc.xref.trailerDict.getNumber(trailerKey)).toBe(reopened.xref.trailerDict.getNumber(trailerKey));
    }
  });

  it('rejects unrelated document bytes atomically', async () => {
    const { doc, sigRef, key } = await fixture();
    const unrelated = await fixture(300);
    const before = dehydrateDocument(doc);
    await expect(finalizeSignatureOnDocument(doc, unrelated.doc.rawBytes, key, { sigRef, contentsSize: 4096 })).rejects.toThrow();
    expect(dehydrateDocument(doc)).toEqual(before);
  });

  it('identifies a unique signature when its reference is omitted', async () => {
    const { doc, sigRef, key } = await fixture();
    const result = await finalizeSignatureOnDocument(doc, doc.rawBytes, key, { contentsSize: 4096 });
    expect(((doc.objects.get(sigRef.toKey()) as PDFDict).get('ByteRange') as PDFArray).asNumbers()).toEqual(result.byteRange);
  });

  it('rejects ambiguous signature placeholders without a reference', async () => {
    const { doc, key } = await fixture(200, true);
    const before = dehydrateDocument(doc);
    await expect(finalizeSignatureOnDocument(doc, doc.rawBytes, key, { contentsSize: 4096 })).rejects.toThrow(/unique/i);
    expect(dehydrateDocument(doc)).toEqual(before);
  });

  it('rejects uncommitted page edits rather than signing stale document bytes', async () => {
    const { doc, sigRef, key } = await fixture();
    doc.pages[0].dict.set('Unsaved', new PDFName('Preserved'));
    const before = dehydrateDocument(doc);
    await expect(finalizeSignatureOnDocument(doc, doc.rawBytes, key, { sigRef, contentsSize: 4096 })).rejects.toThrow(/graph/i);
    expect(dehydrateDocument(doc)).toEqual(before);
  });

  it('rejects even a valid incremental revision based on the current bytes', async () => {
    const { doc, sigRef, key } = await fixture();
    const different = await parsePDF(doc.rawBytes);
    different.catalog.set('Unrelated', new PDFName('Changed'));
    const catalogKey = [...different.objects].find(([, value]) => value === different.catalog)![0];
    const revision = appendIncrementalUpdate(different, new Set([catalogKey]));
    expect(revision.bytes.slice(0, doc.rawBytes.length)).toEqual(doc.rawBytes);
    const before = dehydrateDocument(doc);
    await expect(finalizeSignatureOnDocument(doc, revision.bytes, key, { sigRef, contentsSize: 4096 })).rejects.toThrow();
    expect(dehydrateDocument(doc)).toEqual(before);
  });

  it('preserves concurrent edits during asynchronous signing', async () => {
    const { doc, sigRef, key } = await fixture();
    const original = doc.rawBytes.slice();
    const sign = crypto.subtle.sign.bind(crypto.subtle);
    let arrive!: () => void;
    let release!: () => void;
    const reached = new Promise<void>(resolve => { arrive = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args) => {
      arrive();
      await gate;
      return sign(...args);
    });
    try {
      const pending = finalizeSignatureOnDocument(doc, doc.rawBytes, key, { sigRef, contentsSize: 4096 });
      await reached;
      doc.catalog.set('Concurrent', new PDFName('Preserved'));
      release();
      await expect(pending).rejects.toThrow('Document changed');
      expect(doc.catalog.getName('Concurrent')).toBe('Preserved');
      expect(doc.rawBytes).toEqual(original);
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it('rejects an altered in-memory signature dictionary without changing it', async () => {
    const { doc, sigRef, key } = await fixture();
    (doc.objects.get(sigRef.toKey()) as PDFDict).set('Changed', new PDFName('Yes'));
    const before = dehydrateDocument(doc);
    await expect(finalizeSignatureOnDocument(doc, doc.rawBytes, key, { sigRef, contentsSize: 4096 })).rejects.toThrow();
    expect(dehydrateDocument(doc)).toEqual(before);
  });
});
