import { readFileSync } from 'fs';
import { join } from 'path';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';
import { securityEngine } from '../security';
import { createSignedRecoverySnapshot, restoreSignedRecoverySnapshot } from '../session/signed-recovery';
import { PDFArray, PDFDict, PDFHexString, PDFNumber, PDFStream } from '../types';
import { insertBlankPage } from '../writer/page-operations';
import { serializeDocument } from '../writer/serializer';
import { saveOptimized, saveQuick, SignedDocumentEditError } from '../writer/save-pipeline';

async function signedFixture() {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]).drawText('Original content');
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  doc.catalog.set('TestSignature', new PDFDict([
    ['ByteRange', new PDFArray([0, 10, 20, 10].map(n => new PDFNumber(n)))],
    ['Contents', new PDFHexString('01020304')],
  ]));
  return parsePDF(await serializeDocument(doc));
}

describe('signed recovery drafts', () => {
  it('restores page and stream edits while retaining the finalized source and save guard', async () => {
    const original = await signedFixture();
    const edited = await parsePDF(original.rawBytes.slice());
    insertBlankPage(edited, 1, { x: 0, y: 0, width: 200, height: 200 });
    const stream = edited.objects.get(edited.pages[0].contentRefs[0].toKey()) as PDFStream;
    stream.rawBytes = new TextEncoder().encode('Recovered stream edit');
    const snapshot = await createSignedRecoverySnapshot(edited);
    const restored = await restoreSignedRecoverySnapshot(original, snapshot);
    expect(restored.pages).toHaveLength(2);
    expect(new TextDecoder().decode((restored.objects.get(restored.pages[0].contentRefs[0].toKey()) as PDFStream).rawBytes)).toBe('Recovered stream edit');
    expect(restored.rawBytes).toEqual(original.rawBytes);
    expect(restored.rawBytes).not.toBe(original.rawBytes);
    await expect(saveQuick(restored)).rejects.toBeInstanceOf(SignedDocumentEditError);
    await expect(saveOptimized(restored)).rejects.toBeInstanceOf(SignedDocumentEditError);
    expect(original.pages).toHaveLength(1);
  });

  it('refuses corrupt, foreign and non-signed originals', async () => {
    const original = await signedFixture();
    const snapshot = await createSignedRecoverySnapshot(original);
    const envelope = JSON.parse(snapshot);
    envelope.payload += ' ';
    await expect(restoreSignedRecoverySnapshot(original, JSON.stringify(envelope))).rejects.toThrow(/corrupt or belongs/);
    await expect(restoreSignedRecoverySnapshot(original, '{broken')).rejects.toThrow(/corrupt or belongs/);
    const other = await signedFixture();
    other.rawBytes = new Uint8Array([...other.rawBytes, 10]);
    await expect(restoreSignedRecoverySnapshot(other, snapshot)).rejects.toThrow(/different document/);
    original.rawBytes = new TextEncoder().encode('%PDF-1.7');
    await expect(restoreSignedRecoverySnapshot(original, snapshot)).rejects.toThrow(/original signed PDF/);
  });

  it('keeps the original signature guard even when the draft removes the signature object', async () => {
    const original = await signedFixture();
    const edited = await parsePDF(original.rawBytes.slice());
    edited.catalog.delete('TestSignature');
    const restored = await restoreSignedRecoverySnapshot(original, await createSignedRecoverySnapshot(edited));
    expect(restored.catalog.has('TestSignature')).toBe(false);
    await expect(saveQuick(restored)).rejects.toBeInstanceOf(SignedDocumentEditError);
  });

  it('does not persist the authenticated key and restores it only from an unlocked original', async () => {
    const fixture = new Uint8Array(readFileSync(join(__dirname, 'fixtures/encrypted/aes-128-r4.pdf')));
    // Signature markers exercise the same guard as signed production bytes;
    // the original AES fixture supplies the real encryption context.
    const suffix = new TextEncoder().encode('\n% /ByteRange [0 10 20 10] /Contents <01020304>\n');
    const bytes = new Uint8Array(fixture.length + suffix.length);
    bytes.set(fixture);
    bytes.set(suffix, fixture.length);
    const locked = await parsePDF(bytes);
    const original = (await securityEngine.open(await parsePDF(bytes), 'userpass')).doc;
    const edited = (await securityEngine.open(await parsePDF(bytes), 'userpass')).doc;
    edited.pages[0].dict.set('Rotate', new PDFNumber(90));
    const snapshot = await createSignedRecoverySnapshot(edited);
    expect(snapshot).not.toContain('encryptionFileKey');
    expect(snapshot).not.toContain('userpass');
    await expect(restoreSignedRecoverySnapshot(locked, snapshot)).rejects.toThrow(/unlocked/);
    const restored = await restoreSignedRecoverySnapshot(original, snapshot);
    expect(restored.encryptionFileKey).toEqual(original.encryptionFileKey);
    expect(restored.encryptionFileKey).not.toBe(original.encryptionFileKey);
    expect(restored.rawBytes).toEqual(bytes);
    expect(restored.pages[0].dict.getNumber('Rotate')).toBe(90);
    await expect(saveQuick(restored)).rejects.toBeInstanceOf(SignedDocumentEditError);
  }, 30000);
});
