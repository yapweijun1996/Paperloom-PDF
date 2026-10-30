import { hashAlgorithmOID, hashBytes, type HashAlgorithm } from '../crypto/hash-engine';
import { parseCMSSignedData, parseDERNode, nodeOID } from '../crypto/signature-verify';
import { OID, OID_TO_DIGEST, type ASN1Node } from '../crypto/types';
import { findCmsSignerCertificate, verifyCmsCryptographic } from '../validation/validation-engine';
import { parseCertificateDer } from '../certificates/certificate-parser';

const TST_INFO_OID = '1.2.840.113549.1.9.16.1.4';

function isUniversal(node: ASN1Node | undefined, tag: number): node is ASN1Node {
  return node?.class === 'universal' && node.tag === tag;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function positiveInteger(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length === 0 || (bytes[0] & 0x80) !== 0) return null;
  let offset = 0;
  while (offset + 1 < bytes.length && bytes[offset] === 0) offset++;
  return bytes.subarray(offset);
}

function parseGeneralizedTime(value: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?Z$/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, se, fraction] = match;
  const year = Number(y), month = Number(mo), day = Number(d);
  const hour = Number(h), minute = Number(mi), second = Number(se);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, Number((fraction ?? '').padEnd(3, '0').slice(0, 3))));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

function hasTimestampingEku(certDer: Uint8Array): boolean {
  const tbs = parseDERNode(certDer).children?.[0];
  const extensions = tbs?.children?.filter(node => node.class === 'context' && node.tag === 3) ?? [];
  if (extensions.length !== 1 || extensions[0].children?.length !== 1) return false;
  const entries = extensions[0].children[0].children ?? [];
  const matches = entries.filter(entry => entry.children?.[0] && nodeOID(entry.children[0]) === '2.5.29.37');
  if (matches.length !== 1) return false;
  const fields = matches[0].children ?? [];
  if (fields.length !== 3 || !isUniversal(fields[1], 1) || fields[1].content.length !== 1 || fields[1].content[0] !== 0xff || !isUniversal(fields[2], 4)) return false;
  const usage = parseDERNode(fields[2].content);
  return isUniversal(usage, 16) && usage.length === fields[2].content.length &&
    usage.children?.length === 1 && nodeOID(usage.children[0]) === '1.3.6.1.5.5.7.3.8';
}

/** Validate cryptographic binding; certificate chain trust is not evaluated. */
export async function validateTimestampToken(
  token: Uint8Array,
  imprint: Uint8Array,
  hashAlgorithm: HashAlgorithm,
  nonce: Uint8Array,
): Promise<{ genTime: string; serialNumberHex: string }> {
  const root = parseDERNode(token);
  if (!isUniversal(root, 16) || root.length !== token.length) throw new Error('Invalid timestamp ContentInfo');
  const cms = parseCMSSignedData(token);
  if (cms.encapContentInfo.contentType !== TST_INFO_OID) throw new Error('Unexpected timestamp content type');
  const wrapper = cms.encapContentInfo.content;
  const octets = wrapper?.children;
  if (wrapper?.class !== 'context' || wrapper.tag !== 0 || octets?.length !== 1 || !isUniversal(octets[0], 4)) {
    throw new Error('Missing encapsulated TSTInfo');
  }
  const content = octets[0].content;
  const info = parseDERNode(content);
  if (!isUniversal(info, 16) || info.length !== content.length || !info.children || info.children.length < 5) {
    throw new Error('Invalid TSTInfo');
  }
  const [version, policy, messageImprint, serial, time] = info.children;
  const fields = messageImprint?.children;
  if (!isUniversal(version, 2) || version.content.length !== 1 || version.content[0] !== 1 ||
      !isUniversal(policy, 6) || !isUniversal(messageImprint, 16) || fields?.length !== 2 ||
      !isUniversal(fields[0], 16) || !isUniversal(fields[1], 4) ||
      !isUniversal(serial, 2) || !positiveInteger(serial.content) || !isUniversal(time, 24)) {
    throw new Error('Invalid TSTInfo fields');
  }
  const algorithmNode = fields[0].children?.[0];
  if (!algorithmNode || nodeOID(algorithmNode) !== hashAlgorithmOID(hashAlgorithm).join('.') || !equal(fields[1].content, imprint)) {
    throw new Error('Timestamp message imprint does not match the request');
  }
  const nonces = info.children.slice(5).filter(node => isUniversal(node, 2));
  const expectedNonce = positiveInteger(new Uint8Array([0, ...nonce]));
  const returnedNonce = nonces.length === 1 ? positiveInteger(nonces[0].content) : null;
  if (!expectedNonce || !returnedNonce || !equal(expectedNonce, returnedNonce)) {
    throw new Error('Timestamp nonce does not match the request');
  }
  const genTime = new TextDecoder().decode(time.content);
  const generationDate = parseGeneralizedTime(genTime);
  if (!generationDate) throw new Error('Invalid timestamp generation time');

  if (cms.signerInfos.length !== 1) throw new Error('Timestamp must have exactly one signer');
  const signer = cms.signerInfos[0];
  const digestAlgorithm = OID_TO_DIGEST[signer.digestAlgorithm];
  if (!digestAlgorithm || !cms.digestAlgorithms.includes(signer.digestAlgorithm)) throw new Error('Unsupported timestamp CMS digest');
  const attributes = signer.signedAttrs?.children ?? [];
  const valuesFor = (oid: string): ASN1Node[] => attributes.filter(attr =>
    isUniversal(attr, 16) && attr.children?.length === 2 && nodeOID(attr.children[0]) === oid)
    .flatMap(attr => isUniversal(attr.children?.[1], 17) ? attr.children![1].children ?? [] : []);
  const contentTypeAttributes = attributes.filter(attr => attr.children?.[0] && nodeOID(attr.children[0]) === OID.contentType);
  const digestAttributes = attributes.filter(attr => attr.children?.[0] && nodeOID(attr.children[0]) === OID.messageDigest);
  const typeValues = valuesFor(OID.contentType);
  const digestValues = valuesFor(OID.messageDigest);
  if (contentTypeAttributes.length !== 1 || typeValues.length !== 1 || nodeOID(typeValues[0]) !== TST_INFO_OID ||
      digestAttributes.length !== 1 || digestValues.length !== 1 || !isUniversal(digestValues[0], 4) ||
      !equal(digestValues[0].content, await hashBytes(content, digestAlgorithm))) {
    throw new Error('Timestamp CMS signed attributes do not match TSTInfo');
  }
  const verified = await verifyCmsCryptographic(token);
  if (!verified.ok) throw new Error(`Timestamp signature verification failed: ${verified.error ?? 'invalid signature'}`);
  const certificateDer = findCmsSignerCertificate(cms);
  if (!certificateDer || !hasTimestampingEku(certificateDer)) throw new Error('Timestamp signer certificate lacks the required critical timestamping EKU');
  const certificate = await parseCertificateDer(certificateDer, 'der');
  if (!certificate.notBefore || !certificate.notAfter || generationDate < certificate.notBefore || generationDate > certificate.notAfter) {
    throw new Error('Timestamp signer certificate was not valid at generation time');
  }
  return { genTime, serialNumberHex: Array.from(serial.content, b => b.toString(16).padStart(2, '0')).join('') };
}
