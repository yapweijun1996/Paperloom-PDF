import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';
import { PDFDict, PDFName, PDFRef, PDFString } from '../types';
import { securityEngine } from '../security';
import { appendIncrementalUpdate, saveIncremental } from '../writer/incremental-writer';
import { saveQuick } from '../writer/save-pipeline';
import { signDocumentCryptographic } from '../signatures/crypto/signing-pipeline';
import { embedDssIncremental } from '../signatures/ltv/dss-builder';

const source = () => new Uint8Array(readFileSync(join(__dirname, 'fixtures/encrypted/aes-128-r4.pdf')));

async function opened() {
  return (await securityEngine.open(await parsePDF(source()), 'userpass')).doc;
}

describe('encrypted document incremental output', () => {
  it('refuses direct incremental output for authenticated decrypted content without mutation', async () => {
    const doc = await opened();
    const page = doc.pages[0];
    page.dict.set('PrivateMarker', new PDFString('PRIVATE_PLAINTEXT_MARKER'));
    const original = doc.rawBytes.slice();
    const objCount = doc.objects.size;
    const newRef = new PDFRef(900, 0);
    const newObjects = new Map([[newRef.toKey(), new PDFString('PRIVATE_NEW_OBJECT')]]);
    expect(() => appendIncrementalUpdate(doc, new Set([page.ref.toKey()]), newObjects)).toThrow(/encrypt/i);
    expect(doc.rawBytes).toEqual(original);
    expect(doc.objects.size).toBe(objCount);
    expect(doc.objects.has(newRef.toKey())).toBe(false);
    expect(page.dict.getString('PrivateMarker')).toBe('PRIVATE_PLAINTEXT_MARKER');
  });

  it('also refuses incremental output before authentication', async () => {
    const doc = await parsePDF(source());
    const original = doc.rawBytes.slice();
    expect(() => saveIncremental(doc, new Set([doc.pages[0].ref.toKey()]))).toThrow(/encrypt/i);
    expect(doc.rawBytes).toEqual(original);
  });

  it('refuses signing and DSS embedding before their objects are changed', async () => {
    const doc = await opened();
    const fieldRef = new PDFRef(901, 0);
    const field = new PDFDict([['FT', new PDFName('Sig')]]);
    doc.objects.set(fieldRef.toKey(), field);
    const count = doc.objects.size;
    const original = doc.rawBytes.slice();
    await expect(signDocumentCryptographic(doc, fieldRef, {} as CryptoKey)).rejects.toThrow(/encrypt/i);
    expect(() => embedDssIncremental(doc, {})).toThrow(/encrypt/i);
    expect(field.has('V')).toBe(false);
    expect(doc.catalog.has('DSS')).toBe(false);
    expect(doc.objects.size).toBe(count);
    expect(doc.rawBytes).toEqual(original);
  });

  it('quick save still securely rewrites an authenticated encrypted PDF and reopens it', async () => {
    const doc = await opened();
    doc.pages[0].dict.set('PrivateMarker', new PDFString('PRIVATE_PLAINTEXT_MARKER'));
    const bytes = await saveQuick(doc, new Set([doc.pages[0].ref.toKey()]));
    expect(new TextDecoder().decode(bytes)).not.toContain('PRIVATE_PLAINTEXT_MARKER');
    const parsed = await parsePDF(bytes);
    expect(parsed.xref.trailerDict.has('Encrypt')).toBe(true);
    const reopened = await securityEngine.open(parsed, 'userpass');
    expect(reopened.doc.pages[0].dict.getString('PrivateMarker')).toBe('PRIVATE_PLAINTEXT_MARKER');
    const reader = spawnSync('pdfinfo', ['-upw', 'userpass', '-'], { input: bytes, encoding: 'utf8' });
    if (!reader.error) { expect(reader.status).toBe(0); expect(reader.stdout).toMatch(/Encrypted:\s+yes/i); }
  });

  it('requires a full rewrite when encryption is explicitly removed', async () => {
    const original = source();
    const doc = await securityEngine.decrypt(await parsePDF(original), 'userpass');
    expect(doc.xref.trailerDict.has('Encrypt')).toBe(false);
    expect(doc.requiresFullRewrite).toBe(true);
    expect(() => saveIncremental(doc, new Set([doc.pages[0].ref.toKey()]))).toThrow(/full rewrite/i);
    const output = await saveQuick(doc);
    expect(Buffer.from(output).subarray(0, original.length).equals(Buffer.from(original))).toBe(false);
    const reopened = await parsePDF(output);
    expect(reopened.xref.trailerDict.has('Encrypt')).toBe(false);
    expect(reopened.pages.length).toBe(doc.pages.length);
    const reader = spawnSync('pdfinfo', ['-'], { input: output, encoding: 'utf8' });
    if (!reader.error) { expect(reader.status).toBe(0); expect(reader.stdout).toMatch(/Encrypted:\s+no/i); }
  });
});
