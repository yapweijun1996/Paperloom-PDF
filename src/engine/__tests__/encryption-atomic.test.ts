import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPageContentBytes, parsePDF } from '../parser/parser';
import { getTestCredentials } from './signatures/test-credentials';
import { decodePem } from '../signatures/certificates/certificate-parser';
import { PublicKeyEncryptionEngine } from '../security/public-key/public-key-engine';
import { PDFDict, PDFName, PDFStream, PDFString } from '../types';
import { encryptDocumentObjects } from '../security/encryption/encrypt-pipeline';
import { ensureFileId } from '../security/encryption/encrypt-dict';
import { SecurityPolicyEngine } from '../security/policy/policy-engine';
import { securityEngine } from '../security/security-engine';
import { serializeDocument } from '../writer/serializer';

afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  const source = await PDFDocument.create();
  source.setTitle('Fixture metadata');
  const font = await source.embedFont(StandardFonts.Helvetica);
  for (const text of ['First stream', 'Second stream']) {
    source.addPage([200, 200]).drawText(text, { font });
  }
  const doc = await parsePDF(await source.save({ useObjectStreams: false }));
  doc.catalog.set('OpenAction', new PDFDict([['S', new PDFName('JavaScript')], ['JS', new PDFString('alert(1)')]]));
  ensureFileId(doc.xref.trailerDict);
  return doc;
}

function failingRandomCall(failAt: number) {
  const native = globalThis.crypto;
  let calls = 0;
  vi.stubGlobal('crypto', {
    subtle: native.subtle,
    getRandomValues(array: Uint8Array) {
      calls++;
      if (calls === failAt) throw new Error('synthetic RNG failure');
      return native.getRandomValues(array);
    },
  });
  return () => calls;
}

function identities(doc: Awaited<ReturnType<typeof fixture>>) {
  return {
    objects: doc.objects,
    catalog: doc.catalog,
    trailer: doc.xref.trailerDict,
    pages: doc.pages,
    info: doc.info,
    page: doc.pages[0],
    pageDict: doc.pages[0].dict,
    stream: [...doc.objects.values()].find((object): object is PDFStream => object instanceof PDFStream)!,
  };
}

