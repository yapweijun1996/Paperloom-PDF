/**
 * Phase 10 — Validation types & Acrobat-style status vocabulary.
 */

export type ValidationStatus =
  | 'Valid'
  | 'Modified'
  | 'Unknown'
  | 'Expired'
  | 'Revoked';

export interface TrustAnchor {
  /** SHA-256 fingerprint of trusted root/intermediate DER. */
  fingerprintSha256: string;
  label?: string;
}

export interface ValidationOptions {
  /** Extra trusted root/intermediate fingerprints (hex lowercase). */
  trustAnchors?: TrustAnchor[];
  /** Treat self-signed leaf as trusted when no anchors match. Default true. */
  allowSelfSigned?: boolean;
  /** Wall clock for expiry checks. */
  now?: Date;
  /** Revocation check stub — always returns not-revoked unless overridden. */
  checkRevocation?: (serialHex: string) => Promise<'good' | 'revoked' | 'unknown'>;
}

export interface CertificateValidationInfo {
  subject: string;
  issuer: string;
  serialNumberHex: string;
  notBefore: string | null;
  notAfter: string | null;
  fingerprintSha256: string;
  expired: boolean;
  selfSigned: boolean;
  trusted: boolean;
  publicKeyAlgorithm: string;
}

export interface SignatureValidationDetail {
  fieldId: string;
  fieldName: string;
  pageIndex: number;
  status: ValidationStatus;
  /** Human-readable summary line. */
  summary: string;
  byteRangeOk: boolean;
  digestMatch: boolean;
  cmsSignatureOk: boolean | null;
  certificate: CertificateValidationInfo | null;
  signerName: string | null;
  reason: string | null;
  signingTime: string | null;
  hasTimestamp: boolean;
  hashAlgorithm: string;
  errors: string[];
  warnings: string[];
}

export interface ValidationReport {
  documentStatus: ValidationStatus;
  signatures: SignatureValidationDetail[];
  revisionCount: number;
  validatedAt: string;
  errors: string[];
}
