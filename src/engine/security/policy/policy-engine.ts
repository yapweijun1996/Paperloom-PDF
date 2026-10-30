/**
 * Security Policy Engine — Phase 15.
 */

import type { PDFDocumentData } from '../../types';
import type {
  EncryptOptions,
  ISecurityPolicyEngine,
  PdfPermissions,
} from '../types';
import { DEFAULT_PERMISSIONS } from '../types';
import { randomBytes } from '../crypto/bytes';
import { runDocumentTransaction } from '../../session/document-transaction';
import { encryptDocumentObjects } from '../encryption/encrypt-pipeline';
import { isEncryptedTrailer } from '../encryption/encrypt-dict';
import { validateEncryptionPasswords } from '../encryption/password-validation';
import { sanitizationEngine } from '../sanitization/sanitization-engine';
import { javaScriptSecurityEngine } from '../javascript/javascript-engine';
import { embeddedFileSecurityEngine } from '../embedded-files/embedded-file-engine';
import { metadataEngine } from '../metadata/metadata-engine';

export interface SecurityPolicy {
  name: string;
  description: string;
  encryption?: EncryptOptions | null;
  requireEncryption?: boolean;
  /** Require a password to open the PDF, in addition to its owner password. */
  requireUserPassword?: boolean;
  stripMetadata?: boolean;
  removeJavaScript?: boolean;
  removeAttachments?: boolean;
  permissions?: Partial<PdfPermissions>;
}

const BUILTIN: SecurityPolicy[] = [
  {
    name: 'Read Only',
    description: 'Allow viewing and printing; block modify/copy/annotate',
    requireEncryption: true,
    encryption: {
      algorithm: 'AES-256',
      permissions: {
        ...DEFAULT_PERMISSIONS,
        modify: false,
        copy: false,
        annotate: false,
        assemble: false,
        fillForms: false,
      },
    },
    removeJavaScript: true,
  },
  {
    name: 'Internal Use',
    description: 'Light protections for internal documents',
    removeJavaScript: true,
  },
  {
    name: 'Confidential',
    description: 'AES-256, no copy, strip metadata',
    requireEncryption: true,
    requireUserPassword: true,
    encryption: {
      algorithm: 'AES-256',
      permissions: { ...DEFAULT_PERMISSIONS, copy: false, modify: false },
    },
    stripMetadata: true,
    removeJavaScript: true,
    removeAttachments: true,
  },
  {
    name: 'Highly Confidential',
    description: 'Strong encryption, no print/copy/modify, sanitize',
    requireEncryption: true,
    requireUserPassword: true,
    encryption: {
      algorithm: 'AES-256',
      permissions: {
        print: false,
        printHighQuality: false,
        modify: false,
        copy: false,
        annotate: false,
        fillForms: false,
        accessibility: true,
        assemble: false,
      },
    },
    stripMetadata: true,
    removeJavaScript: true,
    removeAttachments: true,
  },
  {
    name: 'Encrypted Archive',
    description: 'AES-256 archive with passwords',
    requireEncryption: true,
    requireUserPassword: true,
    encryption: {
      algorithm: 'AES-256',
    },
  },
  {
    name: 'No Print',
    description: 'Disallow printing',
    requireEncryption: true,
    encryption: {
      algorithm: 'AES-128',
      permissions: { ...DEFAULT_PERMISSIONS, print: false, printHighQuality: false },
    },
  },
  {
    name: 'No Copy',
    description: 'Disallow copy/extract',
    requireEncryption: true,
    encryption: {
      algorithm: 'AES-128',
      permissions: { ...DEFAULT_PERMISSIONS, copy: false },
    },
  },
  {
    name: 'Sanitized Export',
    description: 'Strip metadata, JS, attachments; no encryption',
    stripMetadata: true,
    removeJavaScript: true,
    removeAttachments: true,
  },
];

const STORAGE_KEY = 'bloom-pdf-security-policies-v1';

/** Policy definitions do not carry credentials; passwords are supplied per use. */
function copyPolicy(policy: SecurityPolicy): SecurityPolicy {
  const encryption = policy.encryption ? { ...policy.encryption } : policy.encryption;
  if (encryption) {
    delete encryption.userPassword;
    delete encryption.ownerPassword;
    if (encryption.permissions) encryption.permissions = { ...encryption.permissions };
  }
  return { ...policy, encryption, permissions: policy.permissions ? { ...policy.permissions } : undefined };
}

