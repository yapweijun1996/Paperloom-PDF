/**
 * Phase 9 — X.509 certificate / key parser (PEM, DER).
 * Uses existing ASN.1 DER reader; imports keys via WebCrypto.
 */

import { parseDER, decodeOID, nodeOID, parseDERNode } from '../crypto/signature-verify';
import type { ASN1Node } from '../crypto/types';
import { hashBytes, bytesToHex } from '../crypto/hash-engine';

export type CertificateFormat = 'pem' | 'der' | 'pfx' | 'p12';

export interface DistinguishedName {
  commonName?: string;
  organization?: string;
  organizationalUnit?: string;
  country?: string;
  locality?: string;
  state?: string;
  email?: string;
  raw: string;
}

export interface CertificateInfo {
  id: string;
  format: CertificateFormat;
  /** DER-encoded certificate. */
  der: Uint8Array;
  subject: DistinguishedName;
  issuer: DistinguishedName;
  serialNumberHex: string;
  notBefore: Date | null;
  notAfter: Date | null;
  publicKeyAlgorithm: string;
  fingerprintSha256: string;
  /** PEM text if available. */
  pem?: string;
}

export interface ImportedKeyMaterial {
  privateKey: CryptoKey;
  publicKey?: CryptoKey;
  algorithm: 'RSA' | 'ECDSA';
  extractable: boolean;
}

export interface ImportedCertificateBundle {
  certificates: CertificateInfo[];
  /** Leaf (end-entity) certificate — usually first. */
  leaf: CertificateInfo | null;
  key: ImportedKeyMaterial | null;
  chain: CertificateInfo[];
  source: CertificateFormat;
  label: string;
}

const OID_CN = '2.5.4.3';
const OID_O = '2.5.4.10';
const OID_OU = '2.5.4.11';
const OID_C = '2.5.4.6';
const OID_L = '2.5.4.7';
const OID_ST = '2.5.4.8';
const OID_EMAIL = '1.2.840.113549.1.9.1';
const OID_RSA = '1.2.840.113549.1.1.1';
const OID_EC = '1.2.840.10045.2.1';

