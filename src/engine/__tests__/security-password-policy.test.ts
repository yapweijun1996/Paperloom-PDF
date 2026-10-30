import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { parsePDF } from '../parser/parser';
import { PDFDict, PDFName, PDFString } from '../types';
import { encryptDocumentObjects } from '../security/encryption/encrypt-pipeline';
import { SecurityPolicyEngine } from '../security/policy/policy-engine';
import { serializeDocument } from '../writer/serializer';
import { passwordEngine } from '../security/password/password-engine';
import { securityEngine } from '../security/security-engine';
import { createEncryptionR2R4, createEncryptionR6 } from '../security/encryption/standard-handler';
import { DEFAULT_PERMISSIONS } from '../security/types';

async function fixture() {
  const source = await PDFDocument.create();
  source.setTitle('Retain title on rejected operation');
  source.addPage([200, 200]);
  const doc = await parsePDF(await source.save({ useObjectStreams: false }));
  doc.catalog.set('OpenAction', new PDFDict([['S', new PDFName('JavaScript')], ['JS', new PDFString('alert(1)')]]));
  return doc;
}

describe('security encryption password requirements', () => {
  it('rejects a direct encryption without an explicit non-empty owner password before modifying the document', async () => {
    for (const options of [{}, { userPassword: 'synthetic-open' }, { ownerPassword: '' }]) {
      const doc = await fixture();
      const before = await serializeDocument(doc);
      const idBefore = doc.xref.trailerDict.get('ID');
      await expect(encryptDocumentObjects(doc, options)).rejects.toThrow(/owner password/i);
      expect(await serializeDocument(doc)).toEqual(before);
      expect(doc.xref.trailerDict.get('ID')).toBe(idBefore);
      expect(doc.xref.trailerDict.has('Encrypt')).toBe(false);
    }
  });

  it('built-in encryption policies contain no credentials and reject missing passwords before sanitization', async () => {
    const policy = new SecurityPolicyEngine();
    for (const name of ['Read Only', 'Confidential', 'Highly Confidential', 'Encrypted Archive', 'No Print', 'No Copy']) {
      const definition = policy.getPolicy(name)!;
      expect(definition.encryption?.userPassword).toBeUndefined();
      expect(definition.encryption?.ownerPassword).toBeUndefined();
      const doc = await fixture();
      const before = await serializeDocument(doc);
      await expect(policy.applyPolicy(doc, name)).rejects.toThrow(/owner password/i);
      expect(await serializeDocument(doc)).toEqual(before);
      expect(doc.catalog.has('OpenAction')).toBe(true);
    }
  });

  it('requires an open password for confidential policies but permits owner-only access restrictions', async () => {
    const policy = new SecurityPolicyEngine();
    const doc = await fixture();
    const before = await serializeDocument(doc);
    await expect(policy.applyPolicy(doc, 'Confidential', { ownerPassword: 'synthetic-owner' })).rejects.toThrow(/user password/i);
    expect(await serializeDocument(doc)).toEqual(before);
    const readOnly = await fixture();
    await policy.applyPolicy(readOnly, 'No Copy', { ownerPassword: 'synthetic-owner' });
    expect(readOnly.xref.trailerDict.has('Encrypt')).toBe(true);
  });

  it('does not silently reuse passwords embedded in custom policies', async () => {
    const policy = new SecurityPolicyEngine();
    expect(() => policy.createPolicy({
      name: 'Unsafe saved passwords', description: 'Reject embedded credentials', requireEncryption: true,
      encryption: { userPassword: 'stored-open', ownerPassword: 'stored-owner' },
    })).toThrow(/password/i);
  });

  it('ignores legacy stored policy credentials and rejects before changing the document', async () => {
    const record = [{ name: 'Legacy', requireEncryption: true, encryption: {
      algorithm: 'AES-128', userPassword: 'old-open', ownerPassword: 'old-owner',
    } }];
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(record), setItem: vi.fn() });
    try {
      const policy = new SecurityPolicyEngine();
      expect(policy.getPolicy('Legacy')?.encryption?.ownerPassword).toBeUndefined();
      expect(policy.listPolicyDetails().find(item => item.name === 'Legacy')?.encryption?.userPassword).toBeUndefined();
      const doc = await fixture();
      const before = await serializeDocument(doc);
      await expect(policy.applyPolicy(doc, 'Legacy')).rejects.toThrow(/owner password/i);
      expect(await serializeDocument(doc)).toEqual(before);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('requires an owner password in the public password-key generator too', async () => {
    const fileId = { permanent: new Uint8Array(16), changing: new Uint8Array(16) };
    await expect(passwordEngine.createEncryptionKeys({ userPassword: 'synthetic-open' }, fileId))
      .rejects.toThrow(/owner password/i);
    expect(() => createEncryptionR2R4('synthetic-open', '', DEFAULT_PERMISSIONS, 'AES-128', fileId))
      .toThrow(/owner password/i);
    await expect(createEncryptionR6('synthetic-open', '', DEFAULT_PERMISSIONS)).rejects.toThrow(/owner password/i);
  });

  it('does not pretend to change an already encrypted document', async () => {
    const policy = new SecurityPolicyEngine();
    const doc = await fixture();
    doc.xref.trailerDict.set('Encrypt', new PDFDict());
    const beforeAction = doc.catalog.get('OpenAction');
    await expect(policy.applyPolicy(doc, 'Confidential', {
      userPassword: 'synthetic-open', ownerPassword: 'synthetic-owner',
    })).rejects.toThrow(/already encrypted/i);
    expect(doc.catalog.get('OpenAction')).toBe(beforeAction);
  });

  it('uses the supplied passwords on an encrypted confidential PDF', async () => {
    const policy = new SecurityPolicyEngine();
    const doc = await fixture();
    await policy.applyPolicy(doc, 'Confidential', { userPassword: 'synthetic-open', ownerPassword: 'synthetic-owner' });
    const bytes = await serializeDocument(doc);
    await expect(securityEngine.open(await parsePDF(bytes), 'synthetic-open')).resolves.toMatchObject({ role: 'user' });
    await expect(securityEngine.open(await parsePDF(bytes), 'confidential')).rejects.toThrow();
  }, 30000);
});
