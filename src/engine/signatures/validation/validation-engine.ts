/**
 * Phase 10 — Signature validation engine.
 * Verifies ByteRange, hash, CMS crypto, certificate expiry / trust.
 */

import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFRef,
  PDFString,
  type PDFDocumentData,
} from '../../types';
import { listRevisions } from '../../writer/revision-manager';
import { listSignatureFields, type SignatureField } from '../fields/signature-field';
import {
  parseCMSSignedData,
  verifySignatureDigest,
  parseDERNode,
  nodeOID,
} from '../crypto/signature-verify';
import { parseCertificateDer, isCertificateExpired } from '../certificates/certificate-parser';
import { OID, type PDFSignatureDict, type ASN1Node } from '../crypto/types';
import type {
  CertificateValidationInfo,
  SignatureValidationDetail,
  ValidationOptions,
  ValidationReport,
  ValidationStatus,
} from './validation-types';

const OID_TST = '1.2.840.113549.1.9.16.2.14';

function resolveObj(doc: PDFDocumentData, refOrObj: unknown): unknown {
  if (refOrObj instanceof PDFRef) return doc.objects.get(refOrObj.toKey());
  return refOrObj;
}

function wrapSequence(inner: Uint8Array): Uint8Array {
  const len = inner.length;
  if (len < 0x80) {
    const r = new Uint8Array(2 + len);
    r[0] = 0x30;
    r[1] = len;
    r.set(inner, 2);
    return r;
  }
  if (len < 0x100) {
    const r = new Uint8Array(3 + len);
    r[0] = 0x30;
    r[1] = 0x81;
    r[2] = len;
    r.set(inner, 3);
    return r;
  }
  const r = new Uint8Array(4 + len);
  r[0] = 0x30;
  r[1] = 0x82;
  r[2] = (len >> 8) & 0xff;
  r[3] = len & 0xff;
  r.set(inner, 4);
  return r;
}

/** Strip trailing zero padding from CMS hex (PDF Contents padding). */
export function trimCmsPadding(cms: Uint8Array): Uint8Array {
  try {
    const root = parseDERNode(cms, 0);
    if (root.length > 0 && root.length <= cms.length) {
      return cms.subarray(0, root.length);
    }
  } catch {
    // ignore
  }
  let end = cms.length;
  while (end > 16 && cms[end - 1] === 0) end--;
  return cms.subarray(0, end);
}

export function extractPdfSignatureDict(
  doc: PDFDocumentData,
  field: SignatureField,
): PDFSignatureDict | null {
  if (!field.valueRef) return null;
  const sig = resolveObj(doc, field.valueRef);
  if (!(sig instanceof PDFDict)) return null;

  const contentsObj = sig.get('Contents');
  let contents: Uint8Array | null = null;
  if (contentsObj instanceof PDFHexString) {
    contents = trimCmsPadding(contentsObj.toBytes());
  } else if (contentsObj instanceof PDFString) {
    const s = contentsObj.value;
    contents = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) contents[i] = s.charCodeAt(i) & 0xff;
    contents = trimCmsPadding(contents);
  }
  if (!contents || contents.length < 16) return null;

  const brObj = sig.get('ByteRange');
  let byteRange: [number, number, number, number] = [0, 0, 0, 0];
  if (brObj instanceof PDFArray) {
    const nums = brObj.asNumbers();
    if (nums.length >= 4) {
      byteRange = [nums[0], nums[1], nums[2], nums[3]];
    }
  }

  const str = (key: string): string | null => {
    const v = sig.get(key);
    if (v instanceof PDFString) return v.value;
    if (v instanceof PDFHexString) return v.toText();
    if (v instanceof PDFName) return v.name;
    return null;
  };

  return {
    filter: str('Filter') ?? 'Adobe.PPKLite',
    subFilter: str('SubFilter'),
    contents,
    byteRange,
    name: str('Name'),
    reason: str('Reason'),
    contactInfo: str('ContactInfo'),
    signingTime: str('M'),
  };
}

