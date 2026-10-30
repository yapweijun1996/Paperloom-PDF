import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PDFDocument as IndependentPDFDocument, PDFDict as IndependentPDFDict, PDFName as IndependentPDFName, PDFString as IndependentPDFString } from 'pdf-lib';
import {
  PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFString, type PDFDocumentData, type PDFObject,
} from '../../types';
import { serializeDocument } from '../../writer/serializer';
import { appendIncrementalUpdate } from '../../writer/incremental-writer';
import { saveQuick } from '../../writer/save-pipeline';
import { parsePDF } from '../../parser/parser';
import { dehydrateDocument } from '../../worker/codec';
import { handleWorkerCommand } from '../../worker/handler';
import {
  createSignatureFieldAtPoint,
  importFromPem,
  signDocumentCryptographic,
  validateDocumentSignatures,
  parseCMSSignedData,
  verifyCmsCryptographic,
} from '../../signatures';
import { computeByteRangeDigest, nodeOID, parseDERNode } from '../../signatures/crypto/signature-verify';
import { OID } from '../../signatures/crypto/types';
import { getTestCredentials } from './test-credentials';

function makeDocument(): PDFDocumentData {
  const objects = new Map<string, PDFObject>();
  const catalogRef = new PDFRef(1, 0);
  const pagesRef = new PDFRef(2, 0);
  const pageRef = new PDFRef(3, 0);
  const catalog = new PDFDict([['Type', new PDFName('Catalog')], ['Pages', pagesRef]]);
  const pages = new PDFDict([
    ['Type', new PDFName('Pages')],
    ['Kids', new PDFArray([pageRef])],
    ['Count', new PDFNumber(1)],
  ]);
  const page = new PDFDict([
    ['Type', new PDFName('Page')],
    ['Parent', pagesRef],
    ['MediaBox', new PDFArray([new PDFNumber(0), new PDFNumber(0), new PDFNumber(612), new PDFNumber(792)])],
    ['Resources', new PDFDict()],
  ]);
  objects.set(catalogRef.toKey(), catalog);
  objects.set(pagesRef.toKey(), pages);
  objects.set(pageRef.toKey(), page);
  return {
    version: '1.7',
    objects,
    xref: {
      entries: new Map(),
      trailerDict: new PDFDict([['Root', catalogRef], ['Size', new PDFNumber(4)]]),
    },
    catalog,
    pages: [{
      index: 0, dict: page, mediaBox: { x: 0, y: 0, width: 612, height: 792 },
      cropBox: { x: 0, y: 0, width: 612, height: 792 }, rotate: 0, ref: pageRef,
      resources: page.getDict('Resources')!, contentRefs: [],
    }],
    info: {},
    rawBytes: new Uint8Array(),
  };
}

function replaceCmsInPdf(bytes: Uint8Array, byteRange: [number, number, number, number], originalCms: Uint8Array, replacementCms: Uint8Array): Uint8Array {
  const result = new Uint8Array(bytes);
  const gapStart = byteRange[0] + byteRange[1];
  const gap = Buffer.from(result.subarray(gapStart, byteRange[2])).toString('ascii');
  const originalHex = Buffer.from(originalCms).toString('hex');
  const hexOffset = gap.toLowerCase().indexOf(originalHex);
  expect(hexOffset).toBeGreaterThanOrEqual(0);
  expect(replacementCms.length).toBe(originalCms.length);
  result.set(Buffer.from(Buffer.from(replacementCms).toString('hex'), 'ascii'), gapStart + hexOffset);
  expect(result.subarray(0, gapStart)).toEqual(bytes.subarray(0, gapStart));
  expect(result.subarray(byteRange[2])).toEqual(bytes.subarray(byteRange[2]));
  return result;
}

function testTrust(certificateDer: Uint8Array) {
  return { trustAnchors: [{ fingerprintSha256: createHash('sha256').update(certificateDer).digest('hex'), label: 'Test signer' }] };
}

