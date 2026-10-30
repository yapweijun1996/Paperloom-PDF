import { installSignatureBase } from '../signatures/crypto/signing-pipeline';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { parsePDF } from '../parser/parser';
import { securityEngine } from '../security/security-engine';
import { SessionDocumentEditor } from '../session/document-edit';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFString } from '../types';
import { serializeDocument } from '../writer/serializer';
import { createSignatureField } from '../signatures/crypto/sign';
import { signDocumentCryptographic } from '../signatures/crypto/signing-pipeline';
import { importFromPem } from '../signatures/certificates/certificate-parser';
import { getTestCredentials } from './signatures/test-credentials';
import { extractPages } from '../writer/page-operations';
import { dehydrateDocument } from '../worker/codec';

const fixtures = [
  ['aes-256-r6.pdf', 'userpass'],
  ['aes-128-r4.pdf', 'userpass'],
  ['rc4-128-r4.pdf', 'userpass'],
  ['rc4-40-empty-user-r2.pdf', ''],
] as const;

function getFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(__dirname, 'fixtures/encrypted', name)));
}

describe('protected page extraction', () => {
  it.each(['locked', 'unlocked'] as const)('refuses direct writer extraction of a %s protected PDF without modifying it', async state => {
    const parsed = await parsePDF(getFixture('aes-128-r4.pdf'));
    const doc = state === 'locked' ? parsed : (await securityEngine.open(parsed, 'userpass')).doc;
    const before = dehydrateDocument(doc);
    expect(() => extractPages(doc, [0])).toThrow(/protected.*extraction/i);
    expect(dehydrateDocument(doc)).toEqual(before);
    expect(doc.xref.trailerDict.has('Encrypt')).toBe(true);
    if (state === 'unlocked') {
      const bytes = await new SessionDocumentEditor().extractPages(doc, [0]);
      await expect(securityEngine.open(await parsePDF(bytes), 'wrong')).rejects.toThrow(/password/i);
      expect((await securityEngine.open(await parsePDF(bytes), 'userpass')).doc.pages).toHaveLength(1);
      expect(dehydrateDocument(doc)).toEqual(before);
    }
  });
  it.each(fixtures)('keeps %s protected with the original password', async (name, password) => {
    const parsed = await parsePDF(getFixture(name));
    const opened = await securityEngine.open(parsed, password);
    const doc = opened.doc;
    const originalCatalog = doc.catalog;
    const originalTrailer = doc.xref.trailerDict;
    const originalObjects = doc.objects;
    const originalCount = doc.objects.size;
    const bytes = await new SessionDocumentEditor().extractPages(doc, [0]);
    expect(doc.catalog).toBe(originalCatalog);
    expect(doc.xref.trailerDict).toBe(originalTrailer);
    expect(doc.objects).toBe(originalObjects);
    expect(doc.objects.size).toBe(originalCount);
    expect(new TextDecoder().decode(bytes)).not.toContain('Hello encrypted');
    const protectedOutput = await parsePDF(bytes);
    expect(protectedOutput.xref.trailerDict.has('Encrypt')).toBe(true);
    await expect(securityEngine.open(protectedOutput, 'incorrect-password')).rejects.toThrow(/password/i);
    const reopened = await securityEngine.open(protectedOutput, password);
    expect(reopened.doc.pages).toHaveLength(1);
    expect(reopened.context.algorithm).toBe(opened.context.algorithm);
    expect(reopened.context.encrypt.P).toBe(opened.context.encrypt.P);
  }, 30000);

  it('omits unrelated pages and detached objects when extracting protected content', async () => {
    const input = await PDFDocument.create();
    const font = await input.embedFont(StandardFonts.Helvetica);
    input.addPage([200, 200]).drawText('SELECTED PAGE', { font });
    input.addPage([200, 200]).drawText('OTHER PRIVATE PAGE', { font });
    const source = await parsePDF(await input.save({ useObjectStreams: false }));
    source.objects.set('999_0', new PDFString('UNRELATED PRIVATE RECORD'));
    await securityEngine.encrypt(source, { algorithm: 'AES-128', ownerPassword: 'synthetic-owner', userPassword: 'synthetic-user' });
    const opened = await securityEngine.open(await parsePDF(await serializeDocument(source)), 'synthetic-user');
    const extracted = await new SessionDocumentEditor().extractPages(opened.doc, [0]);
    await expect(securityEngine.open(await parsePDF(extracted), 'wrong')).rejects.toThrow(/password/i);
    const result = (await securityEngine.open(await parsePDF(extracted), 'synthetic-user')).doc;
    expect(result.pages).toHaveLength(1);
    const allStrings = [...result.objects.values()].filter(object => object instanceof PDFString).map(object => object.value).join(' ');
    expect(allStrings).not.toContain('UNRELATED PRIVATE RECORD');
    const independent = await PDFDocument.load(extracted, { ignoreEncryption: true });
    expect(independent.getPageCount()).toBe(1);
  });

  it('rejects a selected page that references an omitted page before exporting', async () => {
    const input = await PDFDocument.create();
    input.addPage([200, 200]);
    input.addPage([200, 200]);
    const doc = await parsePDF(await input.save({ useObjectStreams: false }));
    doc.pages[0].dict.set('Annots', new PDFArray([new PDFDict([
      ['Subtype', new PDFName('Link')],
      ['Rect', new PDFArray([0, 0, 20, 20].map(value => new PDFNumber(value)))],
      ['Dest', new PDFArray([doc.pages[1].ref, new PDFName('Fit')])],
    ])]));
    const before = await serializeDocument(doc);
    await expect(new SessionDocumentEditor().extractPages(doc, [0])).rejects.toThrow(/references a page outside/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.pages).toHaveLength(2);
  });

  it.each([{ indices: [] }, { indices: [-1] }, { indices: [9] }, { indices: [0.5] }])('rejects invalid page selections $indices', async ({ indices }) => {
    const doc = (await securityEngine.open(await parsePDF(getFixture('aes-128-r4.pdf')), 'userpass')).doc;
    await expect(new SessionDocumentEditor().extractPages(doc, indices)).rejects.toThrow(/valid page/i);
  });

  it('rejects a protected document that has not been unlocked', async () => {
    const doc = await parsePDF(getFixture('aes-128-r4.pdf'));
    const objects = doc.objects;
    await expect(new SessionDocumentEditor().extractPages(doc, [0])).rejects.toThrow(/unlock/i);
    expect(doc.objects).toBe(objects);
    expect(doc.xref.trailerDict.has('Encrypt')).toBe(true);
  });

  it('rejects extraction when its authenticated encryption context is missing', async () => {
    const doc = (await securityEngine.open(await parsePDF(getFixture('aes-128-r4.pdf')), 'userpass')).doc;
    delete doc.encryptionFileKey;
    await expect(new SessionDocumentEditor().extractPages(doc, [0])).rejects.toThrow(/re-encryption context/i);
    expect(doc.xref.trailerDict.has('Encrypt')).toBe(true);
  });

  it('rejects indirect encryption parameters instead of writing dangling references', async () => {
    const doc = (await securityEngine.open(await parsePDF(getFixture('aes-128-r4.pdf')), 'userpass')).doc;
    const encryptRef = doc.xref.trailerDict.getRef('Encrypt')!;
    const dictionary = doc.objects.get(encryptRef.toKey()) as PDFDict;
    const filter = dictionary.get('CF')!;
    const filterRef = new PDFRef(999, 0);
    doc.objects.set(filterRef.toKey(), filter);
    dictionary.set('CF', filterRef);
    await expect(new SessionDocumentEditor().extractPages(doc, [0])).rejects.toThrow(/indirect encryption settings/i);
    expect(dictionary.get('CF')).toBe(filterRef);
    expect(doc.objects.get(filterRef.toKey())).toBe(filter);
  });

  it('preserves a genuinely signed PDF when extraction would invalidate its signature', async () => {
    const input = await PDFDocument.create();
    input.addPage([200, 200]);
    const doc = await parsePDF(await input.save({ useObjectStreams: false }));
    const field = createSignatureField(doc, 0, { x: 20, y: 20, width: 80, height: 40 }, 'Signature');
    await installSignatureBase(doc, await serializeDocument(doc));
    const identity = await importFromPem(getTestCredentials().pem);
    const signed = await signDocumentCryptographic(doc, field, identity.key!.privateKey, { certificateDer: identity.leaf!.der });
    const reopened = await parsePDF(signed.bytes);
    const raw = reopened.rawBytes;
    await expect(new SessionDocumentEditor().extractPages(reopened, [0])).rejects.toThrow(/invalidate.*signature/i);
    expect(reopened.rawBytes).toBe(raw);
    expect(reopened.rawBytes).toEqual(signed.bytes);
  }, 30000);

  it('rejects documents containing a signature dictionary rather than exporting an invalid signature', async () => {
    const doc = (await securityEngine.open(await parsePDF(getFixture('aes-128-r4.pdf')), 'userpass')).doc;
    const dict = new PDFDict([['Type', new PDFName('Sig')], ['ByteRange', new PDFNumber(0)], ['Contents', new PDFNumber(1)]]);
    doc.objects.set('999_0', dict);
    await expect(new SessionDocumentEditor().extractPages(doc, [0])).rejects.toThrow(/invalidate.*signature/i);
    expect(doc.objects.get('999_0')).toBe(dict);
  });
});