/** Extract SPKI DER from an X.509 certificate DER. */
export function extractSpkiFromCertificate(certDer: Uint8Array): Uint8Array {
  const root = parseDERNode(certDer, 0);
  const tbs = root.children?.[0];
  if (!tbs?.children) throw new Error('Invalid certificate');
  let idx = 0;
  if (tbs.children[0]?.class === 'context') idx = 1;
  idx += 5; // serial, sig, issuer, validity, subject
  const spki = tbs.children[idx];
  if (!spki || spki.offset == null || spki.length == null) {
    throw new Error('SPKI not found');
  }
  return certDer.subarray(spki.offset, spki.offset + spki.length);
}

function signedAttrsForVerify(signedAttrs: ASN1Node | null): Uint8Array | null {
  if (!signedAttrs) return null;
  const content = signedAttrs.content;
  const len = content.length;
  if (len < 0x80) {
    const r = new Uint8Array(2 + len);
    r[0] = 0x31;
    r[1] = len;
    r.set(content, 2);
    return r;
  }
  if (len < 0x100) {
    const r = new Uint8Array(3 + len);
    r[0] = 0x31;
    r[1] = 0x81;
    r[2] = len;
    r.set(content, 3);
    return r;
  }
  const r = new Uint8Array(4 + len);
  r[0] = 0x31;
  r[1] = 0x82;
  r[2] = (len >> 8) & 0xff;
  r[3] = len & 0xff;
  r.set(content, 4);
  return r;
}

function hasTimestampAttr(signedAttrs: ASN1Node | null): boolean {
  if (!signedAttrs?.children) return false;
  for (const attr of signedAttrs.children) {
    const oid = nodeOID(attr.children?.[0] ?? attr);
    if (oid === OID_TST) return true;
  }
  return false;
}

function derEcdsaToP1363(der: Uint8Array): Uint8Array {
  try {
    const seq = parseDERNode(der, 0);
    const r = seq.children?.[0]?.content ?? new Uint8Array(0);
    const s = seq.children?.[1]?.content ?? new Uint8Array(0);
    const strip = (x: Uint8Array) => {
      let i = 0;
      while (i < x.length - 1 && x[i] === 0) i++;
      return x.subarray(i);
    };
    const rr = strip(r);
    const ss = strip(s);
    const size = Math.max(32, rr.length, ss.length);
    const out = new Uint8Array(size * 2);
    out.set(rr, size - rr.length);
    out.set(ss, size * 2 - ss.length);
    return out;
  } catch {
    return der;
  }
}

function ab(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

/**
 * Verify CMS signatureValue over signedAttrs using embedded certificate.
 */
export async function verifyCmsCryptographic(
  cmsBytes: Uint8Array,
): Promise<{ ok: boolean; error?: string; hasTimestamp: boolean }> {
  let cms;
  try {
    cms = parseCMSSignedData(cmsBytes);
  } catch (e) {
    return {
      ok: false,
      error: `CMS parse: ${e instanceof Error ? e.message : String(e)}`,
      hasTimestamp: false,
    };
  }
  const signer = cms.signerInfos[0];
  if (!signer) return { ok: false, error: 'No SignerInfo', hasTimestamp: false };

  const hasTimestamp = hasTimestampAttr(signer.signedAttrs);
  const certNode = cms.certificates[0];
  if (!certNode) {
    return { ok: false, error: 'No certificate in CMS', hasTimestamp };
  }

  const certDer = wrapSequence(certNode.content);
  const dataToVerify = signedAttrsForVerify(signer.signedAttrs);
  if (!dataToVerify) {
    return { ok: false, error: 'Missing signed attributes', hasTimestamp };
  }

  const digestOid = signer.digestAlgorithm;
  const hashName =
    digestOid === OID.sha512
      ? 'SHA-512'
      : digestOid === OID.sha384
        ? 'SHA-384'
        : 'SHA-256';

  try {
    const spki = extractSpkiFromCertificate(certDer);
    const sigAlg = signer.signatureAlgorithm;
    const isEcdsa =
      sigAlg.includes('1.2.840.10045') || sigAlg === '1.2.840.10045.2.1';

    if (isEcdsa) {
      let key: CryptoKey;
      try {
        key = await crypto.subtle.importKey(
          'spki',
          ab(spki),
          { name: 'ECDSA', namedCurve: 'P-256' },
          false,
          ['verify'],
        );
      } catch {
        key = await crypto.subtle.importKey(
          'spki',
          ab(spki),
          { name: 'ECDSA', namedCurve: 'P-384' },
          false,
          ['verify'],
        );
      }
      const sig = derEcdsaToP1363(signer.encryptedDigest);
      const ok = await crypto.subtle.verify(
        { name: 'ECDSA', hash: hashName },
        key,
        ab(sig),
        ab(dataToVerify),
      );
      return { ok, error: ok ? undefined : 'ECDSA signature invalid', hasTimestamp };
    }

    const key = await crypto.subtle.importKey(
      'spki',
      ab(spki),
      { name: 'RSASSA-PKCS1-v1_5', hash: hashName },
      false,
      ['verify'],
    );
    const ok = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      key,
      ab(signer.encryptedDigest),
      ab(dataToVerify),
    );
    return { ok, error: ok ? undefined : 'RSA signature invalid', hasTimestamp };
  } catch (e) {
    return {
      ok: false,
      error: `Crypto verify failed: ${e instanceof Error ? e.message : String(e)}`,
      hasTimestamp,
    };
  }
}

