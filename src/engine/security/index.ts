/**
 * Bloom PDF Security Engine — public API.
 *
 * Phases 1–10 implemented. Phases 11+ remain as stubs.
 */

export type {
  EncryptionAlgorithm,
  EncryptionRevision,
  EncryptionVersion,
  CryptFilterMethod,
  CryptFilter,
  EncryptDictionary,
  FileIdPair,
  EncryptionContext,
  PdfPermissions,
  RestrictedOperation,
  PasswordRole,
  PasswordAuthResult,
  PasswordOptions,
  EncryptOptions,
  DecryptOptions,
  SecurityOpenResult,
  SecurityInspectionReport,
  IEncryptionEngine,
  IPasswordEngine,
  IPermissionEngine,
  ISecurityEngine,
  IPublicKeyEncryptionEngine,
  IMetadataEngine,
  IEmbeddedFileSecurityEngine,
  IJavaScriptSecurityEngine,
  IRedactionEngine,
  ISanitizationEngine,
  IIntegrityScanner,
  ISecureOptimizer,
  ISecurityPolicyEngine,
  ISecurityInspector,
  RecipientCert,
  RecipientInfo,
  PublicKeyEncryptOptions,
  MetadataStripOptions,
  MetadataValidationResult,
  EmbeddedAttachment,
  AttachmentValidationResult,
  AttachmentScanResult,
  AttachmentScanner,
  ActionKind,
  DetectedAction,
  ActionSecurityReport,
  ActionRemovalResult,
  SecureRedactionOptions,
  SecureRedactionResult,
  RedactionVerification,
} from './types';

export { DEFAULT_PERMISSIONS } from './types';

export { SecurityEngine, securityEngine } from './security-engine';
export { EncryptionEngine, encryptionEngine } from './encryption/encryption-engine';
export { PasswordEngine, passwordEngine } from './password/password-engine';
export { PermissionEngine, permissionEngine } from './permissions/permission-engine';

export {
  parseEncryptDict,
  parseFileId,
  getEncryptDictFromTrailer,
  isEncryptedTrailer,
  ensureFileId,
  bytesToPdfHex,
} from './encryption/encrypt-dict';

export {
  detectAlgorithm,
  padPassword,
  utf8Password,
  computeFileKeyR2R4,
  computeOValue,
  computeUValue,
  authenticateUserR2R4,
  authenticateOwnerR2R4,
  hashRevision6,
  authenticateUserR5R6,
  authenticateOwnerR5R6,
  createEncryptionR2R4,
  createEncryptionR6,
  PASSWORD_PADDING,
} from './encryption/standard-handler';

export {
  computeObjectKey,
  decryptBytes,
  encryptBytes,
  shouldEncryptStream,
  shouldEncryptString,
} from './encryption/object-cipher';

export { decryptDocumentObjects } from './encryption/decrypt-pipeline';
export { encryptDocumentObjects, serializeEncryptDict } from './encryption/encrypt-pipeline';

export {
  parsePermissions,
  serializePermissions,
  mergePermissions,
  allowsOperation,
  assertAllowed,
} from './permissions/permission-bits';

export { md5 } from './crypto/md5';
export { rc4 } from './crypto/rc4';
export {
  aesEncryptCbc,
  aesDecryptCbc,
  sha256,
} from './crypto/aes';
export {
  concatBytes,
  bytesEqual,
  stringToPdfBytes,
  utf8Encode,
  int32LE,
  randomBytes,
  bytesToHex,
  hexToBytes,
} from './crypto/bytes';

export {
  PublicKeyEncryptionEngine,
  publicKeyEncryptionEngine,
} from './public-key/public-key-engine';
export { RecipientManager } from './public-key/recipient-manager';
export { buildRecipientCms, unwrapFileKeyFromCms } from './public-key/cms-enveloped';
export { MetadataEngine, metadataEngine } from './metadata/metadata-engine';
export {
  EmbeddedFileSecurityEngine,
  embeddedFileSecurityEngine,
} from './embedded-files/embedded-file-engine';
export {
  JavaScriptSecurityEngine,
  javaScriptSecurityEngine,
} from './javascript/javascript-engine';
export { RedactionEngine, redactionEngine } from './redaction/redaction-engine';
export { SanitizationEngine, sanitizationEngine } from './sanitization/sanitization-engine';
export { IntegrityScanner, integrityScanner } from './integrity/integrity-scanner';
export type { IntegrityReport, IntegrityIssue } from './integrity/integrity-scanner';
export { SecurityInspector, securityInspector } from './inspector/security-inspector';
export type { FullSecurityReport } from './inspector/security-inspector';
export { SecureOptimizer, secureOptimizer } from './optimizer/secure-optimizer';
export type { OptimizeReport } from './optimizer/secure-optimizer';
export { SecurityPolicyEngine, securityPolicyEngine } from './policy/policy-engine';
export type { SecurityPolicy } from './policy/policy-engine';
export { EnterpriseSecurityLayer, enterpriseSecurity } from './enterprise/enterprise-layer';
export type {
  AuditEntry,
  BatchItem,
  BatchResult,
  PermissionTemplate,
  KeyProvider,
} from './enterprise/enterprise-layer';
