/**
 * Phase 9 — Certificate manager.
 * Holds imported certs + in-memory private keys; persists public cert PEMs.
 */

import {
  importFromPem,
  importCertificateDer,
  formatCertificateSummary,
  isCertificateExpired,
  isPem,
  type CertificateInfo,
  type ImportedCertificateBundle,
  type ImportedKeyMaterial,
} from './certificate-parser';
import { detectCertificateFileFormat, importPkcs12 } from './pkcs12';

const STORAGE_KEY = 'bloom-pdf-certificates-v1';

export interface ManagedIdentity {
  id: string;
  label: string;
  certificates: CertificateInfo[];
  leaf: CertificateInfo | null;
  /** Present only while the private key is loaded in this session. */
  hasPrivateKey: boolean;
  source: ImportedCertificateBundle['source'];
  importedAt: number;
}

interface PersistedIdentity {
  id: string;
  label: string;
  leafPem?: string;
  chainPems: string[];
  source: ImportedCertificateBundle['source'];
  importedAt: number;
}

export class CertificateManager {
  private identities: ManagedIdentity[] = [];
  private keys = new Map<string, ImportedKeyMaterial>();
  private selectedId: string | null = null;
  private storage: Storage | null;

  constructor(storage?: Storage | null) {
    this.storage =
      storage === undefined
        ? typeof localStorage !== 'undefined'
          ? localStorage
          : null
        : storage;
    void this.hydrate();
  }

  list(): ManagedIdentity[] {
    return this.identities.map((i) => ({ ...i, certificates: [...i.certificates] }));
  }

  getSelected(): ManagedIdentity | null {
    if (!this.selectedId) return null;
    return this.identities.find((i) => i.id === this.selectedId) ?? null;
  }

  getSelectedKey(): ImportedKeyMaterial | null {
    if (!this.selectedId) return null;
    return this.keys.get(this.selectedId) ?? null;
  }

  getSelectedLeafDer(): Uint8Array | null {
    return this.getSelected()?.leaf?.der ?? null;
  }

  select(id: string | null): void {
    this.selectedId = id;
  }

  /** Import from File (PEM / DER / P12 / PFX). */
  async importFile(
    file: File,
    password = '',
  ): Promise<ManagedIdentity> {
    const buf = new Uint8Array(await file.arrayBuffer());
    const format = detectCertificateFileFormat(file.name, buf);
    let bundle: ImportedCertificateBundle;

    if (format === 'pem' || isPem(new TextDecoder().decode(buf))) {
      bundle = await importFromPem(new TextDecoder().decode(buf), file.name);
    } else if (format === 'p12') {
      bundle = await importPkcs12(buf, password, file.name);
    } else {
      bundle = await importCertificateDer(buf, file.name);
    }

    return this.addBundle(bundle);
  }

  /** Import raw PEM string. */
  async importPem(pem: string, label?: string): Promise<ManagedIdentity> {
    return this.addBundle(await importFromPem(pem, label));
  }

  addBundle(bundle: ImportedCertificateBundle): ManagedIdentity {
    const id =
      bundle.leaf?.id ??
      `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const identity: ManagedIdentity = {
      id,
      label: bundle.label,
      certificates: bundle.certificates,
      leaf: bundle.leaf,
      hasPrivateKey: bundle.key != null,
      source: bundle.source,
      importedAt: Date.now(),
    };
    this.identities = [identity, ...this.identities.filter((i) => i.id !== id)];
    if (bundle.key) this.keys.set(id, bundle.key);
    if (!this.selectedId) this.selectedId = id;
    this.persistPublic();
    return { ...identity };
  }

  remove(id: string): void {
    this.identities = this.identities.filter((i) => i.id !== id);
    this.keys.delete(id);
    if (this.selectedId === id) {
      this.selectedId = this.identities[0]?.id ?? null;
    }
    this.persistPublic();
  }

  rename(id: string, label: string): void {
    const i = this.identities.find((x) => x.id === id);
    if (i) i.label = label.trim() || i.label;
    this.persistPublic();
  }

  summarize(id: string): string | null {
    const i = this.identities.find((x) => x.id === id);
    if (!i?.leaf) return i?.label ?? null;
    return formatCertificateSummary(i.leaf);
  }

  isExpired(id: string): boolean {
    const i = this.identities.find((x) => x.id === id);
    return i?.leaf ? isCertificateExpired(i.leaf) : false;
  }

  /** Persist public cert PEMs only (never private keys). */
  private persistPublic(): void {
    if (!this.storage) return;
    try {
      const payload: PersistedIdentity[] = this.identities.map((i) => ({
        id: i.id,
        label: i.label,
        leafPem: i.leaf?.pem,
        chainPems: i.certificates.map((c) => c.pem).filter(Boolean) as string[],
        source: i.source,
        importedAt: i.importedAt,
      }));
      this.storage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // quota
    }
  }

  private async hydrate(): Promise<void> {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as PersistedIdentity[];
      for (const p of parsed) {
        if (!p.leafPem && p.chainPems.length === 0) continue;
        try {
          const pem = [p.leafPem, ...p.chainPems].filter(Boolean).join('\n');
          const bundle = await importFromPem(pem, p.label);
          const id = p.id;
          const identity: ManagedIdentity = {
            id,
            label: p.label,
            certificates: bundle.certificates,
            leaf: bundle.leaf,
            hasPrivateKey: false, // keys never persisted
            source: p.source,
            importedAt: p.importedAt,
          };
          this.identities.push(identity);
        } catch {
          // skip corrupt
        }
      }
      if (this.identities.length && !this.selectedId) {
        this.selectedId = this.identities[0].id;
      }
    } catch {
      // ignore
    }
  }
}

let _mgr: CertificateManager | null = null;

export function getCertificateManager(): CertificateManager {
  if (!_mgr) _mgr = new CertificateManager();
  return _mgr;
}

export function resetCertificateManagerForTests(
  storage?: Storage | null,
): CertificateManager {
  _mgr = new CertificateManager(storage ?? null);
  return _mgr;
}