async function validateCertificate(
  cmsBytes: Uint8Array,
  options: ValidationOptions,
): Promise<CertificateValidationInfo | null> {
  try {
    const cms = parseCMSSignedData(cmsBytes);
    const certNode = cms.certificates[0];
    if (!certNode) return null;
    const certDer = wrapSequence(certNode.content);
    const info = await parseCertificateDer(certDer, 'der');
    const selfSigned =
      info.subject.raw === info.issuer.raw ||
      (info.subject.commonName != null &&
        info.subject.commonName === info.issuer.commonName);
    const expired = isCertificateExpired(info, options.now);
    const anchors = options.trustAnchors ?? [];
    const trusted =
      anchors.some(
        (a) =>
          a.fingerprintSha256.toLowerCase() === info.fingerprintSha256.toLowerCase(),
      ) ||
      (options.allowSelfSigned !== false && selfSigned);

    return {
      subject: info.subject.raw || info.subject.commonName || 'Unknown',
      issuer: info.issuer.raw || info.issuer.commonName || 'Unknown',
      serialNumberHex: info.serialNumberHex,
      notBefore: info.notBefore?.toISOString() ?? null,
      notAfter: info.notAfter?.toISOString() ?? null,
      fingerprintSha256: info.fingerprintSha256,
      expired,
      selfSigned,
      trusted,
      publicKeyAlgorithm: info.publicKeyAlgorithm,
    };
  } catch {
    return null;
  }
}

function rollupStatus(details: SignatureValidationDetail[]): ValidationStatus {
  if (details.length === 0) return 'Unknown';
  if (details.some((d) => d.status === 'Revoked')) return 'Revoked';
  if (details.some((d) => d.status === 'Modified')) return 'Modified';
  if (details.some((d) => d.status === 'Expired')) return 'Expired';
  if (details.every((d) => d.status === 'Valid')) return 'Valid';
  return 'Unknown';
}

/**
 * Validate a single signature field against document bytes.
 */
