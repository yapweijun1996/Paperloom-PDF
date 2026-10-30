import { installSignatureBase } from '../../signatures/crypto/signing-pipeline';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Certificate, CertBag, EncryptedData, PFX } from 'pkijs';
import * as asn1js from 'asn1js';
import { importPkcs12 } from '../../signatures/certificates/pkcs12';
import { CertificateManager } from '../../signatures/certificates/certificate-manager';
import { derSequence } from '../../signatures/crypto/cms-builder';
import { PDFDocument } from 'pdf-lib';
import { parsePDF } from '../../parser/parser';
import { serializeDocument } from '../../writer/serializer';
import { createSignatureField, signDocumentCryptographic, validateDocumentSignatures } from '../../signatures';

const hasOpenSSL = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;
let directory: string;
const pass = 'synthetic-test-password';
function openssl(args: string[]) { execFileSync('openssl', args, { cwd: directory, stdio: 'pipe' }); }
function pfx(name: string): Uint8Array { return new Uint8Array(readFileSync(join(directory, name))); }

describe.skipIf(!hasOpenSSL)('authenticated PKCS#12 import', () => {
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'paperloom-p12-test-'));
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-keyout', 'key.pem', '-out', 'cert.pem', '-nodes', '-days', '2', '-subj', '/CN=Paperloom Synthetic']);
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-keyout', 'other-key.pem', '-out', 'other-cert.pem', '-nodes', '-days', '2', '-subj', '/CN=Other Synthetic']);
    openssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-keyout', 'ec-key.pem', '-out', 'ec-cert.pem', '-nodes', '-days', '2', '-subj', '/CN=EC Synthetic']);
    openssl(['x509', '-in', 'other-cert.pem', '-outform', 'DER', '-out', 'other.der']);
    const base = ['pkcs12', '-export', '-inkey', 'key.pem', '-in', 'cert.pem', '-passout', `pass:${pass}`, '-macalg', 'sha256'];
    const aes = ['-keypbe', 'AES-256-CBC', '-certpbe', 'AES-256-CBC'];
    openssl([...base, ...aes, '-out', 'default.p12']);
    openssl([...base, ...aes, '-certfile', 'other-cert.pem', '-out', 'chain.p12']);
    openssl([...base, ...aes, '-certfile', 'cert.pem', '-out', 'duplicate.p12']);
    openssl([...base, '-keypbe', 'NONE', '-certpbe', 'NONE', '-out', 'plaintext.p12']);
    openssl([...base, ...aes, '-iter', '200001', '-out', 'expensive.p12']);
    openssl([...base, ...aes, '-iter', '200001', '-nomaciter', '-out', 'expensive-safe.p12']);
    openssl([...base, '-keypbe', 'AES-256-CBC', '-certpbe', 'NONE', '-iter', '200001', '-nomaciter', '-out', 'expensive-key.p12']);
    openssl([...base, '-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-out', 'legacy.p12']);
    openssl(['pkcs12', '-export', '-inkey', 'ec-key.pem', '-in', 'ec-cert.pem', '-passout', `pass:${pass}`, '-macalg', 'sha256', ...aes, '-out', 'ec.p12']);
    openssl(['pkcs12', '-export', '-inkey', 'key.pem', '-in', 'cert.pem', '-passout', 'pass:', '-macalg', 'sha256', ...aes, '-out', 'empty-password.p12']);
    openssl(['pkcs12', '-export', '-inkey', 'key.pem', '-in', 'cert.pem', '-passout', 'pass:密码synthetic', '-macalg', 'sha256', ...aes, '-out', 'unicode-password.p12']);
    openssl(['pkcs12', '-export', '-nokeys', '-in', 'cert.pem', '-passout', `pass:${pass}`, '-macalg', 'sha256', ...aes, '-out', 'certificate-only.p12']);
  }, 30_000);
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  it.each(['default.p12', 'plaintext.p12', 'chain.p12'])('imports and matches the private key in %s', async name => {
    const bytes = pfx(name), original = bytes.slice();
    const bundle = await importPkcs12(bytes, pass);
    expect(bytes).toEqual(original);
    expect(bundle.leaf?.subject.commonName).toBe('Paperloom Synthetic');
    expect(bundle.key?.privateKey.extractable).toBe(false);
    expect(bundle.key?.privateKey.usages).toEqual(['sign']);
    expect(bundle.certificates.length).toBe(name === 'chain.p12' ? 2 : 1);
  });

  it('rejects incorrect passwords, corruption and unsupported encryption without adding an identity', async () => {
    const bytes = pfx('default.p12');
    const manager = new CertificateManager(null);
    const initial = await manager.importFile(new File([new Uint8Array(pfx('certificate-only.p12')).buffer], 'public.p12'), pass);
    const file = new File([new Uint8Array(bytes).buffer], 'fixture.p12', { type: 'application/x-pkcs12' });
    await expect(manager.importFile(file, 'incorrect')).rejects.toThrow(/integrity|password/i);
    expect(manager.list().map(identity => identity.id)).toEqual([initial.id]);
    const damaged = bytes.slice(); damaged[damaged.length - 1] ^= 1;
    await expect(importPkcs12(damaged, pass)).rejects.toThrow(/integrity|password/i);
    await expect(importPkcs12(pfx('legacy.p12'), pass)).rejects.toThrow(/unsupported/i);
  });

  it('rejects changed encrypted content before attempting decryption', async () => {
    const input = pfx('default.p12');
    const container = PFX.fromBER(new Uint8Array(input).buffer);
    await container.parseInternalValues({ password: new TextEncoder().encode(pass).buffer, checkIntegrity: true });
    const safe = container.parsedValue!.authenticatedSafe!;
    const section = safe.safeContents.find(item => item.contentType === '1.2.840.113549.1.7.6')!;
    const encrypted = new EncryptedData({ schema: section.content });
    const cipher = new Uint8Array(encrypted.encryptedContentInfo.getEncryptedContent());
    cipher[0] ^= 1;
    encrypted.encryptedContentInfo.encryptedContent = new asn1js.OctetString({ valueHex: cipher.buffer });
    section.content = encrypted.toSchema();
    container.authSafe.content = new asn1js.OctetString({ valueHex: safe.toSchema().toBER(false) });
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
    try {
      await expect(importPkcs12(new Uint8Array(container.toSchema().toBER(false)), pass)).rejects.toThrow(/integrity/i);
      expect(decrypt).not.toHaveBeenCalled();
    } finally { decrypt.mockRestore(); }
  });

  it.each(['expensive-safe.p12', 'expensive-key.p12'])('rejects excessive iterations in %s before derivation', async name => {
    const derive = vi.spyOn(crypto.subtle, 'deriveKey');
    try {
      await expect(importPkcs12(pfx(name), pass)).rejects.toThrow(/derivation.*limits/i);
      expect(derive).not.toHaveBeenCalled();
    } finally { derive.mockRestore(); }
  });

  it('handles EC keys and empty or Unicode passwords', async () => {
    expect((await importPkcs12(pfx('ec.p12'), pass)).key?.algorithm).toBe('ECDSA');
    expect((await importPkcs12(pfx('empty-password.p12'), '')).leaf?.subject.commonName).toBe('Paperloom Synthetic');
    expect((await importPkcs12(pfx('unicode-password.p12'), '密码synthetic')).leaf?.subject.commonName).toBe('Paperloom Synthetic');
  });

  it('preserves certificate-only P12 imports without claiming a signing key', async () => {
    const bundle = await importPkcs12(pfx('certificate-only.p12'), pass);
    expect(bundle.leaf?.subject.commonName).toBe('Paperloom Synthetic');
    expect(bundle.key).toBeNull();
  });

  it('uses the imported key to sign a PDF verifiable by an independent reader', async () => {
    const identity = await importPkcs12(pfx('default.p12'), pass);
    const pdf = await PDFDocument.create(); pdf.addPage([300, 400]);
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    const field = createSignatureField(doc, 0, { x: 20, y: 20, width: 100, height: 40 }, 'Signer');
    await installSignatureBase(doc, await serializeDocument(doc));
    const signed = await signDocumentCryptographic(doc, field, identity.key!.privateKey, {
      certificateDer: identity.leaf!.der, hashAlgorithm: 'sha256', contentsSize: 4096, enableTimestamp: false,
    });
    const report = await validateDocumentSignatures(await parsePDF(signed.bytes), { allowSelfSigned: true });
    expect(report.signatures.some(signature => signature.digestMatch && signature.cmsSignatureOk)).toBe(true);
    if (spawnSync('pdfsig', ['-v'], { stdio: 'ignore' }).status === 0) {
      const output = join(directory, 'signed.pdf'); writeFileSync(output, signed.bytes);
      expect(execFileSync('pdfsig', [output], { encoding: 'utf8' })).toMatch(/Signature is Valid/i);
    }
  }, 30_000);

  it('rejects excessive file sizes and KDF iterations before performing the expensive operation', async () => {
    await expect(importPkcs12(new Uint8Array(1024 * 1024 + 1), pass)).rejects.toThrow(/size limit/i);
    await expect(importPkcs12(pfx('expensive.p12'), pass)).rejects.toThrow(/derivation.*limits/i);
    const file = new File([new ArrayBuffer(1024 * 1024 + 1)], 'large.p12');
    file.arrayBuffer = () => { throw new Error('file was read'); };
    await expect(new CertificateManager(null).importFile(file, pass)).rejects.toThrow(/size limit/i);
    const mutated = PFX.fromBER(new Uint8Array(pfx('default.p12')).buffer);
    mutated.macData!.iterations = 0;
    await expect(importPkcs12(new Uint8Array(mutated.toSchema().toBER(false)), pass)).rejects.toThrow(/derivation.*limits/i);
    let nested = [5, 0];
    for (let i = 0; i < 40; i++) nested = derSequence(nested);
    await expect(importPkcs12(new Uint8Array(nested), pass)).rejects.toThrow(/structure.*limits/i);
  });

  it('rejects a valid MAC when the key does not uniquely match a certificate', async () => {
    await expect(importPkcs12(pfx('duplicate.p12'), pass)).rejects.toThrow(/uniquely match/i);
    const source = PFX.fromBER(new Uint8Array(pfx('plaintext.p12')).buffer);
    const password = new TextEncoder().encode(pass).buffer as ArrayBuffer;
    await source.parseInternalValues({ password, checkIntegrity: true });
    const safe = source.parsedValue!.authenticatedSafe!;
    await safe.parseInternalValues({ safeContents: safe.safeContents.map(() => ({})) });
    let replaced = false;
    for (const section of safe.parsedValue.safeContents) for (const bag of section.value.safeBags) {
      if (bag.bagValue instanceof CertBag) {
        bag.bagValue.parsedValue = Certificate.fromBER(new Uint8Array(readFileSync(join(directory, 'other.der'))).buffer);
        replaced = true;
      }
    }
    expect(replaced).toBe(true);
    await safe.makeInternalValues({ safeContents: safe.safeContents.map(() => ({})) });
    await source.makeInternalValues({ password, iterations: 2048, pbkdf2HashAlgorithm: { name: 'SHA-256' }, hmacHashAlgorithm: 'SHA-256' });
    await expect(importPkcs12(new Uint8Array(source.toSchema().toBER(false)), pass)).rejects.toThrow(/uniquely match/i);
  });
});
