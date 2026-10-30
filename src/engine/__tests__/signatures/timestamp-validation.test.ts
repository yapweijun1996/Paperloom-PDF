import { installSignatureBase } from '../../signatures/crypto/signing-pipeline';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashBytes } from '../../signatures/crypto/hash-engine';
import { parseCMSSignedData, parseDERNode } from '../../signatures/crypto/signature-verify';
import { derInteger, derSequence } from '../../signatures/crypto/cms-builder';
import { buildTimestampRequest, cmsHasTimestampToken, parseTimestampResponse, requestTimestamp } from '../../signatures/timestamp/timestamp-client';
import { validateTimestampToken } from '../../signatures/timestamp/timestamp-validation';
import { importFromPem, parseCertificateDer } from '../../signatures/certificates/certificate-parser';
import { findCmsSignerCertificate, validateSignerCertificate, verifyCmsCryptographic } from '../../signatures/validation/validation-engine';
import { createSignatureField } from '../../signatures/crypto/sign';
import { signDocumentCryptographic } from '../../signatures/crypto/signing-pipeline';
import { parsePDF } from '../../parser/parser';
import { serializeDocument } from '../../writer/serializer';
import { getTestCredentials } from './test-credentials';

const dir = mkdtempSync(join(tmpdir(), 'paperloom-tsa-validation-'));
const cert = join(dir, 'tsa.pem');
const key = join(dir, 'tsa.key');
const config = join(dir, 'tsa.cnf');
const query = join(dir, 'query.tsq');
const response = join(dir, 'response.tsr');
const nonce = new Uint8Array([0x80, 0x42, 0x35, 0xab]);
const data = new TextEncoder().encode('Timestamp test data');

beforeAll(() => {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=Synthetic TSA', '-addext', 'extendedKeyUsage=critical,timeStamping',
    '-keyout', key, '-out', cert], { stdio: 'ignore' });
  const extraCert = join(dir, 'extra.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=Unrelated Certificate', '-keyout', join(dir, 'extra.key'), '-out', extraCert], { stdio: 'ignore' });
  writeFileSync(join(dir, 'serial'), '01\n');
  writeFileSync(config, `[tsa]\ndefault_tsa=tsa_config\n[tsa_config]\nserial=${join(dir, 'serial')}\nsigner_cert=${cert}\nsigner_key=${key}\ncerts=${extraCert}\nsigner_digest=sha256\ndefault_policy=1.2.3.4.1\ndigests=sha256,sha384,sha512\ndefault_md=sha256\n`);
}, 30000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

function reply(request: Uint8Array): Uint8Array {
  writeFileSync(query, request);
  execFileSync('openssl', ['ts', '-reply', '-config', config, '-queryfile', query, '-out', response], { stdio: 'ignore' });
  return new Uint8Array(readFileSync(response));
}

async function responseFor(payload: Uint8Array, requestNonce = nonce): Promise<Uint8Array> {
  return reply(buildTimestampRequest(await hashBytes(payload), { nonce: requestNonce }));
}

