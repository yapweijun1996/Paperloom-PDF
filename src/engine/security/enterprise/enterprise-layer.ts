/**
 * Enterprise Security Layer — Phase 16.
 * Batch ops, audit log, permission templates, pluggable key providers.
 */

import type { PDFDocumentData } from '../../types';
import type { EncryptOptions, PdfPermissions } from '../types';
import { DEFAULT_PERMISSIONS } from '../types';
import { encryptDocumentObjects } from '../encryption/encrypt-pipeline';
import { sanitizationEngine } from '../sanitization/sanitization-engine';
import { permissionEngine } from '../permissions/permission-engine';
import { getEncryptDictFromTrailer } from '../encryption/encrypt-dict';
import { securityPolicyEngine } from '../policy/policy-engine';

export interface AuditEntry {
  id: string;
  timestamp: string;
  operation: string;
  detail?: string;
  documentLabel?: string;
  ok: boolean;
}

export interface PermissionTemplate {
  name: string;
  permissions: PdfPermissions;
}

export interface KeyProvider {
  id: string;
  label: string;
  /** Future: HSM / PKCS#11 / cloud KMS */
  kind: 'software' | 'hsm' | 'pkcs11' | 'cloud-kms' | 'smartcard';
  isAvailable(): Promise<boolean>;
}

export interface BatchItem {
  id: string;
  doc: PDFDocumentData;
  label?: string;
}

export interface BatchResult {
  id: string;
  label?: string;
  ok: boolean;
  error?: string;
}

const AUDIT_KEY = 'bloom-pdf-security-audit-v1';

const PERMISSION_TEMPLATES: PermissionTemplate[] = [
  { name: 'Full Access', permissions: { ...DEFAULT_PERMISSIONS } },
  {
    name: 'View and Print',
    permissions: {
      ...DEFAULT_PERMISSIONS,
      modify: false,
      copy: false,
      annotate: false,
      assemble: false,
      fillForms: false,
    },
  },
  {
    name: 'Fill Forms Only',
    permissions: {
      ...DEFAULT_PERMISSIONS,
      modify: false,
      copy: false,
      annotate: false,
      assemble: false,
      fillForms: true,
      print: true,
    },
  },
];

class SoftwareKeyProvider implements KeyProvider {
  id = 'software';
  label = 'Software keys (Web Crypto)';
  kind = 'software' as const;
  async isAvailable(): Promise<boolean> {
    return typeof globalThis.crypto?.subtle !== 'undefined';
  }
}

/** Placeholder providers for future enterprise integrations. */
class StubKeyProvider implements KeyProvider {
  constructor(
    public id: string,
    public label: string,
    public kind: KeyProvider['kind'],
  ) {}
  async isAvailable(): Promise<boolean> {
    return false;
  }
}

export class EnterpriseSecurityLayer {
  readonly keyProviders: KeyProvider[] = [
    new SoftwareKeyProvider(),
    new StubKeyProvider('hsm', 'Hardware Security Module', 'hsm'),
    new StubKeyProvider('pkcs11', 'PKCS#11 Provider', 'pkcs11'),
    new StubKeyProvider('cloud-kms', 'Cloud Key Management', 'cloud-kms'),
    new StubKeyProvider('smartcard', 'Smart Card', 'smartcard'),
  ];

  private audit: AuditEntry[] = [];

  constructor() {
    this.loadAudit();
  }

  listPermissionTemplates(): PermissionTemplate[] {
    return [...PERMISSION_TEMPLATES];
  }

  getPermissionTemplate(name: string): PermissionTemplate | null {
    return PERMISSION_TEMPLATES.find((t) => t.name === name) ?? null;
  }

  async batchEncrypt(
    items: BatchItem[],
    options: EncryptOptions,
    parallel = true,
  ): Promise<BatchResult[]> {
    const run = async (item: BatchItem): Promise<BatchResult> => {
      try {
        await encryptDocumentObjects(item.doc, options);
        this.log('batchEncrypt', true, item.label, options.algorithm);
        return { id: item.id, label: item.label, ok: true };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        this.log('batchEncrypt', false, item.label, error);
        return { id: item.id, label: item.label, ok: false, error };
      }
    };
    return parallel ? Promise.all(items.map(run)) : sequential(items, run);
  }