describe('atomic encryption failures', () => {
  it.each([2, 3, 5])('keeps every original reference and byte on direct RNG failure %i', async failAt => {
    const doc = await fixture();
    const before = await serializeDocument(doc);
    const original = identities(doc);
    const streamBytes = original.stream.rawBytes;
    const calls = failingRandomCall(failAt);
    await expect(encryptDocumentObjects(doc, { algorithm: 'AES-128', ownerPassword: 'synthetic' }))
      .rejects.toThrow('synthetic RNG failure');
    expect(calls()).toBe(failAt);
    expect(doc.xref.trailerDict.has('Encrypt')).toBe(false);
    expect(identities(doc)).toEqual(original);
    expect(doc.objects).toBe(original.objects);
    expect(doc.catalog).toBe(original.catalog);
    expect(doc.xref.trailerDict).toBe(original.trailer);
    expect(doc.pages).toBe(original.pages);
    expect(doc.info).toBe(original.info);
    expect(doc.pages[0]).toBe(original.page);
    expect(doc.pages[0].dict).toBe(original.pageDict);
    expect(original.stream.rawBytes).toBe(streamBytes);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it.each([2, 3, 4])('keeps sanitization and encryption atomic on policy RNG failure %i', async failAt => {
    const doc = await fixture();
    const before = await serializeDocument(doc);
    const original = identities(doc);
    const originalAction = doc.catalog.get('OpenAction');
    const policy = new SecurityPolicyEngine();
    policy.createPolicy({
      name: 'Atomic fixture', description: 'Synthetic failure regression',
      requireEncryption: true, encryption: { algorithm: 'AES-128' },
      stripMetadata: true, removeJavaScript: true,
    });
    const calls = failingRandomCall(failAt);
    await expect(policy.applyPolicy(doc, 'Atomic fixture', { ownerPassword: 'synthetic' }))
      .rejects.toThrow('synthetic RNG failure');
    expect(calls()).toBe(failAt);
    expect(doc.catalog).toBe(original.catalog);
    expect(doc.pages[0].dict).toBe(original.pageDict);
    expect(doc.catalog.get('OpenAction')).toBe(originalAction);
    expect(doc.requiresFullRewrite).toBeFalsy();
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('preserves external changes and rejects the encrypted draft if the live document changes', async () => {
    const doc = await fixture();
    const native = globalThis.crypto;
    let injected = false;
    vi.stubGlobal('crypto', {
      subtle: native.subtle,
      getRandomValues(array: Uint8Array) {
        if (!injected) {
          injected = true;
          doc.catalog.set('ConcurrentChange', new PDFString('retain'));
        }
        return native.getRandomValues(array);
      },
    });
    await expect(encryptDocumentObjects(doc, { algorithm: 'AES-128', ownerPassword: 'synthetic' }))
      .rejects.toThrow(/document changed/i);
    expect(doc.catalog.getString('ConcurrentChange')).toBe('retain');
    expect(doc.xref.trailerDict.has('Encrypt')).toBe(false);
  });

  it('publishes successful encryption into the existing graph and reopens the saved PDF', async () => {
    const doc = await fixture();
    const original = identities(doc);
    const context = await encryptDocumentObjects(doc, { algorithm: 'AES-128', userPassword: 'open', ownerPassword: 'owner' });
    expect(doc.objects).toBe(original.objects);
    expect(doc.catalog).toBe(original.catalog);
    expect(doc.xref.trailerDict).toBe(original.trailer);
    expect(doc.pages).toBe(original.pages);
    expect(doc.pages[0]).toBe(original.page);
    expect(doc.pages[0].dict).toBe(original.pageDict);
    expect([...doc.objects.values()]).toContain(original.stream);
    expect(doc.objects.get(context.encrypt.ref!.toKey())).toBe(context.encrypt.dict);
    const reopened = await parsePDF(await serializeDocument(doc));
    await expect(securityEngine.open(reopened, 'open')).resolves.toMatchObject({ role: 'user' });
  });
  it.each([3, 4, 5])('keeps the original graph when public-key encryption RNG fails at call %i', async failAt => {
    const credentials = getTestCredentials();
    const doc = await fixture();
    const before = await serializeDocument(doc);
    const original = identities(doc);
    const calls = failingRandomCall(failAt);
    await expect(new PublicKeyEncryptionEngine().encryptForRecipients(doc, [{ certificateDer: credentials.certificateDer }], { algorithm: 'AES-128' }))
      .rejects.toThrow('synthetic RNG failure');
    expect(calls()).toBe(failAt);
    expect(doc.catalog).toBe(original.catalog);
    expect(doc.xref.trailerDict).toBe(original.trailer);
    expect(doc.pages[0].dict).toBe(original.pageDict);
    expect(doc.xref.trailerDict.has('Encrypt')).toBe(false);
    expect(await serializeDocument(doc)).toEqual(before);
  }, 30000);

  it('saves and reopens a successfully recipient-encrypted PDF', async () => {
    const credentials = getTestCredentials();
    const pkcs8 = decodePem(credentials.pem).find(block => block.label === 'PRIVATE KEY')!.der;
    const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8 as BufferSource,
      { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
    const doc = await fixture();
    const original = identities(doc);
    const content = getPageContentBytes(doc.pages[0], doc.objects).slice();
    const engine = new PublicKeyEncryptionEngine();
    expect(await engine.encryptForRecipients(doc, [{ certificateDer: credentials.certificateDer }], { algorithm: 'AES-128' })).toBe(doc);
    expect(doc.catalog).toBe(original.catalog);
    expect(doc.pages[0].dict).toBe(original.pageDict);
    const reopened = await parsePDF(await serializeDocument(doc));
    await engine.openWithPrivateKey(reopened, privateKey);
    expect(getPageContentBytes(reopened.pages[0], reopened.objects)).toEqual(content);
  }, 30000);

});
