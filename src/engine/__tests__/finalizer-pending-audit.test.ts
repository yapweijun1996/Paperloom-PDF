import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import { expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';
import { PDFNumber, PDFRef } from '../types';
import { finalizeSignatureOnDocument } from '../signatures/crypto/finalizer';
import { dehydrateDocument, sameDocumentSnapshot } from '../worker/codec';

it('does not claim to sign a PDF whose other pending edits are absent from the input bytes', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([200, 200]);
  const sig = pdf.context.obj({ Type: 'Sig', ByteRange: [0, 9999999999, 9999999999, 9999999999], Contents: PDFHexString.of('0'.repeat(8192)) });
  const pdfRef = pdf.context.register(sig); pdf.catalog.set(PDFName.of('TestSig'), pdfRef);
  const bytes = await pdf.save({ useObjectStreams: false });
  const doc = await parsePDF(bytes);
  doc.pages[0].dict.set('Rotate', new PDFNumber(90));
  const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const before = dehydrateDocument(doc);
  let result;
  try { result = await finalizeSignatureOnDocument(doc, bytes, keys.privateKey,
    { contentsSize: 4096, sigRef: new PDFRef(pdfRef.objectNumber, pdfRef.generationNumber) }); }
  catch { /* Safe refusal is also acceptable. */ }
  if (result) expect((await parsePDF(result.bytes)).pages[0].dict.getNumber('Rotate')).toBe(90);
  else expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
});