describe('worker-safe cryptographic signing', () => {
  it('preserves Unicode signer metadata while keeping the cryptographic signature valid', async () => {
    const doc = makeDocument();
    doc.rawBytes = await serializeDocument(doc);
    const field = createSignatureFieldAtPoint(doc, 0, 180, 680);
    const credentials = getTestCredentials();
    const imported = await importFromPem(credentials.pem, 'test');
    const signed = await signDocumentCryptographic(doc, field.ref, imported.key!.privateKey, {
      certificateDer: credentials.certificateDer, reason: '批准合同 😀', name: '张三',
    });
    const report = await validateDocumentSignatures(await parsePDF(signed.bytes), testTrust(credentials.certificateDer));
    expect(report.signatures[0].reason).toBe('批准合同 😀');
    expect(report.signatures[0].signerName).toBe('张三');
    expect(report.documentStatus).toBe('Valid');
    const independent = await IndependentPDFDocument.load(signed.bytes);
    const signature = independent.context.enumerateIndirectObjects().map(([, object]) => object).find(object =>
      object instanceof IndependentPDFDict && object.get(IndependentPDFName.of('Type'))?.toString() === '/Sig') as IndependentPDFDict;
    expect((signature.get(IndependentPDFName.of('Reason')) as IndependentPDFString).decodeText()).toBe('批准合同 😀');
    expect((signature.get(IndependentPDFName.of('Name')) as IndependentPDFString).decodeText()).toBe('张三');
  }, 30000);

  it('accepts signed dictionary strings containing PDF delimiter and keyword text', async () => {
    const doc = makeDocument();
    doc.rawBytes = await serializeDocument(doc);
    const field = createSignatureFieldAtPoint(doc, 0, 180, 680);
    const credentials = getTestCredentials();
    const imported = await importFromPem(credentials.pem, 'test');
    const signed = await signDocumentCryptographic(doc, field.ref, imported.key!.privateKey, {
      certificateDer: credentials.certificateDer,
      reason: 'Literal << and endobj are harmless',
    });
    const report = await validateDocumentSignatures(await parsePDF(signed.bytes), testTrust(credentials.certificateDer));
    expect(report.signatures).toHaveLength(1);
    expect(report.signatures[0].reason).toBe('Literal << and endobj are harmless');
    expect(report.signatures[0].digestMatch).toBe(true);
    expect(report.signatures[0].cmsSignatureOk).toBe(true);
    expect(report.signatures[0].status).toBe('Valid');
    expect(report.documentStatus).toBe('Valid');
  }, 30000);

  it('rejects a tampered CMS signature while the document digest remains intact', async () => {
    const doc = makeDocument();
    doc.rawBytes = await serializeDocument(doc);
    const field = createSignatureFieldAtPoint(doc, 0, 180, 680);
    const credentials = getTestCredentials();
    const imported = await importFromPem(credentials.pem, 'test');
    const signed = await signDocumentCryptographic(doc, field.ref, imported.key!.privateKey, {
      certificateDer: credentials.certificateDer,
    });

    const original = await validateDocumentSignatures(await parsePDF(signed.bytes), testTrust(credentials.certificateDer));
    expect(original.signatures).toHaveLength(1);
    expect(original.signatures[0].digestMatch).toBe(true);
    expect(original.signatures[0].cmsSignatureOk).toBe(true);
    expect(original.signatures[0].status).toBe('Valid');
    expect(original.documentStatus).toBe('Valid');
    const untrusted = await validateDocumentSignatures(await parsePDF(signed.bytes), { allowSelfSigned: true });
    expect(untrusted.signatures[0].status).toBe('Unknown');
    const revocationUnknown = await validateDocumentSignatures(await parsePDF(signed.bytes), {
      ...testTrust(credentials.certificateDer), checkRevocation: async () => 'unknown',
    });
    expect(revocationUnknown.signatures[0].status).toBe('Unknown');

    const cms = new Uint8Array(signed.cms);
    const signature = parseCMSSignedData(cms).signerInfos[0]!.encryptedDigest;
    const signatureOffset = Buffer.from(cms).indexOf(Buffer.from(signature));
    expect(signatureOffset).toBeGreaterThanOrEqual(0);
    cms[signatureOffset] ^= 1;

    const [start, length, secondStart] = signed.byteRange;
    const gapStart = start + length;
    const bytes = replaceCmsInPdf(signed.bytes, signed.byteRange, signed.cms, cms);

    const report = await validateDocumentSignatures(await parsePDF(bytes), testTrust(credentials.certificateDer));
    expect(report.signatures).toHaveLength(1);
    expect(report.signatures[0].digestMatch).toBe(true);
    expect(report.signatures[0].cmsSignatureOk).toBe(false);
    expect(report.signatures[0].status).not.toBe('Valid');
    expect(report.documentStatus).not.toBe('Valid');

    const directory = mkdtempSync(join(tmpdir(), 'bloom-invalid-cms-'));
    const contentPath = join(directory, 'signed.bin');
    const cmsPath = join(directory, 'signature.der');
    try {
      writeFileSync(contentPath, Buffer.concat([
        Buffer.from(bytes.subarray(start, gapStart)),
        Buffer.from(bytes.subarray(secondStart, secondStart + signed.byteRange[3])),
      ]));
      const opensslArgs = [
        'cms', '-verify', '-inform', 'DER', '-in', cmsPath,
        '-content', contentPath, '-binary', '-noverify',
      ];
      writeFileSync(cmsPath, signed.cms);
      const validCheck = spawnSync('openssl', opensslArgs, { encoding: 'utf8' });
      expect(validCheck.error).toBeUndefined();
      expect(validCheck.status).toBe(0);
      writeFileSync(cmsPath, cms);
      const check = spawnSync('openssl', opensslArgs, { encoding: 'utf8' });
      expect(check.error).toBeUndefined();
      expect(check.status).not.toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30000);

  it('does not validate CMS lacking messageDigest even when its signature is cryptographically valid', async () => {
    const doc = makeDocument();
    doc.rawBytes = await serializeDocument(doc);
    const field = createSignatureFieldAtPoint(doc, 0, 180, 680);
    const credentials = getTestCredentials();
    const imported = await importFromPem(credentials.pem, 'test');
    const signed = await signDocumentCryptographic(doc, field.ref, imported.key!.privateKey, {
      certificateDer: credentials.certificateDer,
    });

    const cms = new Uint8Array(signed.cms);
    const signer = parseCMSSignedData(cms).signerInfos[0]!;
    const attrs = signer.signedAttrs!;
    const digestAttr = attrs.children!.find((attr) => nodeOID(attr.children![0]) === OID.messageDigest);
    expect(digestAttr).toBeDefined();
    const digestOid = digestAttr!.children![0];
    // Rename only this attribute's OID and sign the modified attributes again.
    // This leaves a valid CMS signature that no longer binds the document digest.
    cms[digestOid.offset + digestOid.length - 1] ^= 1;
    const attrsDer = cms.slice(attrs.offset, attrs.offset + attrs.length);
    attrsDer[0] = 0x31;
    const newSignature = new Uint8Array(await crypto.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' }, imported.key!.privateKey, attrsDer,
    ));
    const signatureOffset = Buffer.from(cms).indexOf(Buffer.from(signer.encryptedDigest));
    expect(signatureOffset).toBeGreaterThanOrEqual(0);
    expect(newSignature.length).toBe(signer.encryptedDigest.length);
    cms.set(newSignature, signatureOffset);
    expect((await verifyCmsCryptographic(cms)).ok).toBe(true);

    const bytes = replaceCmsInPdf(signed.bytes, signed.byteRange, signed.cms, cms);
    const report = await validateDocumentSignatures(await parsePDF(bytes), testTrust(credentials.certificateDer));
    expect(report.signatures).toHaveLength(1);
    expect(report.signatures[0].digestMatch).toBe(false);
    expect(report.signatures[0].status).not.toBe('Valid');
    expect(report.documentStatus).not.toBe('Valid');
  }, 30000);

  it('does not report Valid for unsupported CMS algorithm identifiers', async () => {
    const doc = makeDocument();
    doc.rawBytes = await serializeDocument(doc);
    const field = createSignatureFieldAtPoint(doc, 0, 180, 680);
    const credentials = getTestCredentials();
    const imported = await importFromPem(credentials.pem, 'test');
    const signed = await signDocumentCryptographic(doc, field.ref, imported.key!.privateKey, {
      certificateDer: credentials.certificateDer,
    });
    // Last occurrence belongs to SignerInfo, not the certificate or algorithm set.
    for (const oid of ['608648016503040201', '2a864886f70d010101']) {
      const cms = new Uint8Array(signed.cms);
      const offset = Buffer.from(cms).lastIndexOf(Buffer.from(oid, 'hex'));
      expect(offset).toBeGreaterThanOrEqual(0);
      cms[offset + oid.length / 2 - 1] = 0x7f;
      const bytes = replaceCmsInPdf(signed.bytes, signed.byteRange, signed.cms, cms);
      const report = await validateDocumentSignatures(await parsePDF(bytes), testTrust(credentials.certificateDer));
      expect(report.signatures).toHaveLength(1);
      expect(report.signatures[0].status).not.toBe('Valid');
      expect(report.documentStatus).not.toBe('Valid');
    }
  }, 30000);

  it('rejects a signer identifier that does not match the embedded certificate', async () => {
    const doc = makeDocument();
    doc.rawBytes = await serializeDocument(doc);
    const field = createSignatureFieldAtPoint(doc, 0, 180, 680);
    const credentials = getTestCredentials();
    const imported = await importFromPem(credentials.pem, 'test');
    const signed = await signDocumentCryptographic(doc, field.ref, imported.key!.privateKey, {
      certificateDer: credentials.certificateDer,
    });
    const cms = new Uint8Array(signed.cms);
    const serial = parseCMSSignedData(cms).signerInfos[0]!.sid.children![1];
    cms[serial.offset + serial.length - 1] ^= 1;
    const bytes = replaceCmsInPdf(signed.bytes, signed.byteRange, signed.cms, cms);
    const report = await validateDocumentSignatures(await parsePDF(bytes), testTrust(credentials.certificateDer));
    expect(report.signatures).toHaveLength(1);
    expect(report.signatures[0].digestMatch).toBe(true);
    expect(report.signatures[0].cmsSignatureOk).toBe(false);
    expect(report.signatures[0].status).not.toBe('Valid');
  }, 30000);

  it('does not report the current document as Valid after an unsigned incremental revision', async () => {
    const doc = makeDocument();
    doc.rawBytes = await serializeDocument(doc);
    const field = createSignatureFieldAtPoint(doc, 0, 180, 680);
    const credentials = getTestCredentials();
    const imported = await importFromPem(credentials.pem, 'test');
    const signed = await signDocumentCryptographic(doc, field.ref, imported.key!.privateKey, {
      certificateDer: credentials.certificateDer,
    });
    const parsed = await parsePDF(signed.bytes);
    const root = parsed.xref.trailerDict.getRef('Root')!;
    parsed.catalog.set('Lang', new PDFString('en-US'));
    const updated = appendIncrementalUpdate(parsed, new Set([root.toKey()])).bytes;
    expect(updated.length).toBeGreaterThan(signed.bytes.length);
    expect(updated.subarray(0, signed.bytes.length)).toEqual(signed.bytes);
    const report = await validateDocumentSignatures(await parsePDF(updated), testTrust(credentials.certificateDer));
    expect(report.signatures).toHaveLength(1);
    expect(report.signatures[0].digestMatch).toBe(true);
    expect(report.signatures[0].cmsSignatureOk).toBe(true);
    expect(report.signatures[0].status).not.toBe('Valid');
    expect(report.documentStatus).not.toBe('Valid');
  }, 30000);

  it('rejects a signed byte range whose gap covers more than Contents', async () => {
    const doc = makeDocument();
    doc.rawBytes = await serializeDocument(doc);
    const field = createSignatureFieldAtPoint(doc, 0, 180, 680);
    const credentials = getTestCredentials();
    const imported = await importFromPem(credentials.pem, 'test');
    const signed = await signDocumentCryptographic(doc, field.ref, imported.key!.privateKey, {
      certificateDer: credentials.certificateDer,
    });
    const bytes = new Uint8Array(signed.bytes);
    const widenedRange: [number, number, number, number] = [0, signed.byteRange[1] - 1, signed.byteRange[2], signed.byteRange[3]];
    const text = Buffer.from(bytes).toString('latin1');
    const matches = [...text.matchAll(/\/ByteRange\s*\[([^\]]*)\]/g)];
    const match = matches.at(-1)!;
    expect(match).toBeDefined();
    const inner = widenedRange.join(' ');
    expect(inner.length).toBeLessThanOrEqual(match[1].length);
    const innerOffset = match.index! + match[0].indexOf('[') + 1;
    bytes.set(Buffer.from(inner.padEnd(match[1].length, ' '), 'ascii'), innerOffset);

    const cms = new Uint8Array(signed.cms);
    const signer = parseCMSSignedData(cms).signerInfos[0]!;
    const attrs = signer.signedAttrs!;
    const digestAttr = attrs.children!.find((attr) => nodeOID(attr.children![0]) === OID.messageDigest)!;
    const digestNode = digestAttr.children![1].children![0];
    const digest = await computeByteRangeDigest(bytes, widenedRange, 'sha256');
    expect(digest.length).toBe(digestNode.content.length);
    cms.set(digest, digestNode.offset + digestNode.length - digestNode.content.length);
    const attrsDer = cms.slice(attrs.offset, attrs.offset + attrs.length);
    attrsDer[0] = 0x31;
    const newSignature = new Uint8Array(await crypto.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' }, imported.key!.privateKey, attrsDer,
    ));
    const signatureOffset = Buffer.from(cms).indexOf(Buffer.from(signer.encryptedDigest));
    expect(signatureOffset).toBeGreaterThanOrEqual(0);
    cms.set(newSignature, signatureOffset);
    expect((await verifyCmsCryptographic(cms)).ok).toBe(true);
    const forged = replaceCmsInPdf(bytes, signed.byteRange, signed.cms, cms);
    const report = await validateDocumentSignatures(await parsePDF(forged), testTrust(credentials.certificateDer));
    expect(report.signatures).toHaveLength(1);
    expect(report.signatures[0].digestMatch).toBe(true);
    expect(report.signatures[0].status).not.toBe('Valid');
    expect(report.documentStatus).not.toBe('Valid');
  }, 30000);

  it('does not treat an all-zero Contents placeholder as finalized', async () => {
    const doc = makeDocument();
    const placeholder = new TextEncoder().encode('%PDF-1.7\n/ByteRange [0 10 20 10] /Contents <000000000000>\n');
    doc.rawBytes = placeholder;
    const saved = await saveQuick(doc);
    expect(saved).not.toEqual(placeholder);
  });

  it('keeps the AcroForm and widget in the signing revision', async () => {
    const doc = makeDocument();
    doc.rawBytes = await serializeDocument(doc);
    const field = createSignatureFieldAtPoint(doc, 0, 180, 680, {
      fieldName: 'BrowserSignature',
      withPlaceholderAppearance: true,
    });
    const credentials = getTestCredentials();
    const imported = await importFromPem(credentials.pem, 'test');
    const result = await signDocumentCryptographic(doc, field.ref, imported.key!.privateKey, {
      certificateDer: credentials.certificateDer,
      appearanceText: 'Browser signer',
    });
    const reparsed = await parsePDF(result.bytes);
    const acroEntry = reparsed.catalog.get('AcroForm');
    const acro = acroEntry instanceof PDFRef ? reparsed.objects.get(acroEntry.toKey()) : acroEntry;
    expect(acro).toBeInstanceOf(PDFDict);
    const fields = (acro as PDFDict).get('Fields');
    expect(fields).toBeInstanceOf(PDFArray);
    expect((fields as PDFArray).items.some((item) => item instanceof PDFRef && item.toKey() === field.ref.toKey())).toBe(true);
    expect((acro as PDFDict).getNumber('SigFlags')).toBe(3);
    const annots = reparsed.pages[0].dict.get('Annots');
    expect(annots).toBeInstanceOf(PDFArray);
    expect((annots as PDFArray).items.some((item) => item instanceof PDFRef && item.toKey() === field.ref.toKey())).toBe(true);

    const report = await validateDocumentSignatures(reparsed, { allowSelfSigned: true });
    expect(report.signatures[0]?.byteRangeOk).toBe(true);
    expect(report.signatures[0]?.digestMatch).toBe(true);

    const outputPath = join(tmpdir(), 'bloom-worker-signature.pdf');
    writeFileSync(outputPath, result.bytes);
    try {
      const qpdf = spawnSync('qpdf', ['--check', outputPath], { encoding: 'utf8' });
      if ((qpdf.error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
        expect(qpdf.status, `${qpdf.stdout ?? ''}\n${qpdf.stderr ?? ''}`).toBe(0);
        expect(`${qpdf.stdout}${qpdf.stderr}`).not.toMatch(/WARNING|ERROR/);
      }
      const pdfsig = spawnSync('pdfsig', [outputPath], { encoding: 'utf8' });
      if ((pdfsig.error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') expect(`${pdfsig.stdout}${pdfsig.stderr}`).toMatch(/Signature|signature/);
    } finally {
      unlinkSync(outputPath);
    }
  }, 30000);

  it('matches CMS SignerInfo to the embedded certificate and verifies externally', async () => {
    const doc = makeDocument();
    doc.rawBytes = await serializeDocument(doc);
    const field = createSignatureFieldAtPoint(doc, 0, 180, 680, {
      fieldName: 'CmsSignerIdentifier',
      withPlaceholderAppearance: true,
    });
    const credentials = getTestCredentials();
    const imported = await importFromPem(credentials.pem, 'test');
    const result = await signDocumentCryptographic(doc, field.ref, imported.key!.privateKey, {
      certificateDer: credentials.certificateDer,
    });

    const cms = parseCMSSignedData(result.cms);
    const signer = cms.signerInfos[0]!;
    const certificate = parseDERNode(credentials.certificateDer);
    const tbs = certificate.children![0]!;
    let index = tbs.children![0]?.class === 'context' ? 1 : 0;
    const serial = tbs.children![index++];
    index++;
    const issuer = tbs.children![index];
    const sid = signer.sid.children!;
    expect(Array.from(sid[0]!.content)).toEqual(Array.from(issuer!.content));
    expect(Array.from(sid[1]!.content)).toEqual(Array.from(serial!.content));

    const reparsed = await parsePDF(result.bytes);
    const report = await validateDocumentSignatures(reparsed, { allowSelfSigned: true });
    expect(report.signatures[0]?.byteRangeOk).toBe(true);
    expect(report.signatures[0]?.digestMatch).toBe(true);
    expect(report.signatures[0]?.cmsSignatureOk).toBe(true);

    const directory = mkdtempSync(join(tmpdir(), 'bloom-cms-verify-'));
    const signaturePath = join(directory, 'signature.der');
    const contentPath = join(directory, 'signed.bin');
    const pdfPath = join(directory, 'signed.pdf');
    writeFileSync(signaturePath, result.cms);
    writeFileSync(contentPath, Buffer.concat([
      Buffer.from(result.bytes.slice(result.byteRange[0], result.byteRange[0] + result.byteRange[1])),
      Buffer.from(result.bytes.slice(result.byteRange[2], result.byteRange[2] + result.byteRange[3])),
    ]));
    writeFileSync(pdfPath, result.bytes);
    try {
      const openssl = spawnSync('openssl', [
        'cms', '-verify', '-inform', 'DER', '-in', signaturePath,
        '-content', contentPath, '-binary', '-noverify',
      ], { encoding: 'utf8' });
      if ((openssl.error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
        expect(openssl.status).toBe(0);
        expect(`${openssl.stdout}${openssl.stderr}`).toMatch(/Verification successful/);
      }

      const pdfsig = spawnSync('pdfsig', [pdfPath], { encoding: 'utf8' });
      if ((pdfsig.error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
        expect(`${pdfsig.stdout}${pdfsig.stderr}`).not.toContain('Unknown Validation Failure');
      }
    } finally {
      unlinkSync(signaturePath);
      unlinkSync(contentPath);
      unlinkSync(pdfPath);
    }
  }, 30000);

  it('returns signed bytes unchanged through SAVE_PDF and OPTIMIZE_PDF worker commands', async () => {
    const doc = makeDocument();
    doc.rawBytes = await serializeDocument(doc);
    const field = createSignatureFieldAtPoint(doc, 0, 180, 680);
    const credentials = getTestCredentials();
    const imported = await importFromPem(credentials.pem, 'test');
    const signed = await signDocumentCryptographic(doc, field.ref, imported.key!.privateKey, {
      certificateDer: credentials.certificateDer,
    });
    for (const type of ['SAVE_PDF', 'OPTIMIZE_PDF'] as const) {
      const response = await handleWorkerCommand({
        type,
        requestId: type,
        document: dehydrateDocument(doc),
      });
      expect(response.type).toBe('RESULT');
      expect(response.type === 'RESULT' && response.bytes).toEqual(signed.bytes);
    }
  }, 30000);
});