export class SecurityPolicyEngine implements ISecurityPolicyEngine {
  private custom: SecurityPolicy[] = [];

  constructor() {
    this.loadFromStorage();
  }

  listPolicies(): string[] {
    return [...BUILTIN.map((p) => p.name), ...this.custom.map((p) => p.name)];
  }

  getPolicy(name: string): SecurityPolicy | null {
    const policy = (
      BUILTIN.find((p) => p.name === name) ??
      this.custom.find((p) => p.name === name) ??
      null
    );
    return policy ? copyPolicy(policy) : null;
  }

  listPolicyDetails(): SecurityPolicy[] {
    return [...BUILTIN, ...this.custom].map(copyPolicy);
  }

  createPolicy(policy: SecurityPolicy): void {
    if (BUILTIN.some((p) => p.name === policy.name)) {
      throw new Error(`Cannot overwrite built-in policy "${policy.name}"`);
    }
    if (policy.encryption && ('userPassword' in policy.encryption || 'ownerPassword' in policy.encryption)) {
      throw new Error('Passwords cannot be stored in a policy; provide them when applying it.');
    }
    this.custom = this.custom.filter((p) => p.name !== policy.name);
    this.custom.push(copyPolicy(policy));
    this.saveToStorage();
  }

  deletePolicy(name: string): boolean {
    if (BUILTIN.some((p) => p.name === name)) return false;
    const before = this.custom.length;
    this.custom = this.custom.filter((p) => p.name !== name);
    this.saveToStorage();
    return this.custom.length < before;
  }

  async applyPolicy(
    doc: PDFDocumentData,
    name: string,
    passwordOverrides?: { userPassword?: string; ownerPassword?: string },
  ): Promise<PDFDocumentData> {
    const policy = this.getPolicy(name);
    if (!policy) throw new Error(`Unknown security policy: ${name}`);

    if (policy.requireEncryption) {
      if (!policy.encryption) throw new Error('The policy does not define an encryption algorithm.');
      validateEncryptionPasswords(passwordOverrides ?? {});
      if (policy.requireUserPassword && !passwordOverrides?.userPassword) {
        throw new Error('A user password is required for this policy.');
      }
      if (isEncryptedTrailer(doc.xref.trailerDict)) {
        throw new Error('The document is already encrypted; decrypt it before applying this policy.');
      }
      // Encryption must not fail for missing secure randomness after sanitization.
      randomBytes(1);
    }

    if (!policy.requireEncryption && !policy.stripMetadata && !policy.removeJavaScript && !policy.removeAttachments) {
      return doc;
    }
    await runDocumentTransaction(doc, async staged => {
      if (policy.stripMetadata || policy.removeJavaScript || policy.removeAttachments) {
        await sanitizationEngine.sanitize(staged, {
          metadata: !!policy.stripMetadata,
          javascript: !!policy.removeJavaScript,
          embeddedFiles: !!policy.removeAttachments,
          comments: name === 'Sanitized Export',
          unusedObjects: name === 'Sanitized Export',
          hiddenLayers: name === 'Sanitized Export',
          alternativeImages: name === 'Sanitized Export',
        });
      } else {
        if (policy.removeJavaScript) javaScriptSecurityEngine.removeJavaScript(staged);
        if (policy.removeAttachments) embeddedFileSecurityEngine.removeAllAttachments(staged);
        if (policy.stripMetadata) {
          metadataEngine.stripMetadata(staged, { stripInfo: true, stripXmp: true });
        }
      }

      if (policy.requireEncryption && policy.encryption) {
        await encryptDocumentObjects(staged, {
          ...policy.encryption,
          // Never use persisted policy credentials, including legacy custom policies.
          userPassword: passwordOverrides?.userPassword ?? '',
          ownerPassword: passwordOverrides!.ownerPassword,
          permissions: policy.encryption.permissions ?? policy.permissions,
        });
      }

    });
    return doc;
  }

  private loadFromStorage(): void {
    try {
      if (typeof localStorage === 'undefined') return;
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      this.custom = JSON.parse(raw) as SecurityPolicy[];
    } catch {
      this.custom = [];
    }
  }

  private saveToStorage(): void {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.custom));
    } catch {
      /* ignore */
    }
  }
}

export const securityPolicyEngine = new SecurityPolicyEngine();
