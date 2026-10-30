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
  /** SHA-256 fingerprint of an explicitly trusted signer certificate. */
  fingerprintSha256: string;
  label?: string;
}

export interface ValidationOptions {
  /** Trusted signer certificate fingerprints (hex lowercase); chain validation is not supported. */
  trustAnchors?: TrustAnchor[];
  /** @deprecated Self-signed certificates require an explicit fingerprint in trustAnchors. */
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
  /** Bounds and ordering only; status also checks the excluded gap and current-file coverage. */
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
