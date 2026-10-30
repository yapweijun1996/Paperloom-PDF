import { installSignatureBase } from '../../signatures/crypto/signing-pipeline';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } from '../../types';
import { parsePDF } from '../../parser/parser';
import { createSignatureField, importFromPem, signDocumentCryptographic, validateDocumentSignatures } from '../../signatures';
import { getTestCredentials } from './test-credentials';
import { serializeDocument } from '../../writer/serializer';
import { hasDocumentSignature, hasFinalizedSignature, saveOptimized, saveQuick, SignedDocumentEditError } from '../../writer/save-pipeline';
import { sanitizationEngine } from '../../security/sanitization/sanitization-engine';
import { compressDocumentImages } from '../../optimize/image-compress';
import { SessionDocumentEditor } from '../../session/document-edit';
import { extractPages } from '../../writer/page-operations';
import { dehydrateDocument } from '../../worker/codec';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('signature-presence safety', () => {
  it.each([
    '/ByteRange [0 12 30 4] /Contents <ab cd 00>',
    '/ByteRange [0 % comment\n 12 30 4] /Contents (\\001\\002)',
    '/Byte#52ange [0 12 30 4] /Cont#65nts <A B>',
    '/ByteRange 8 0 R /Contents 9 0 R',
    '/ByteRange [0 12 30 4] /Contents <0000> /Contents <01>',
  ])('recognizes signed raw syntax %s', value => {
    expect(hasFinalizedSignature(bytes(`%PDF-1.7\n${value}`))).toBe(true);
  });

  it('does not classify an all-zero unsigned placeholder as finalized', () => {
    expect(hasFinalizedSignature(bytes('%PDF-1.7\n/ByteRange [0 0 0 0] /Contents <00 00>'))).toBe(false);
  });

  it('recognizes nested or indirect signature values and rejects rewriting without original bytes', async () => {
    const pdf = await PDFDocument.create(); pdf.addPage([100, 100]);
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    doc.rawBytes = new Uint8Array();
    const rangeRef = new PDFRef(900, 0), contentsRef = new PDFRef(901, 0);
    doc.objects.set(rangeRef.toKey(), new PDFArray([0, 10, 20, 10].map(n => new PDFNumber(n))));
    doc.objects.set(contentsRef.toKey(), new PDFHexString('aabb'));
    doc.catalog.set('Nested', new PDFDict([['Signature', new PDFDict([['Type', new PDFName('Sig')], ['ByteRange', rangeRef], ['Contents', contentsRef]])]]));
    expect(hasDocumentSignature(doc)).toBe(true);
    await expect(saveQuick(doc)).rejects.toBeInstanceOf(SignedDocumentEditError);
    await expect(saveOptimized(doc)).rejects.toBeInstanceOf(SignedDocumentEditError);
  });

  it('preserves a real signed PDF with whitespace in its excluded Contents padding', async () => {
    const pdf = await PDFDocument.create(); pdf.addPage([300, 400]);
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    const field = createSignatureField(doc, 0, { x: 20, y: 20, width: 100, height: 40 }, 'Signer');
    await installSignatureBase(doc, await serializeDocument(doc));
    const credentials = getTestCredentials();
    const bundle = await importFromPem(credentials.pem, 'test');
    const signed = await signDocumentCryptographic(doc, field, bundle.key!.privateKey, {
      certificateDer: bundle.leaf!.der, hashAlgorithm: 'sha256', contentsSize: 4096, enableTimestamp: false,
    });
    const original = new Uint8Array(signed.bytes);
    const text = new TextDecoder('latin1').decode(original);
    const match = [...text.matchAll(/\/Contents\s*<([0-9a-fA-F]+)>/g)].find(item => /0{8}$/.test(item[1]));
    expect(match).toBeDefined();
    const offset = match!.index! + match![0].length - 5;
    expect(String.fromCharCode(...original.subarray(offset, offset + 2))).toBe('00');
    original[offset] = 0x20; original[offset + 1] = 0x20;
    expect(hasFinalizedSignature(original)).toBe(true);
    const reopened = await parsePDF(original);
    const report = await validateDocumentSignatures(reopened, { allowSelfSigned: true });
    expect(report.signatures.some(item => item.digestMatch && item.cmsSignatureOk === true)).toBe(true);
    expect(await saveQuick(reopened)).toEqual(original);
    expect(await saveOptimized(reopened)).toEqual(original);
    const compressed = await compressDocumentImages(reopened, { quality: null, dpi: null });
    expect(compressed.bytes).toEqual(original);
    const beforeExtraction = dehydrateDocument(reopened);
    expect(() => extractPages(reopened, [0])).toThrow(/signed/i);
    expect(dehydrateDocument(reopened)).toEqual(beforeExtraction);
    await expect(new SessionDocumentEditor().extractPages(reopened, [0])).rejects.toThrow(/signed/i);
    reopened.catalog.set('OCProperties', new PDFDict());
    const current = reopened.catalog.get('OCProperties');
    await expect(sanitizationEngine.sanitize(reopened, { hiddenLayers: true })).rejects.toThrow(/hidden layer|optional content/i);
    expect(reopened.catalog.get('OCProperties')).toBe(current);
    expect(reopened.requiresFullRewrite).toBeUndefined();
    reopened.catalog.set('Edited', new PDFString('change'));
    await expect(saveQuick(reopened)).rejects.toBeInstanceOf(SignedDocumentEditError);
    await expect(saveOptimized(reopened)).rejects.toBeInstanceOf(SignedDocumentEditError);
    expect(reopened.rawBytes).toEqual(original);
  }, 30000);
});
