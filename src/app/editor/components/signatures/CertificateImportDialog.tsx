'use client';

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button, Dialog, DialogFooter, Field, Notice, SecretInput, TextArea } from '../../ui';
import { X, Upload, KeyRound, Trash2, Check } from 'lucide-react';
import {
  getCertificateManager,
  formatCertificateSummary,
  type ManagedIdentity,
} from '@/engine/browser-core';

interface CertificateImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after import / selection / remove so the parent can refresh. */
  onChange?: (identities: ManagedIdentity[]) => void;
}

export function CertificateImportDialog({
  open,
  onOpenChange,
  onChange,
}: CertificateImportDialogProps) {
  const [identities, setIdentities] = useState<ManagedIdentity[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [pemPaste, setPemPaste] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pemInputId = useId();
  const identitiesLabelId = useId();
  // Clear the previous session's error without discarding the entered certificate text.
  const [previousOpen, setPreviousOpen] = useState(false);
  if (previousOpen !== open) {
    setPreviousOpen(open);
    if (open) setError(null);
    else setPassword('');
  }
  const fileRef = useRef<HTMLInputElement>(null);
  const importPemRef = useRef<HTMLButtonElement>(null);
  const identityRefs = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterRemoval = useRef<{ identityId: string | null } | null>(null);

  useLayoutEffect(() => {
    const pending = focusAfterRemoval.current;
    if (!pending) return;
    focusAfterRemoval.current = null;
    const nextIdentity = pending.identityId ? identityRefs.current.get(pending.identityId) : null;
    (nextIdentity ?? importPemRef.current)?.focus();
  }, [identities]);

  const refresh = useCallback(() => {
    const mgr = getCertificateManager();
    const list = mgr.list();
    setIdentities(list);
    setSelectedId(mgr.getSelected()?.id ?? null);
    onChange?.(list);
  }, [onChange]);

  useEffect(() => {
    if (!open) return;
    // Hydrate may be async on first open
    const t = window.setTimeout(refresh, 50);
    return () => window.clearTimeout(t);
  }, [open, refresh]);

  const select = (id: string) => {
    getCertificateManager().select(id);
    setSelectedId(id);
    onChange?.(getCertificateManager().list());
  };

  const remove = (id: string) => {
    const index = identities.findIndex(identity => identity.id === id);
    const next = identities[index + 1] ?? identities[index - 1];
    focusAfterRemoval.current = { identityId: next?.id ?? null };
    getCertificateManager().remove(id);
    refresh();
  };

  const importFile = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const manager = getCertificateManager();
      const identity = await manager.importFile(file, password);
      manager.select(identity.id);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPassword('');
      setBusy(false);
    }
  };

  const importPem = async () => {
    if (!pemPaste.trim()) {
      setError('Paste a PEM certificate and/or private key.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const manager = getCertificateManager();
      const identity = await manager.importPem(pemPaste.trim());
      manager.select(identity.id);
      setPemPaste('');
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      icon={<KeyRound size={18} />}
      title="Certificates"
      description={<>
        Import PEM, DER, or a password-authenticated P12/PFX. Private keys stay in memory for this session only.
        P12/PFX supports PBES2 AES-CBC; legacy encryption and files without integrity protection are not supported.
      </>}
    >
      <Button variant="ghost" size="sm" aria-label="Close certificates" className="absolute right-3 top-3 w-8 px-0" onClick={() => onOpenChange(false)}>
        <X size={16} aria-hidden="true" />
      </Button>

      <div className="mt-5 space-y-4">
        <div className="space-y-2">
          <p className="text-xs font-medium text-app-muted">Import file</p>
          <input
            ref={fileRef}
            type="file"
            accept=".pem,.crt,.cer,.der,.p12,.pfx,.key"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importFile(f);
              e.target.value = '';
            }}
          />
          <div className="flex gap-2">
            <SecretInput
              autoComplete="off"
              aria-label="P12/PFX password (optional)"
              placeholder="P12/PFX password (if any)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="min-w-0 flex-1"
            />
            <Button variant="primary" disabled={busy} onClick={() => fileRef.current?.click()}>
              <Upload size={14} aria-hidden="true" /> Browse
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <Field label="Or paste PEM" id={pemInputId}>
            <TextArea
              secret
              value={pemPaste}
              onChange={(e) => setPemPaste(e.target.value)}
              placeholder={'-----BEGIN CERTIFICATE-----\n...\n-----BEGIN PRIVATE KEY-----\n...'}
              rows={5}
              className="font-mono text-[11px]"
            />
          </Field>
          <Button ref={importPemRef} className="w-full" disabled={busy} onClick={() => void importPem()}>
            Import PEM
          </Button>
        </div>

        {error && <Notice tone="danger" className="text-xs">{error}</Notice>}

        <div className="space-y-2">
          <p id={identitiesLabelId} className="text-xs font-medium text-app-muted">Available identities</p>
          {identities.length === 0 && (
            <p className="text-xs text-app-faint">No certificates imported yet.</p>
          )}
          <div role="group" aria-labelledby={identitiesLabelId} className="space-y-2">
            {identities.map((id) => {
              const active = selectedId === id.id;
              const summary = id.leaf
                ? formatCertificateSummary(id.leaf)
                : id.label;
              return (
                <div
                  key={id.id}
                  className={`rounded-xl border p-2.5 transition-colors ${
                    active ? 'border-accent bg-bloom-100' : 'border-app bg-panel-elevated hover:border-app-strong'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      ref={element => {
                        if (element) identityRefs.current.set(id.id, element);
                        else identityRefs.current.delete(id.id);
                      }}
                      aria-pressed={active}
                      onClick={() => select(id.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="flex items-center gap-1.5 truncate text-[12px] font-medium text-app">
                        {active && <Check size={12} aria-hidden="true" className="shrink-0 text-accent" />}
                        {id.label}
                      </span>
                      <span className="mt-0.5 block truncate text-[10px] text-app-muted">{summary}</span>
                      <span className="mt-1 block text-[10px] text-app-faint">
                        {id.source.toUpperCase()}
                        {id.hasPrivateKey ? ' · key loaded' : ' · cert only (re-import key to sign)'}
                        {id.certificates.length > 1 ? ` · chain ${id.certificates.length}` : ''}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove certificate ${id.label}`}
                      className="rounded p-1 text-app-muted hover:text-danger pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                      onClick={() => remove(id.id)}
                    >
                      <Trash2 size={12} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button onClick={() => onOpenChange(false)}>Done</Button>
      </DialogFooter>
    </Dialog>
  );
}