function nextId(): string {
  return `cert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function asn1String(node: ASN1Node | undefined): string {
  if (!node) return '';
  try {
    return new TextDecoder().decode(node.content);
  } catch {
    return Array.from(node.content)
      .map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ''))
      .join('');
  }
}

function parseName(node: ASN1Node | undefined): DistinguishedName {
  const dn: DistinguishedName = { raw: '' };
  const parts: string[] = [];
  if (!node?.children) return dn;

  for (const rdn of node.children) {
    const atv = rdn.children?.[0] ?? rdn;
    const oid = nodeOID(atv.children?.[0] ?? atv);
    const val = asn1String(atv.children?.[1]);
    if (!val) continue;
    switch (oid) {
      case OID_CN:
        dn.commonName = val;
        parts.push(`CN=${val}`);
        break;
      case OID_O:
        dn.organization = val;
        parts.push(`O=${val}`);
        break;
      case OID_OU:
        dn.organizationalUnit = val;
        parts.push(`OU=${val}`);
        break;
      case OID_C:
        dn.country = val;
        parts.push(`C=${val}`);
        break;
      case OID_L:
        dn.locality = val;
        parts.push(`L=${val}`);
        break;
      case OID_ST:
        dn.state = val;
        parts.push(`ST=${val}`);
        break;
      case OID_EMAIL:
        dn.email = val;
        parts.push(`E=${val}`);
        break;
      default:
        parts.push(`${oid}=${val}`);
    }
  }
  dn.raw = parts.join(', ');
  return dn;
}

function parseTime(node: ASN1Node | undefined): Date | null {
  if (!node) return null;
  const s = asn1String(node);
  try {
    if (s.length >= 13 && s.endsWith('Z')) {
      if (node.tag === 0x17 || s.length === 13) {
        const yy = parseInt(s.slice(0, 2), 10);
        const year = yy >= 50 ? 1900 + yy : 2000 + yy;
        return new Date(
          Date.UTC(
            year,
            parseInt(s.slice(2, 4), 10) - 1,
            parseInt(s.slice(4, 6), 10),
            parseInt(s.slice(6, 8), 10),
            parseInt(s.slice(8, 10), 10),
            parseInt(s.slice(10, 12), 10),
          ),
        );
      }
      return new Date(
        Date.UTC(
          parseInt(s.slice(0, 4), 10),
          parseInt(s.slice(4, 6), 10) - 1,
          parseInt(s.slice(6, 8), 10),
          parseInt(s.slice(8, 10), 10),
          parseInt(s.slice(10, 12), 10),
          parseInt(s.slice(12, 14), 10),
        ),
      );
    }
  } catch {
    return null;
  }
  return null;
}

function derToPem(der: Uint8Array, label: string): string {
  let b64: string;
  if (typeof btoa === 'function') {
    let s = '';
    for (let i = 0; i < der.length; i++) s += String.fromCharCode(der[i]);
    b64 = btoa(s);
  } else {
    b64 = Buffer.from(der).toString('base64');
  }
  const lines = b64.match(/.{1,64}/g) ?? [b64];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/** Detect and strip PEM armor; returns DER bytes + label. */
export function decodePem(pem: string): { der: Uint8Array; label: string }[] {
  const re = /-----BEGIN ([A-Z0-9 ]+)-----([^-]+)-----END \1-----/g;
  const out: { der: Uint8Array; label: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(pem)) !== null) {
    const label = m[1].trim();
    const b64 = m[2].replace(/\s+/g, '');
    const bin =
      typeof atob === 'function'
        ? atob(b64)
        : Buffer.from(b64, 'base64').toString('binary');
    const der = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i) & 0xff;
    out.push({ der, label });
  }
  return out;
}

export function isPem(text: string): boolean {
  return /-----BEGIN [A-Z0-9 ]+-----/.test(text);
}

/**
 * Parse a single X.509 certificate from DER.
 */
export async function parseCertificateDer(
  der: Uint8Array,
  format: CertificateFormat = 'der',
): Promise<CertificateInfo> {
  const root = parseDERNode(der, 0);
  const tbs = root.children?.[0];
  if (!tbs?.children) throw new Error('Invalid X.509 certificate DER');

  let idx = 0;
  if (tbs.children[0]?.class === 'context') idx = 1;
  const serialNode = tbs.children[idx++];
  const serialNumberHex = bytesToHex(serialNode?.content ?? new Uint8Array());
  idx++; // signature algorithm on TBS
  const issuer = parseName(tbs.children[idx++]);
  const validity = tbs.children[idx++];
  const notBefore = parseTime(validity?.children?.[0]);
  const notAfter = parseTime(validity?.children?.[1]);
  const subject = parseName(tbs.children[idx++]);
  const spki = tbs.children[idx++];
  const pkAlgNode = spki?.children?.[0]?.children?.[0] ?? spki?.children?.[0];
  const pkAlgOid = pkAlgNode ? nodeOID(pkAlgNode) : null;
  let publicKeyAlgorithm = 'Unknown';
  if (pkAlgOid === OID_RSA) publicKeyAlgorithm = 'RSA';
  else if (pkAlgOid === OID_EC) publicKeyAlgorithm = 'EC';
  else if (pkAlgOid) publicKeyAlgorithm = pkAlgOid;

  const fingerprintSha256 = bytesToHex(await hashBytes(der, 'sha256'));

  return {
    id: nextId(),
    format,
    der,
    subject,
    issuer,
    serialNumberHex,
    notBefore,
    notAfter,
    publicKeyAlgorithm,
    fingerprintSha256,
    pem: derToPem(der, 'CERTIFICATE'),
  };
}

/** Import PKCS#8 private key DER into WebCrypto. */
export async function importPrivateKey(
  der: Uint8Array,
): Promise<ImportedKeyMaterial> {
  const tryImport = async (
    algorithm: RsaHashedImportParams | EcKeyImportParams,
  ): Promise<CryptoKey | null> => {
    try {
      const copy = new Uint8Array(der);
      return await crypto.subtle.importKey(
        'pkcs8',
        copy.buffer as ArrayBuffer,
        algorithm,
        false,
        ['sign'],
      );
    } catch {
      return null;
    }
  };

  let key = await tryImport({ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' });
  if (key) return { privateKey: key, algorithm: 'RSA', extractable: false };

  key = await tryImport({ name: 'ECDSA', namedCurve: 'P-256' });
  if (key) return { privateKey: key, algorithm: 'ECDSA', extractable: false };

  key = await tryImport({ name: 'ECDSA', namedCurve: 'P-384' });
  if (key) return { privateKey: key, algorithm: 'ECDSA', extractable: false };

  throw new Error(
    'Could not import private key. Use PKCS#8 PEM (BEGIN PRIVATE KEY) for RSA or EC.',
  );
}

/**
 * Import PEM text that may contain certificates and/or a private key.
 */
export async function importFromPem(
  pemText: string,
  label = 'PEM import',
): Promise<ImportedCertificateBundle> {
  const blocks = decodePem(pemText);
  if (blocks.length === 0) throw new Error('No PEM blocks found');

  const certificates: CertificateInfo[] = [];
  let key: ImportedKeyMaterial | null = null;

  for (const block of blocks) {
    const upper = block.label.toUpperCase();
    if (upper.includes('CERTIFICATE')) {
      certificates.push(await parseCertificateDer(block.der, 'pem'));
    } else if (
      upper === 'PRIVATE KEY' ||
      upper === 'RSA PRIVATE KEY' ||
      upper === 'EC PRIVATE KEY'
    ) {
      if (upper === 'RSA PRIVATE KEY' || upper === 'EC PRIVATE KEY') {
        throw new Error(
          `${block.label} is not directly supported. Convert to PKCS#8 (BEGIN PRIVATE KEY).`,
        );
      }
      key = await importPrivateKey(block.der);
    }
  }

  const leaf = certificates[0] ?? null;
  return {
    certificates,
    leaf,
    key,
    chain: certificates,
    source: 'pem',
    label: leaf?.subject.commonName ?? label,
  };
}

/**
 * Import a DER certificate file.
 */
export async function importCertificateDer(
  der: Uint8Array,
  label = 'DER certificate',
): Promise<ImportedCertificateBundle> {
  const cert = await parseCertificateDer(der, 'der');
  return {
    certificates: [cert],
    leaf: cert,
    key: null,
    chain: [cert],
    source: 'der',
    label: cert.subject.commonName ?? label,
  };
}

/** Format certificate for UI display. */
export function formatCertificateSummary(cert: CertificateInfo): string {
  const cn = (cert.subject.commonName ?? cert.subject.raw) || 'Unknown';
  const until = cert.notAfter
    ? cert.notAfter.toISOString().slice(0, 10)
    : '?';
  return `${cn} · ${cert.publicKeyAlgorithm} · expires ${until}`;
}

export function isCertificateExpired(
  cert: CertificateInfo,
  now = new Date(),
): boolean {
  if (cert.notAfter && cert.notAfter.getTime() < now.getTime()) return true;
  if (cert.notBefore && cert.notBefore.getTime() > now.getTime()) return true;
  return false;
}

export { parseDER, decodeOID };
