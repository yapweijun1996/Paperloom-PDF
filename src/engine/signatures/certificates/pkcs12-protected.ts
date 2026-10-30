/** Authenticated, bounded PKCS#12 import using WebCrypto-backed PKI.js. */
import * as asn1js from 'asn1js';
import { AlgorithmIdentifier, AuthenticatedSafe, Certificate, CertBag, EncryptedContentInfo, EncryptedData, PBES2Params, PBKDF2Params, PFX, PKCS8ShroudedKeyBag, PrivateKeyInfo, SafeContents } from 'pkijs';
import { importPrivateKey, parseCertificateDer, type CertificateInfo, type ImportedCertificateBundle, type ImportedKeyMaterial } from './certificate-parser';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_NODES = 20_000;
const MAX_DEPTH = 32;
const MAX_ITERATIONS = 200_000;
const MAX_TOTAL_ITERATIONS = 600_000;
const MAX_BAGS = 32;
const DATA = '1.2.840.113549.1.7.1';
const ENCRYPTED_DATA = '1.2.840.113549.1.7.6';
const CERT_BAG = '1.2.840.113549.1.12.10.1.3';
const KEY_BAG = '1.2.840.113549.1.12.10.1.1';
const SHROUDED_KEY_BAG = '1.2.840.113549.1.12.10.1.2';
const X509_CERT = '1.2.840.113549.1.9.22.1';

/** Bound DER parsing before giving untrusted bytes to the ASN.1 library. */
function validateDer(bytes: Uint8Array): void {
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new Error('P12/PFX exceeds the supported size limit.');
  let nodes = 0;
  function read(offset: number, end: number, depth: number): number {
    if (depth > MAX_DEPTH || ++nodes > MAX_NODES || offset >= end) throw new Error('P12/PFX ASN.1 structure exceeds supported limits.');
    const first = bytes[offset++];
    if ((first & 31) === 31) {
      let groups = 0, terminated = false;
      while (offset < end && groups++ < 5) { if ((bytes[offset++] & 128) === 0) { terminated = true; break; } }
      if (!terminated) throw new Error('Invalid P12/PFX ASN.1 tag.');
    }
    if (offset >= end) throw new Error('Invalid P12/PFX ASN.1 length.');
    const lead = bytes[offset++];
    let length = lead;
    if (lead & 128) {
      const count = lead & 127;
      if (!count || count > 4 || offset + count > end || bytes[offset] === 0) throw new Error('Invalid P12/PFX ASN.1 length.');
      length = 0;
      for (let i = 0; i < count; i++) length = length * 256 + bytes[offset++];
      if (length < 128) throw new Error('Invalid P12/PFX ASN.1 length.');
    }
    const limit = offset + length;
    if (limit > end) throw new Error('Invalid P12/PFX ASN.1 content.');
    if (first & 32) while (offset < limit) offset = read(offset, limit, depth + 1);
    return limit;
  }
  if (read(0, bytes.length, 0) !== bytes.length) throw new Error('Unexpected trailing P12/PFX data.');
}

function parseAsn(bytes: Uint8Array) {
  validateDer(bytes);
  const result = asn1js.fromBER(bytes);
  if (result.offset !== bytes.length) throw new Error('Invalid P12/PFX ASN.1 data.');
  return result.result;
}

function copySchema(schema: asn1js.BaseBlock): asn1js.BaseBlock {
  const bytes = new Uint8Array(schema.toBER(false));
  return parseAsn(bytes);
}

function requireOctets(value: unknown, name: string): Uint8Array {
  if (!(value instanceof asn1js.OctetString) || value.idBlock.isConstructed) throw new Error(`Unsupported ${name} in P12/PFX.`);
  return new Uint8Array(value.getValue()).slice();
}

/** PKI.js decodes certificate and plain-key OCTET payloads while constructing
 * SafeContents. Bound those nested structures before that construction. */