function mockTsa(mutator?: (reply: Uint8Array) => Uint8Array) {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const bytes = reply(new Uint8Array(init.body as ArrayBuffer));
    const output = mutator ? mutator(bytes) : bytes;
    return new Response(output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function flipSignature(input: Uint8Array): Uint8Array {
  const copy = input.slice();
  const token = parseTimestampResponse(copy).token!;
  const signature = parseCMSSignedData(token).signerInfos[0].encryptedDigest;
  const index = Buffer.from(copy).indexOf(Buffer.from(signature));
  if (index < 0) throw new Error('Signature not found in test fixture');
  copy[index + signature.length - 1] ^= 1;
  return copy;
}

describe('RFC 3161 response validation', () => {
  it('accepts a real OpenSSL timestamp including an extra unrelated certificate', async () => {
    const bytes = await responseFor(data);
    execFileSync('openssl', ['ts', '-verify', '-queryfile', query, '-in', response, '-CAfile', cert], { stdio: 'ignore' });
    const token = parseTimestampResponse(bytes).token!;
    expect(parseCMSSignedData(token).certificates.length).toBe(2);
    const checked = await validateTimestampToken(token, await hashBytes(data), 'sha256', nonce);
    expect(checked.genTime).toMatch(/^\d{14}Z$/);
    expect(checked.serialNumberHex).toMatch(/^[0-9a-f]+$/);
  });

  it('checks trust and validity against the signer regardless of certificate order', async () => {
    const token = parseTimestampResponse(await responseFor(data)).token!;
    const cms = parseCMSSignedData(token);
    expect((await verifyCmsCryptographic(token)).ok).toBe(true);
    const signerDer = findCmsSignerCertificate(cms)!;
    const extraDer = new Uint8Array(execFileSync('openssl', ['x509', '-in', join(dir, 'extra.pem'), '-outform', 'DER']));
    const signer = await parseCertificateDer(signerDer, 'der');
    const extra = await parseCertificateDer(extraDer, 'der');
    for (const certificates of [cms.certificates, [...cms.certificates].reverse()]) {
      const ordered = { ...cms, certificates };
      const wrongPin = await validateSignerCertificate(ordered, { trustAnchors: [{ fingerprintSha256: extra.fingerprintSha256 }] });
      expect(wrongPin?.fingerprintSha256).toBe(signer.fingerprintSha256);
      expect(wrongPin?.serialNumberHex).toBe(signer.serialNumberHex);
      expect(wrongPin?.subject).toBe(signer.subject.raw);
      expect(wrongPin?.notBefore).toBe(signer.notBefore?.toISOString());
      expect(wrongPin?.notAfter).toBe(signer.notAfter?.toISOString());
      expect(wrongPin?.trusted).toBe(false);
      const signerPin = await validateSignerCertificate(ordered, { trustAnchors: [{ fingerprintSha256: signer.fingerprintSha256 }] });
      expect(signerPin?.fingerprintSha256).toBe(signer.fingerprintSha256);
      expect(signerPin?.trusted).toBe(true);
      const outOfRange = await validateSignerCertificate(ordered, { now: new Date('2000-01-01T00:00:00Z') });
      expect(outOfRange?.expired).toBe(true);
    }
    const signerNode = cms.certificates.find(node => findCmsSignerCertificate({ ...cms, certificates: [node] }));
    expect(signerNode).toBeDefined();
    expect(await validateSignerCertificate({ ...cms, certificates: [...cms.certificates, signerNode!] }, {})).toBeNull();
  });

  it('accepts a nonce with leading zero bytes using canonical DER', async () => {
    const zeroPrefixedNonce = new Uint8Array([0, 0, 0x7f, 0x42]);
    const replyBytes = await responseFor(data, zeroPrefixedNonce);
    const token = parseTimestampResponse(replyBytes).token!;
    await expect(validateTimestampToken(token, await hashBytes(data), 'sha256', zeroPrefixedNonce))
      .resolves.toHaveProperty('genTime');
  });

  it('rejects a valid timestamp for different data or a different nonce', async () => {
    const hash = await hashBytes(data);
    const wrongData = parseTimestampResponse(await responseFor(new TextEncoder().encode('other data'))).token!;
    await expect(validateTimestampToken(wrongData, hash, 'sha256', nonce)).rejects.toThrow(/imprint/i);
    const wrongNonce = parseTimestampResponse(await responseFor(data, new Uint8Array([2]))).token!;
    await expect(validateTimestampToken(wrongNonce, hash, 'sha256', nonce)).rejects.toThrow(/nonce/i);
  });

  it('rejects a tampered signature and a modified encapsulated imprint', async () => {
    const bytes = await responseFor(data);
    const badSignature = parseTimestampResponse(flipSignature(bytes)).token!;
    const hash = await hashBytes(data);
    await expect(validateTimestampToken(badSignature, hash, 'sha256', nonce)).rejects.toThrow(/signature/i);
    const changed = bytes.slice();
    const offset = Buffer.from(changed).indexOf(Buffer.from(hash));
    expect(offset).toBeGreaterThan(0);
    changed[offset] ^= 1;
    const changedHash = hash.slice();
    changedHash[0] ^= 1;
    const tampered = parseTimestampResponse(changed).token!;
    await expect(validateTimestampToken(tampered, changedHash, 'sha256', nonce)).rejects.toThrow(/signed attributes/i);
  });

  it('requests a fresh nonce and validates the actual response before reporting success', async () => {
    const fetch = mockTsa();
    const result = await requestTimestamp({ data, tsaUrl: 'https://example.test/tsa' });
    expect(result, result.error).toMatchObject({ ok: true });
    expect(result.token?.genTime).toMatch(/^\d{14}Z$/);
    expect(result.token?.trust).toBe('unverified');
    const requestBytes = new Uint8Array(fetch.mock.calls[0][1].body as ArrayBuffer);
    const request = parseDERNode(requestBytes);
    const nonces = request.children!.slice(2).filter(node => node.class === 'universal' && node.tag === 2);
    expect(nonces).toHaveLength(1);
    expect(nonces[0].content.length).toBeGreaterThan(0);
    expect(nonces[0].content.length).toBeLessThanOrEqual(17);
  });

  it('does not accept forged or tampered successful responses', async () => {
    const bogus = new Uint8Array(derSequence([...derSequence(derInteger(0)), ...derSequence([])]));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bogus.buffer as ArrayBuffer)));
    expect(await requestTimestamp({ data, tsaUrl: 'https://example.test/tsa', nonce })).toMatchObject({ ok: false, fallback: true, token: null });
    vi.unstubAllGlobals();
    mockTsa(flipSignature);
    expect(await requestTimestamp({ data, tsaUrl: 'https://example.test/tsa', nonce })).toMatchObject({ ok: false, fallback: true, token: null });
  });

  it('embeds only the validated token in a signed PDF and omits a tampered token', async () => {
    async function sign() {
      const input = await PDFDocument.create();
      input.addPage([200, 200]);
      const doc = await parsePDF(await input.save({ useObjectStreams: false }));
      const ref = createSignatureField(doc, 0, { x: 20, y: 20, width: 100, height: 40 }, 'Signature');
      await installSignatureBase(doc, await serializeDocument(doc));
      const signer = await importFromPem(getTestCredentials().pem);
      return signDocumentCryptographic(doc, ref, signer.key!.privateKey, {
        certificateDer: signer.leaf!.der, contentsSize: 8192, enableTimestamp: true, tsaUrl: 'https://example.test/tsa',
      });
    }
    mockTsa();
    const valid = await sign();
    expect(valid.timestampApplied).toBe(true);
    expect(valid.timestampTrust).toBe('unverified');
    expect(cmsHasTimestampToken(valid.cms)).toBe(true);
    vi.unstubAllGlobals();
    mockTsa(flipSignature);
    const bad = await sign();
    expect(bad.timestampApplied).toBe(false);
    expect(bad.timestampTrust).toBeUndefined();
    expect(bad.timestampError).toMatch(/signature/i);
    expect(cmsHasTimestampToken(bad.cms)).toBe(false);
  }, 30000);
});
