import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import { expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';
import { finalizeSignatureOnDocument } from '../signatures/crypto/finalizer';
import { dehydrateDocument, sameDocumentSnapshot } from '../worker/codec';

it('does not publish signed bytes from an unrelated PDF into the live document', async () => {
  const a = await PDFDocument.create(); a.addPage([200, 200]);
  const b = await PDFDocument.create(); b.addPage([300, 300]); b.addPage([300, 300]);
  const sig = b.context.obj({ Type: 'Sig', ByteRange: [0, 9999999999, 9999999999, 9999999999], Contents: PDFHexString.of('0'.repeat(8192)) });
  b.catalog.set(PDFName.of('TestSig'), b.context.register(sig));
  const doc = await parsePDF(await a.save({ useObjectStreams: false }));
  const bytes = await b.save({ useObjectStreams: false });
  const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const before = dehydrateDocument(doc);
  let rejected = false;
  try { await finalizeSignatureOnDocument(doc, bytes, keys.privateKey, { contentsSize: 4096 }); }
  catch { rejected = true; }
  expect(rejected).toBe(true);
  expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
});