  async batchSanitize(items: BatchItem[], parallel = true): Promise<BatchResult[]> {
    const run = async (item: BatchItem): Promise<BatchResult> => {
      try {
        await sanitizationEngine.sanitize(item.doc);
        this.log('batchSanitize', true, item.label);
        return { id: item.id, label: item.label, ok: true };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        this.log('batchSanitize', false, item.label, error);
        return { id: item.id, label: item.label, ok: false, error };
      }
    };
    return parallel ? Promise.all(items.map(run)) : sequential(items, run);
  }

  async batchApplyPolicy(
    items: BatchItem[],
    policyName: string,
    parallel = true,
  ): Promise<BatchResult[]> {
    const run = async (item: BatchItem): Promise<BatchResult> => {
      try {
        await securityPolicyEngine.applyPolicy(item.doc, policyName);
        this.log('batchApplyPolicy', true, item.label, policyName);
        return { id: item.id, label: item.label, ok: true };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        this.log('batchApplyPolicy', false, item.label, error);
        return { id: item.id, label: item.label, ok: false, error };
      }
    };
    return parallel ? Promise.all(items.map(run)) : sequential(items, run);
  }

  async batchSetPermissions(
    items: BatchItem[],
    permissions: Partial<PdfPermissions>,
  ): Promise<BatchResult[]> {
    const results: BatchResult[] = [];
    for (const item of items) {
      try {
        const enc = getEncryptDictFromTrailer(item.doc.xref.trailerDict, item.doc.objects);
        if (!enc) {
          results.push({
            id: item.id,
            label: item.label,
            ok: false,
            error: 'Document is not encrypted — encrypt first to set permissions',
          });
          this.log('batchSetPermissions', false, item.label, 'not encrypted');
          continue;
        }
        const merged = permissionEngine.merge(permissions);
        permissionEngine.applyToEncryptDict(enc, merged);
        results.push({ id: item.id, label: item.label, ok: true });
        this.log('batchSetPermissions', true, item.label);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        results.push({ id: item.id, label: item.label, ok: false, error });
        this.log('batchSetPermissions', false, item.label, error);
      }
    }
    return results;
  }

  getAuditLog(): AuditEntry[] {
    return [...this.audit];
  }

  clearAuditLog(): void {
    this.audit = [];
    this.persistAudit();
  }

  /** Policy inheritance: child overrides parent fields. */
  inheritPolicy(
    parentName: string,
    child: Partial<import('../policy/policy-engine').SecurityPolicy> & { name: string },
  ): import('../policy/policy-engine').SecurityPolicy {
    const parent = securityPolicyEngine.getPolicy(parentName);
    if (!parent) throw new Error(`Parent policy not found: ${parentName}`);
    return {
      ...parent,
      ...child,
      encryption: child.encryption !== undefined ? child.encryption : parent.encryption,
      permissions: { ...parent.permissions, ...child.permissions },
    };
  }

  private log(operation: string, ok: boolean, documentLabel?: string, detail?: string): void {
    this.audit.unshift({
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      operation,
      detail,
      documentLabel,
      ok,
    });
    if (this.audit.length > 200) this.audit.length = 200;
    this.persistAudit();
  }

  private loadAudit(): void {
    try {
      if (typeof localStorage === 'undefined') return;
      const raw = localStorage.getItem(AUDIT_KEY);
      if (raw) this.audit = JSON.parse(raw) as AuditEntry[];
    } catch {
      this.audit = [];
    }
  }

  private persistAudit(): void {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(AUDIT_KEY, JSON.stringify(this.audit));
    } catch {
      /* ignore */
    }
  }
}

async function sequential<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (const item of items) out.push(await fn(item));
  return out;
}

export const enterpriseSecurity = new EnterpriseSecurityLayer();