function preflightBags(schema: asn1js.BaseBlock): void {
  if (!(schema instanceof asn1js.Sequence) || schema.valueBlock.value.length > MAX_BAGS) throw new Error('P12/PFX contains too many items or invalid safe contents.');
  for (const bag of schema.valueBlock.value) {
    if (!(bag instanceof asn1js.Sequence)) throw new Error('Invalid P12/PFX bag.');
    const [type, wrapper] = bag.valueBlock.value;
    if (!(type instanceof asn1js.ObjectIdentifier) || !(wrapper instanceof asn1js.Constructed) || wrapper.valueBlock.value.length !== 1) throw new Error('Invalid P12/PFX bag.');
    const oid = type.valueBlock.toString();
    const value = wrapper.valueBlock.value[0];
    if (oid === CERT_BAG) {
      if (!(value instanceof asn1js.Sequence)) throw new Error('Invalid P12/PFX certificate bag.');
      const [certType, certWrapper] = value.valueBlock.value;
      if (!(certType instanceof asn1js.ObjectIdentifier) || certType.valueBlock.toString() !== X509_CERT || !(certWrapper instanceof asn1js.Constructed) || certWrapper.valueBlock.value.length !== 1) throw new Error('Unsupported P12/PFX certificate type.');
      validateDer(requireOctets(certWrapper.valueBlock.value[0], 'certificate'));
    } else if (oid === KEY_BAG) {
      if (!(value instanceof asn1js.Sequence)) throw new Error('Invalid P12/PFX private key bag.');
      const keyBytes = requireOctets(value.valueBlock.value[2], 'private key');
      try { validateDer(keyBytes); } finally { keyBytes.fill(0); }
    } else if (oid !== SHROUDED_KEY_BAG) throw new Error('Unsupported P12/PFX bag type.');
  }
}

function pbes2(algorithm: AlgorithmIdentifier, charge: (count: number) => void): void {
  if (algorithm.algorithmId !== '1.2.840.113549.1.5.13' || !algorithm.algorithmParams) throw new Error('Unsupported P12/PFX encryption algorithm.');
  const params = new PBES2Params({ schema: copySchema(algorithm.algorithmParams) });
  if (params.keyDerivationFunc.algorithmId !== '1.2.840.113549.1.5.12' || !params.keyDerivationFunc.algorithmParams) throw new Error('Unsupported P12/PFX key derivation.');
  const kdf = new PBKDF2Params({ schema: copySchema(params.keyDerivationFunc.algorithmParams) });
  const salt = requireOctets(kdf.salt, 'salt');
  if (salt.length < 8 || salt.length > 64) throw new Error('Unsupported P12/PFX salt length.');
  const keyBytes: Record<string, number> = { '2.16.840.1.101.3.4.1.2': 16, '2.16.840.1.101.3.4.1.22': 24, '2.16.840.1.101.3.4.1.42': 32 };
  const expectedKeyBytes = keyBytes[params.encryptionScheme.algorithmId];
  if (!expectedKeyBytes || (kdf.keyLength !== undefined && kdf.keyLength !== expectedKeyBytes)) throw new Error('Unsupported P12/PFX cipher.');
  if (requireOctets(params.encryptionScheme.algorithmParams, 'IV').length !== 16) throw new Error('Unsupported P12/PFX IV.');
  const prf = kdf.prf?.algorithmId ?? '1.2.840.113549.2.7';
  if (!['1.2.840.113549.2.7', '1.2.840.113549.2.9', '1.2.840.113549.2.10', '1.2.840.113549.2.11'].includes(prf)) throw new Error('Unsupported P12/PFX PRF.');
  charge(kdf.iterationCount);
}

async function matchCertificate(key: ImportedKeyMaterial, cert: CertificateInfo): Promise<boolean> {
  try {
    const certificate = Certificate.fromBER(new Uint8Array(cert.der).buffer);
    const spki = certificate.subjectPublicKeyInfo.toSchema().toBER(false);
    const algorithm = key.algorithm === 'RSA'
      ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
      : { name: 'ECDSA', namedCurve: (key.privateKey.algorithm as EcKeyAlgorithm).namedCurve };
    const publicKey = await crypto.subtle.importKey('spki', spki, algorithm, false, ['verify']);
    const signAlgorithm = key.algorithm === 'RSA' ? { name: 'RSASSA-PKCS1-v1_5' } : { name: 'ECDSA', hash: 'SHA-256' };
    const challenge = new TextEncoder().encode('Paperloom PKCS#12 identity check');
    const signature = await crypto.subtle.sign(signAlgorithm, key.privateKey, challenge);
    return await crypto.subtle.verify(signAlgorithm, publicKey, signature, challenge);
  } catch { return false; }
}

