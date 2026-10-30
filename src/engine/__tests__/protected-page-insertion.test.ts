import { installSignatureBase } from '../signatures/crypto/signing-pipeline';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { parsePDF } from '../parser/parser';
import { securityEngine } from '../security/security-engine';
import { SessionDocumentEditor } from '../session/document-edit';
import { createSignedRecoverySnapshot, restoreSignedRecoverySnapshot } from '../session/signed-recovery';
import { createSignatureField } from '../signatures/crypto/sign';
import { signDocumentCryptographic } from '../signatures/crypto/signing-pipeline';
import { importFromPem } from '../signatures/certificates/certificate-parser';
import { validateDocumentSignatures } from '../signatures/validation/validation-engine';
import { getTestCredentials } from './signatures/test-credentials';
import { dehydrateDocument } from '../worker/codec';
import { insertPagesFromDocument } from '../writer/page-operations';
import { serializeDocument } from '../writer/serializer';
import { saveQuick, SignedDocumentEditError } from '../writer/save-pipeline';

async function blank() {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  return parsePDF(await pdf.save({ useObjectStreams: false }));
}

async function signed() {
  const doc = await blank();
  const field = createSignatureField(doc, 0, { x: 20, y: 20, width: 80, height: 40 }, 'Signature');
  await installSignatureBase(doc, await serializeDocument(doc));
  const identity = await importFromPem(getTestCredentials().pem);
  const result = await signDocumentCryptographic(doc, field, identity.key!.privateKey, { certificateDer: identity.leaf!.der });
  return parsePDF(result.bytes);
}

function encryptedFixture(): Uint8Array {
  return new Uint8Array(readFileSync(join(__dirname, 'fixtures/encrypted/aes-128-r4.pdf')));
}

describe('protected page insertion', () => {
  it('rejects a genuinely signed source without changing either document', async () => {
    const source = await signed();
    const target = await blank();
    expect((await validateDocumentSignatures(source)).signatures[0].digestMatch).toBe(true);
    const sourceBefore = dehydrateDocument(source);
    const targetBefore = dehydrateDocument(target);
    expect(() => insertPagesFromDocument(target, source, 1)).toThrow(/signed.*signatures.*invalid/i);
    expect(dehydrateDocument(source)).toEqual(sourceBefore);
    expect(dehydrateDocument(target)).toEqual(targetBefore);
    expect((await validateDocumentSignatures(source)).signatures[0].digestMatch).toBe(true);
  }, 30000);

  it.each(['locked', 'unlocked'] as const)('rejects a %s protected source without changing either document', async state => {
    const parsed = await parsePDF(encryptedFixture());
    const source = state === 'locked' ? parsed : (await securityEngine.open(parsed, 'userpass')).doc;
    const target = await blank();
    const sourceBefore = dehydrateDocument(source);
    const targetBefore = dehydrateDocument(target);
    expect(() => insertPagesFromDocument(target, source, 1)).toThrow(/password-protected source/i);
    expect(dehydrateDocument(source)).toEqual(sourceBefore);
    expect(dehydrateDocument(target)).toEqual(targetBefore);
  }, 30000);

  it('rejects a locked target before modifying either document', async () => {
    const target = await parsePDF(encryptedFixture());
    const source = await blank();
    const targetBefore = dehydrateDocument(target);
    const sourceBefore = dehydrateDocument(source);
    expect(() => insertPagesFromDocument(target, source, 1)).toThrow(/unlock the target/i);
    expect(dehydrateDocument(target)).toEqual(targetBefore);
    expect(dehydrateDocument(source)).toEqual(sourceBefore);
  });

  it('rejects a protected target without its authenticated key before modifying it', async () => {
    const target = (await securityEngine.open(await parsePDF(encryptedFixture()), 'userpass')).doc;
    delete target.encryptionFileKey;
    const source = await blank();
    const targetBefore = dehydrateDocument(target);
    const sourceBefore = dehydrateDocument(source);
    expect(() => insertPagesFromDocument(target, source, 1)).toThrow(/authenticated encryption context/i);
    expect(dehydrateDocument(target)).toEqual(targetBefore);
    expect(dehydrateDocument(source)).toEqual(sourceBefore);
  }, 30000);

  it('preserves password protection when inserting into an unlocked target through a session', async () => {
    const target = (await securityEngine.open(await parsePDF(encryptedFixture()), 'userpass')).doc;
    const source = await blank();
    const editor = new SessionDocumentEditor();
    await editor.edit(target, 'insert-pages', async staged => { insertPagesFromDocument(staged, source, 1); });
    const bytes = await saveQuick(target);
    await expect(securityEngine.open(await parsePDF(bytes), 'wrong')).rejects.toThrow(/password/i);
    expect((await securityEngine.open(await parsePDF(bytes), 'userpass')).doc.pages).toHaveLength(2);
  }, 30000);

  it('allows signed-target drafts to be recovered while signed export remains blocked', async () => {
    const original = await signed();
    const edited = await parsePDF(original.rawBytes.slice());
    const source = await blank();
    const editor = new SessionDocumentEditor();
    await editor.edit(edited, 'insert-pages', async staged => { insertPagesFromDocument(staged, source, 1); });
    expect(edited.rawBytes).toEqual(original.rawBytes);
    const restored = await restoreSignedRecoverySnapshot(original, await createSignedRecoverySnapshot(edited));
    expect(restored.pages).toHaveLength(2);
    expect(restored.rawBytes).toEqual(original.rawBytes);
    await expect(saveQuick(restored)).rejects.toBeInstanceOf(SignedDocumentEditError);
    expect((await validateDocumentSignatures(original)).signatures[0].digestMatch).toBe(true);
  }, 30000);
});
