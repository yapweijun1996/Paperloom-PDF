/**
 * Digital signature types — ASN.1 DER nodes, PKCS#7/CMS structures.
 *
 * RFC 5652 (CMS), ISO 32000-2 §12.8 (Digital signatures).
 */

/** Universal ASN.1 tag classes. */
export type ASN1Class = 'universal' | 'application' | 'context' | 'private';

/** Parsed ASN.1 DER node. */
export interface ASN1Node {
  class: ASN1Class;
  constructed: boolean;
  tag: number;
  tagName?: string;
  /** Raw content bytes (primitive) or encoded child bytes (constructed). */
  content: Uint8Array;
  children?: ASN1Node[];
  /** Byte offset in source DER for diagnostics. */
  offset: number;
  length: number;
}

/** PKCS#7 ContentInfo (OID 1.2.840.113549.1.7.x). */
export interface PKCS7ContentInfo {
  contentType: string;
  content: ASN1Node | null;
}

/** SignedData subset used by PDF /ByteRange signatures. */
export interface CMSSignedData {
  version: number;
  digestAlgorithms: string[];
  encapContentInfo: PKCS7ContentInfo;
  certificates: ASN1Node[];
  signerInfos: CMSSignerInfo[];
}

export interface CMSSignerInfo {
  version: number;
  sid: ASN1Node;
  digestAlgorithm: string;
  signedAttrs: ASN1Node | null;
  signatureAlgorithm: string;
  encryptedDigest: Uint8Array;
}

/** Parsed PDF signature dictionary subset. */
export interface PDFSignatureDict {
  filter: string;
  subFilter: string | null;
  contents: Uint8Array;
  byteRange: [number, number, number, number];
  name: string | null;
  reason: string | null;
  contactInfo: string | null;
  signingTime: string | null;
}

export interface SignatureVerificationResult {
  valid: boolean;
  digestMatch: boolean;
  /** Computed message digest (hex). */
  computedDigest: string;
  /** Digest from signed attributes if present. */
  embeddedDigest: string | null;
  algorithm: string;
  errors: string[];
}

export interface VerifyDigestOptions {
  /** Hash algorithm matching SignedData (sha256, sha384, sha512). */
  algorithm: 'sha256' | 'sha384' | 'sha512';
}

export const DEFAULT_VERIFY_OPTIONS: VerifyDigestOptions = {
  algorithm: 'sha256',
};

/** Well-known OIDs encountered in PDF signatures. */
export const OID = {
  signedData: '1.2.840.113549.1.7.2',
  data: '1.2.840.113549.1.7.1',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
  rsaEncryption: '1.2.840.113549.1.1.1',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  contentType: '1.2.840.113549.1.9.3',
} as const;

/** Map dotted OID to friendly digest name. */
export const OID_TO_DIGEST: Record<string, VerifyDigestOptions['algorithm']> = {
  [OID.sha256]: 'sha256',
  [OID.sha384]: 'sha384',
  [OID.sha512]: 'sha512',
};
