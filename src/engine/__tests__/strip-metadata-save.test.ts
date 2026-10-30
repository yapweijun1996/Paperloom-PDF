import { installSignatureBase } from '../signatures/crypto/signing-pipeline';
import { PDFDocument, PDFName as LibName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';
import { metadataEngine } from '../security/metadata/metadata-engine';
import { PDFDict, PDFRef, PDFStream, PDFString } from '../types';
import { serializeDocument } from '../writer/serializer';
import { saveQuick, SignedDocumentEditError } from '../writer/save-pipeline';
import { createSignatureField, importFromPem, signDocumentCryptographic, validateDocumentSignatures } from '../signatures';
import { getTestCredentials } from './signatures/test-credentials';

const secretInfo = 'PRIVATE-INFO-821';
const secretXmp = 'PRIVATE-XMP-937';
const infoHex = 'FEFF' + Array.from(secretInfo, char => char.charCodeAt(0).toString(16).padStart(4, '0')).join('').toUpperCase();
async function fixture() {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.addPage([200, 200]);
  pdf.setTitle(secretInfo);
  const stream = pdf.context.stream(new TextEncoder().encode(`<xmp>${secretXmp}</xmp>`), { Type: 'Metadata', Subtype: 'XML' });
  pdf.catalog.set(LibName.of('Metadata'), pdf.context.register(stream));
  return parsePDF(await pdf.save({ useObjectStreams: false }));
}

describe('standalone metadata stripping', () => {
  it('forces a complete rewrite even when quick save receives explicit edits', async () => {
    const doc = await fixture();
    expect(new TextDecoder().decode(doc.rawBytes)).toContain(infoHex);
    expect(new TextDecoder().decode(doc.rawBytes)).toContain(secretXmp);
    metadataEngine.stripMetadata(doc);
    expect(doc.requiresFullRewrite).toBe(true);
    doc.catalog.set('Lang', PDFString.fromText('en'));
    const output = await saveQuick(doc, new Set([doc.xref.trailerDict.getRef('Root')!.toKey()]));
    expect(new TextDecoder().decode(output)).not.toContain(infoHex);
    expect(new TextDecoder().decode(output)).not.toContain(secretXmp);
    const reopened = await parsePDF(output);
    expect(metadataEngine.readInfo(reopened)).toEqual({});
    expect(metadataEngine.readXmp(reopened)).toBeNull();
    const independent = await PDFDocument.load(output, { updateMetadata: false });
    expect(independent.getTitle()).toBeUndefined();
    expect(independent.catalog.get(LibName.of('Metadata'))).toBeUndefined();
  });

  it('refuses an invalid XMP reference before modifying Info or save policy', async () => {
    const doc = await fixture();
    doc.catalog.set('Metadata', new PDFRef(99999, 0));
    expect(() => metadataEngine.stripMetadata(doc)).toThrow(/invalid XMP/i);
    expect(metadataEngine.readInfo(doc).Title).toBe(secretInfo);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('refuses to leave a shared XMP stream reachable through another catalog entry', async () => {
    const doc = await fixture();
    const metadata = doc.catalog.get('Metadata')!;
    doc.catalog.set('OtherMetadata', metadata);
    expect(() => metadataEngine.stripMetadata(doc)).toThrow(/shared metadata/i);
    expect(metadataEngine.readInfo(doc).Title).toBe(secretInfo);
    expect(metadataEngine.readXmp(doc)).toContain(secretXmp);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it.each(['indirect', 'direct'] as const)(
    'refuses a shared XMP stream descendant before changing Info or XMP (%s)', async kind => {
      const doc = await fixture();
      const metadata = doc.catalog.getRef('Metadata')!;
      const childRef = new PDFRef(999, 0);
      const child = new PDFString('SHARED_XMP_CHILD');
      if (kind === 'indirect') doc.objects.set(childRef.toKey(), child);
      const shared = kind === 'indirect' ? childRef : child;
      (doc.objects.get(metadata.toKey()) as PDFStream).dict.set('PrivateExtra', shared);
      doc.catalog.set('Retained', shared);
      const before = await serializeDocument(doc);
      expect(() => metadataEngine.stripMetadata(doc)).toThrow(/shared metadata/i);
      expect(await serializeDocument(doc)).toEqual(before);
      expect(metadataEngine.readInfo(doc).Title).toBe(secretInfo);
      expect(doc.requiresFullRewrite).toBeUndefined();
    },
  );

  it('refuses to strip Info when retained XMP references it', async () => {
    const doc = await fixture();
    const info = doc.xref.trailerDict.get('Info')!;
    const metadata = doc.catalog.getRef('Metadata')!;
    (doc.objects.get(metadata.toKey()) as PDFStream).dict.set('OtherInfo', info);
    expect(() => metadataEngine.stripMetadata(doc, { stripXmp: false })).toThrow(/shared metadata/i);
    expect(metadataEngine.readInfo(doc).Title).toBe(secretInfo);
    expect(metadataEngine.readXmp(doc)).toContain(secretXmp);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('refuses to strip XMP when retained Info references it', async () => {
    const doc = await fixture();
    const info = doc.xref.trailerDict.getRef('Info')!;
    const metadata = doc.catalog.get('Metadata')!;
    (doc.objects.get(info.toKey()) as PDFDict).set('OtherMetadata', metadata);
    expect(() => metadataEngine.stripMetadata(doc, { stripInfo: false })).toThrow(/shared metadata/i);
    expect(metadataEngine.readInfo(doc).Title).toBe(secretInfo);
    expect(metadataEngine.readXmp(doc)).toContain(secretXmp);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('refuses to strip a real signed document before changing metadata or original bytes', async () => {
    const doc = await fixture();
    const field = createSignatureField(doc, 0, { x: 20, y: 20, width: 100, height: 40 }, 'Signer');
    await installSignatureBase(doc, await serializeDocument(doc));
    const credentials = getTestCredentials();
    const bundle = await importFromPem(credentials.pem, 'test');
    const signed = await signDocumentCryptographic(doc, field, bundle.key!.privateKey, {
      certificateDer: bundle.leaf!.der, hashAlgorithm: 'sha256', contentsSize: 4096, enableTimestamp: false,
    });
    const reopened = await parsePDF(signed.bytes);
    expect(() => metadataEngine.stripMetadata(reopened)).toThrow(SignedDocumentEditError);
    expect(metadataEngine.readInfo(reopened).Title).toBe(secretInfo);
    expect(metadataEngine.readXmp(reopened)).toContain(secretXmp);
    expect(reopened.requiresFullRewrite).toBeUndefined();
    const output = await saveQuick(reopened);
    expect(output).toEqual(signed.bytes);
    const report = await validateDocumentSignatures(await parsePDF(output), { allowSelfSigned: true });
    expect(report.signatures.some(item => item.digestMatch && item.cmsSignatureOk === true)).toBe(true);
  }, 30000);
});
