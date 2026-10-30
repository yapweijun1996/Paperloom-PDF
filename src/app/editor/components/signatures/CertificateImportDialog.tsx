'use client';

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
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
  const openerRef = useRef<HTMLElement | null>(null);
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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        {/* Z_LAYERS.modalBackdrop (500) / modal (600). */}
        <Dialog.Overlay className="fixed inset-0 z-[500] bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          onOpenAutoFocus={() => { openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
          onCloseAutoFocus={event => {
            if (openerRef.current?.isConnected) {
              event.preventDefault();
              openerRef.current.focus();
            }
          }}
          className="fixed left-1/2 top-1/2 z-[600] w-[min(520px,94vw)] max-h-[88vh] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl flex flex-col"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700/80">
            <Dialog.Title className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
              <KeyRound size={16} /> Certificates
            </Dialog.Title>
            <Dialog.Close aria-label="Close certificates" className="p-1 rounded text-zinc-400 hover:text-white hover:bg-zinc-800">
              <X size={16} />
            </Dialog.Close>
          </div>

          <div className="p-4 space-y-4 overflow-y-auto flex-1">
            <Dialog.Description className="text-[11px] text-zinc-500">
              Import PEM, DER, or a password-authenticated P12/PFX. Private keys stay in memory for this session only.
              P12/PFX supports PBES2 AES-CBC; legacy encryption and files without integrity protection are not supported.
            </Dialog.Description>

            <div className="space-y-2">
              <div className="text-[10px] font-bold tracking-widest text-zinc-400 uppercase">
                Import file
              </div>
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
                <input
                  type="password"
                  aria-label="P12/PFX password (optional)"
                  placeholder="P12/PFX password (if any)"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="flex-1 rounded-md bg-zinc-800 border border-zinc-700 px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-zinc-500"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => fileRef.current?.click()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-bloom-500 hover:bg-bloom-600 disabled:opacity-50 text-white text-xs font-semibold"
                >
                  <Upload size={14} /> Browse
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor={pemInputId} className="text-[10px] font-bold tracking-widest text-zinc-400 uppercase">
                Or paste PEM
              </label>
              <textarea
                id={pemInputId}
                value={pemPaste}
                onChange={(e) => setPemPaste(e.target.value)}
                placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----BEGIN PRIVATE KEY-----&#10;..."
                rows={5}
                className="w-full rounded-md bg-zinc-800 border border-zinc-700 px-2 py-1.5 text-[11px] font-mono text-zinc-200 outline-none focus:border-zinc-500 resize-y"
              />
              <button
                ref={importPemRef}
                type="button"
                disabled={busy}
                onClick={() => void importPem()}
                className="w-full py-1.5 rounded-md bg-zinc-800 border border-zinc-700 hover:bg-zinc-700 disabled:opacity-50 text-zinc-200 text-xs font-semibold"
              >
                Import PEM
              </button>
            </div>

            {error && (
              <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
                {error}
              </div>
            )}

            <div className="space-y-2">
              <div id={identitiesLabelId} className="text-[10px] font-bold tracking-widest text-zinc-400 uppercase">
                Available identities
              </div>
              {identities.length === 0 && (
                <p className="text-[11px] text-zinc-500">No certificates imported yet.</p>
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
                    className={`rounded-lg border p-2.5 transition-colors ${
                      active
                        ? 'border-emerald-500 bg-emerald-500/10'
                        : 'border-zinc-700 hover:border-zinc-500 bg-zinc-800/40'
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
                        className="min-w-0 flex-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
                      >
                        <div className="text-[12px] font-medium text-zinc-100 truncate flex items-center gap-1.5">
                          {active && <Check size={12} className="text-emerald-400 shrink-0" />}
                          {id.label}
                        </div>
                        <div className="text-[10px] text-zinc-500 mt-0.5 truncate">{summary}</div>
                        <div className="text-[10px] text-zinc-600 mt-1">
                          {id.source.toUpperCase()}
                          {id.hasPrivateKey ? ' · key loaded' : ' · cert only (re-import key to sign)'}
                          {id.certificates.length > 1 ? ` · chain ${id.certificates.length}` : ''}
                        </div>
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove certificate ${id.label}`}
                        className="p-1 rounded text-zinc-500 hover:text-red-300"
                        onClick={() => remove(id.id)}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                );
              })}
              </div>
            </div>
          </div>

          <div className="px-4 py-3 border-t border-zinc-700/80 flex justify-end">
            <Dialog.Close className="px-4 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold">
              Done
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
