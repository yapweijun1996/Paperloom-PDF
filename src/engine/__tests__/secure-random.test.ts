import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from '../security/crypto/bytes';
import { ensureFileId } from '../security/encryption/encrypt-dict';
import { encryptDocumentObjects } from '../security/encryption/encrypt-pipeline';
import { SecurityPolicyEngine } from '../security/policy/policy-engine';
import { parsePDF } from '../parser/parser';
import { PDFDict, PDFName, PDFString } from '../types';
import { serializeDocument } from '../writer/serializer';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('secure random number generation', () => {
  it('fails closed without Web Crypto instead of falling back to Math.random', () => {
    vi.stubGlobal('crypto', undefined);
    const insecure = vi.spyOn(Math, 'random');
    expect(() => randomBytes(16)).toThrow(/secure random number generator/i);
    const trailer = new PDFDict();
    expect(() => ensureFileId(trailer)).toThrow(/secure random number generator/i);
    expect(trailer.has('ID')).toBe(false);
    expect(insecure).not.toHaveBeenCalled();
  });

  it('uses only the secure provider and respects its per-call length limit', () => {
    const lengths: number[] = [];
    vi.stubGlobal('crypto', { getRandomValues: (array: Uint8Array) => {
      lengths.push(array.length);
      array.fill(lengths.length);
      return array;
    } });
    const bytes = randomBytes(65539);
    expect(lengths).toEqual([65536, 3]);
    expect(bytes[0]).toBe(1);
    expect(bytes[65535]).toBe(1);
    expect([...bytes.slice(-3)]).toEqual([2, 2, 2]);
  });

  it('rejects encryption before mutation even when an existing file ID is present', async () => {
    const input = await PDFDocument.create();
    input.addPage([100, 100]);
    const doc = await parsePDF(await input.save({ useObjectStreams: false }));
    ensureFileId(doc.xref.trailerDict);
    const before = await serializeDocument(doc);
    vi.stubGlobal('crypto', undefined);
    await expect(encryptDocumentObjects(doc, { algorithm: 'AES-128', ownerPassword: 'synthetic' }))
      .rejects.toThrow(/secure random number generator/i);
    expect(doc.xref.trailerDict.has('Encrypt')).toBe(false);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('rejects an encrypting policy before sanitizing when secure randomness is unavailable', async () => {
    const input = await PDFDocument.create();
    input.setTitle('Retain this metadata');
    input.addPage([100, 100]);
    const doc = await parsePDF(await input.save({ useObjectStreams: false }));
    doc.catalog.set('OpenAction', new PDFDict([['S', new PDFName('JavaScript')], ['JS', new PDFString('alert(1)')]]));
    const before = await serializeDocument(doc);
    vi.stubGlobal('crypto', undefined);
    await expect(new SecurityPolicyEngine().applyPolicy(doc, 'Confidential', {
      ownerPassword: 'synthetic-owner', userPassword: 'synthetic-user',
    })).rejects.toThrow(/secure random number generator/i);
    expect(doc.catalog.has('OpenAction')).toBe(true);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('propagates failures from the secure provider instead of generating weak bytes', () => {
    vi.stubGlobal('crypto', { getRandomValues: () => { throw new Error('Provider failed'); } });
    const insecure = vi.spyOn(Math, 'random');
    expect(() => randomBytes(16)).toThrow('Provider failed');
    expect(insecure).not.toHaveBeenCalled();
  });
});
