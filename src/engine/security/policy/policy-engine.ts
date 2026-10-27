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
import { encryptDocumentObjects } from '../encryption/encrypt-pipeline';
import { isEncryptedTrailer } from '../encryption/encrypt-dict';
import { sanitizationEngine } from '../sanitization/sanitization-engine';
import { javaScriptSecurityEngine } from '../javascript/javascript-engine';
import { embeddedFileSecurityEngine } from '../embedded-files/embedded-file-engine';
import { metadataEngine } from '../metadata/metadata-engine';

export interface SecurityPolicy {
  name: string;
  description: string;
  encryption?: EncryptOptions | null;
  requireEncryption?: boolean;
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
      userPassword: '',
      ownerPassword: 'owner',
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
    encryption: {
      algorithm: 'AES-256',
      userPassword: 'confidential',
      ownerPassword: 'owner',
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
    encryption: {
      algorithm: 'AES-256',
      userPassword: 'secret',
      ownerPassword: 'owner',
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
    encryption: {
      algorithm: 'AES-256',
      userPassword: 'archive',
      ownerPassword: 'owner',
    },
  },
  {
    name: 'No Print',
    description: 'Disallow printing',
    requireEncryption: true,
    encryption: {
      algorithm: 'AES-128',
      userPassword: '',
      ownerPassword: 'owner',
      permissions: { ...DEFAULT_PERMISSIONS, print: false, printHighQuality: false },
    },
  },
  {
    name: 'No Copy',
    description: 'Disallow copy/extract',
    requireEncryption: true,
    encryption: {
      algorithm: 'AES-128',
      userPassword: '',
      ownerPassword: 'owner',
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

export class SecurityPolicyEngine implements ISecurityPolicyEngine {
  private custom: SecurityPolicy[] = [];

  constructor() {
    this.loadFromStorage();
  }

  listPolicies(): string[] {
    return [...BUILTIN.map((p) => p.name), ...this.custom.map((p) => p.name)];
  }

  getPolicy(name: string): SecurityPolicy | null {
    return (
      BUILTIN.find((p) => p.name === name) ??
      this.custom.find((p) => p.name === name) ??
      null
    );
  }

  listPolicyDetails(): SecurityPolicy[] {
    return [...BUILTIN, ...this.custom];
  }

  createPolicy(policy: SecurityPolicy): void {
    if (BUILTIN.some((p) => p.name === policy.name)) {
      throw new Error(`Cannot overwrite built-in policy "${policy.name}"`);
    }
    this.custom = this.custom.filter((p) => p.name !== policy.name);
    this.custom.push(policy);
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

    if (policy.stripMetadata || policy.removeJavaScript || policy.removeAttachments) {
      await sanitizationEngine.sanitize(doc, {
        metadata: !!policy.stripMetadata,
        javascript: !!policy.removeJavaScript,
        embeddedFiles: !!policy.removeAttachments,
        comments: name === 'Sanitized Export',
        unusedObjects: name === 'Sanitized Export',
      });
    } else {
      if (policy.removeJavaScript) javaScriptSecurityEngine.removeJavaScript(doc);
      if (policy.removeAttachments) embeddedFileSecurityEngine.removeAllAttachments(doc);
      if (policy.stripMetadata) {
        metadataEngine.stripMetadata(doc, { stripInfo: true, stripXmp: true });
      }
    }

    if (policy.requireEncryption && policy.encryption && !isEncryptedTrailer(doc.xref.trailerDict)) {
      await encryptDocumentObjects(doc, {
        ...policy.encryption,
        userPassword: passwordOverrides?.userPassword ?? policy.encryption.userPassword,
        ownerPassword: passwordOverrides?.ownerPassword ?? policy.encryption.ownerPassword,
        permissions: policy.encryption.permissions ?? policy.permissions,
      });
    }

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