export async function importAuthenticatedPkcs12(bytes: Uint8Array, password: string, label: string): Promise<ImportedCertificateBundle> {
  if (new TextEncoder().encode(password).length > 1024) throw new Error('P12/PFX password is too long.');
  const schema = parseAsn(bytes);
  const pfx = new PFX({ schema });
  if (pfx.version !== 3 || pfx.authSafe.contentType !== DATA || !pfx.macData) throw new Error('P12/PFX requires a supported password-based integrity check.');
  const salt = requireOctets(pfx.macData.macSalt, 'MAC salt');
  if (salt.length < 8 || salt.length > 64) throw new Error('Unsupported P12/PFX MAC salt length.');
  const digest = pfx.macData.mac.digestAlgorithm.algorithmId;
  const lengths: Record<string, number> = { '1.3.14.3.2.26': 20, '2.16.840.1.101.3.4.2.1': 32, '2.16.840.1.101.3.4.2.2': 48, '2.16.840.1.101.3.4.2.3': 64 };
  if (!lengths[digest] || requireOctets(pfx.macData.mac.digest, 'MAC').length !== lengths[digest]) throw new Error('Unsupported P12/PFX integrity algorithm.');
  let totalIterations = 0;
  const charge = (count: number) => {
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_ITERATIONS || totalIterations + count > MAX_TOTAL_ITERATIONS) throw new Error('P12/PFX key derivation exceeds supported limits.');
    totalIterations += count;
  };
  charge(pfx.macData.iterations ?? 1);
  const authBytes = requireOctets(pfx.authSafe.content, 'authenticated safe');
  parseAsn(authBytes);
  const passwordBytes = new TextEncoder().encode(password);
  const passwordBuffer = passwordBytes.buffer as ArrayBuffer;
  try {
    try { await pfx.parseInternalValues({ password: passwordBuffer, checkIntegrity: true }); }
    catch { throw new Error('P12/PFX integrity check failed or password is incorrect.'); }
    const safe = pfx.parsedValue?.authenticatedSafe;
    if (!(safe instanceof AuthenticatedSafe) || safe.safeContents.length > MAX_BAGS) throw new Error('P12/PFX contains too many safe contents.');
    const certificates: CertificateInfo[] = [];
    const keys: ImportedKeyMaterial[] = [];
    let count = 0;
    for (const section of safe.safeContents) {
      let safeBytes: Uint8Array;
      if (section.contentType === DATA) safeBytes = requireOctets(section.content, 'safe contents');
      else if (section.contentType === ENCRYPTED_DATA) {
        const encrypted = new EncryptedData({ schema: copySchema(section.content) });
        pbes2(encrypted.encryptedContentInfo.contentEncryptionAlgorithm, charge);
        try { safeBytes = new Uint8Array(await encrypted.decrypt({ password: passwordBuffer })); }
        catch { throw new Error('P12/PFX decryption failed.'); }
      } else throw new Error('Unsupported P12/PFX safe contents.');
      try {
        const safeSchema = parseAsn(safeBytes);
        preflightBags(safeSchema);
        const contents = new SafeContents({ schema: safeSchema });
        count += contents.safeBags.length;
        if (count > MAX_BAGS) throw new Error('P12/PFX contains too many items.');
        for (const bag of contents.safeBags) {
          if (bag.bagId === CERT_BAG && bag.bagValue instanceof CertBag) {
            if (bag.bagValue.certId !== X509_CERT) throw new Error('Unsupported P12/PFX certificate type.');
            const der = requireOctets(bag.bagValue.certValue, 'certificate');
            parseAsn(der);
            certificates.push(await parseCertificateDer(der, 'p12'));
          } else if (bag.bagId === SHROUDED_KEY_BAG && bag.bagValue instanceof PKCS8ShroudedKeyBag) {
            pbes2(bag.bagValue.encryptionAlgorithm, charge);
            const encrypted = new EncryptedData({ encryptedContentInfo: new EncryptedContentInfo({ contentEncryptionAlgorithm: bag.bagValue.encryptionAlgorithm, encryptedContent: bag.bagValue.encryptedData }) });
            let keyDer: Uint8Array;
            try { keyDer = new Uint8Array(await encrypted.decrypt({ password: passwordBuffer })); }
            catch { throw new Error('P12/PFX private key decryption failed.'); }
            try { validateDer(keyDer); keys.push(await importPrivateKey(keyDer)); }
            finally { keyDer.fill(0); }
          } else if (bag.bagId === KEY_BAG && bag.bagValue instanceof PrivateKeyInfo) {
            const keyDer = new Uint8Array(bag.bagValue.toSchema().toBER(false));
            try { validateDer(keyDer); keys.push(await importPrivateKey(keyDer)); }
            finally { keyDer.fill(0); }
          } else throw new Error('Unsupported P12/PFX bag type.');
        }
      } finally { safeBytes.fill(0); }
    }
    if (!certificates.length || keys.length > 1) throw new Error('P12/PFX must contain certificates and at most one private key.');
    if (!keys.length) {
      const leaf = certificates[0];
      return { certificates, leaf, key: null, chain: certificates, source: 'p12', label: leaf.subject.commonName ?? label };
    }
    const matches: CertificateInfo[] = [];
    for (const cert of certificates) if (await matchCertificate(keys[0], cert)) matches.push(cert);
    if (matches.length !== 1) throw new Error('P12/PFX private key does not uniquely match a certificate.');
    const leaf = matches[0];
    return { certificates, leaf, key: keys[0], chain: [leaf, ...certificates.filter(cert => cert !== leaf)], source: 'p12', label: leaf.subject.commonName ?? label };
  } finally { passwordBytes.fill(0); }
}