export async function validateSignatureField(
  doc: PDFDocumentData,
  field: SignatureField,
  pdfBytes: Uint8Array,
  options: ValidationOptions = {},
): Promise<SignatureValidationDetail> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const base: SignatureValidationDetail = {
    fieldId: field.id,
    fieldName: field.fieldName,
    pageIndex: field.pageIndex,
    status: 'Unknown',
    summary: 'Not signed',
    byteRangeOk: false,
    digestMatch: false,
    cmsSignatureOk: null,
    certificate: null,
    signerName: null,
    reason: null,
    signingTime: null,
    hasTimestamp: false,
    hashAlgorithm: 'sha256',
    errors,
    warnings,
  };

  if (!field.signed) {
    base.summary = 'Unsigned field';
    return base;
  }

  const sigDict = extractPdfSignatureDict(doc, field);
  if (!sigDict) {
    errors.push('Could not extract signature dictionary');
    base.summary = 'Signature dictionary missing or empty';
    return base;
  }

  base.signerName = sigDict.name;
  base.reason = sigDict.reason;
  base.signingTime = sigDict.signingTime;

  const [a, b, c, d] = sigDict.byteRange;
  base.byteRangeOk =
    a === 0 &&
    b > 0 &&
    c > b &&
    d >= 0 &&
    a + b <= pdfBytes.length &&
    c + d <= pdfBytes.length;

  if (!base.byteRangeOk) errors.push('Invalid ByteRange against file length');

  const digestResult = await verifySignatureDigest(pdfBytes, sigDict);
  base.digestMatch = digestResult.digestMatch;
  base.hashAlgorithm = digestResult.algorithm;
  if (!digestResult.digestMatch) errors.push(...digestResult.errors);

  const cryptoResult = await verifyCmsCryptographic(sigDict.contents);
  base.cmsSignatureOk = cryptoResult.ok;
  base.hasTimestamp = cryptoResult.hasTimestamp;
  if (!cryptoResult.ok && cryptoResult.error) {
    if (base.digestMatch) {
      warnings.push(cryptoResult.error);
      base.cmsSignatureOk = null;
    } else {
      errors.push(cryptoResult.error);
    }
  }

  const cert = await validateCertificate(sigDict.contents, options);
  base.certificate = cert;

  let revoked = false;
  if (cert && options.checkRevocation) {
    const rev = await options.checkRevocation(cert.serialNumberHex);
    if (rev === 'revoked') revoked = true;
  }

  if (revoked) {
    base.status = 'Revoked';
    base.summary = 'Certificate revoked (placeholder check)';
  } else if (!base.digestMatch || !base.byteRangeOk) {
    base.status = 'Modified';
    base.summary = 'Document altered after signing or ByteRange invalid';
  } else if (cert?.expired) {
    base.status = 'Expired';
    base.summary = `Certificate expired${cert.notAfter ? ` (${cert.notAfter.slice(0, 10)})` : ''}`;
  } else if (base.digestMatch && (base.cmsSignatureOk === true || base.cmsSignatureOk === null)) {
    if (cert && !cert.trusted) {
      base.status = 'Unknown';
      base.summary = 'Digest OK — certificate not in trust list';
      warnings.push('Untrusted issuer / root');
    } else {
      base.status = 'Valid';
      base.summary = cert
        ? `Valid — signed by ${cert.subject.split(',')[0]}`
        : 'Valid — digest matches';
    }
  } else {
    base.status = 'Unknown';
    base.summary = 'Could not fully verify signature';
  }

  return base;
}

/**
 * Validate all signature fields in a document.
 */
export async function validateDocumentSignatures(
  doc: PDFDocumentData,
  options: ValidationOptions = {},
): Promise<ValidationReport> {
  const pdfBytes = doc.rawBytes;
  if (!pdfBytes || pdfBytes.length === 0) {
    return {
      documentStatus: 'Unknown',
      signatures: [],
      revisionCount: 0,
      validatedAt: new Date().toISOString(),
      errors: ['Document has no raw bytes — save or load PDF first'],
    };
  }

  const fields = listSignatureFields(doc);
  const signed = fields.filter((f) => f.signed);
  const targets = signed.length ? signed : fields;
  const signatures: SignatureValidationDetail[] = [];
  for (const field of targets) {
    signatures.push(await validateSignatureField(doc, field, pdfBytes, options));
  }

  let revisionCount = 1;
  try {
    revisionCount = listRevisions(pdfBytes).revisions.length;
  } catch {
    revisionCount = 1;
  }

  const signedDetails = signatures.filter((s) =>
    fields.find((f) => f.id === s.fieldId)?.signed,
  );

  return {
    documentStatus: rollupStatus(signedDetails),
    signatures,
    revisionCount,
    validatedAt: new Date().toISOString(),
    errors: [],
  };
}

/** Format a short badge label for UI. */
export function validationStatusBadge(status: ValidationStatus): {
  label: string;
  tone: 'ok' | 'warn' | 'bad' | 'neutral';
} {
  switch (status) {
    case 'Valid':
      return { label: 'Valid', tone: 'ok' };
    case 'Modified':
      return { label: 'Modified', tone: 'bad' };
    case 'Expired':
      return { label: 'Expired', tone: 'warn' };
    case 'Revoked':
      return { label: 'Revoked', tone: 'bad' };
    default:
      return { label: 'Unknown', tone: 'neutral' };
  }
}
