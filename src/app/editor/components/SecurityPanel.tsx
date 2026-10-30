'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Shield,
  Lock,
  Unlock,
  FileSearch,
  Eraser,
  Sparkles,
  ScrollText,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  PanelLeftClose,
} from 'lucide-react';
import type { PDFDocumentData, FullSecurityReport } from '@/engine/browser-core';

interface SecurityPanelProps {
  doc: PDFDocumentData | null;
  engine: typeof import('@/engine/browser-core') | null;
  onDocChange: (doc: PDFDocumentData) => void;
  markDirty?: () => void;
  onBusyChange?: (busy: boolean) => void;
  onClose?: () => void;
  isMobile?: boolean;
  onRedact?: (mode: 'marks' | 'region' | 'page') => Promise<{ message: string; revision: number; editRevision: number; pageKey: string }>;
  documentRevision?: number;
  documentEditRevision?: number;
  documentPageKey?: string;
  onSelectRedactionRegion?: () => void;
  onCancelRedactionRegion?: () => void;
  selectingRedactionRegion?: boolean;
  hasRedactionRegion?: boolean;
}

type Tab = 'inspect' | 'protect' | 'sanitize' | 'policies';

export function SecurityPanel({ doc, engine, onDocChange, markDirty, onBusyChange, onClose, isMobile = false,
  onRedact, onSelectRedactionRegion, onCancelRedactionRegion, selectingRedactionRegion = false,
  hasRedactionRegion = false, documentRevision = 0, documentEditRevision = 0, documentPageKey = '' }: SecurityPanelProps) {
  const [tab, setTab] = useState<Tab>('inspect');
  const [report, setReport] = useState<FullSecurityReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [redactionStatus, setRedactionStatus] = useState<{ message: string; revision: number; editRevision: number; pageKey: string; doc: PDFDocumentData } | null>(null);
  const statusWasVisible = useRef(false);
  const redactionStatusVisible = !!redactionStatus && redactionStatus.doc === doc && redactionStatus.revision === documentRevision &&
    redactionStatus.editRevision === documentEditRevision && redactionStatus.pageKey === documentPageKey;
  useLayoutEffect(() => {
    if (!redactionStatus) statusWasVisible.current = false;
    else if (redactionStatusVisible) statusWasVisible.current = true;
    else if (statusWasVisible.current) { statusWasVisible.current = false; setRedactionStatus(null); }
  }, [redactionStatus, redactionStatusVisible]);
  const [error, setError] = useState<string | null>(null);
  const [redactionActionActive, setRedactionActionActive] = useState(false);

  const [userPassword, setUserPassword] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [passwordDocument, setPasswordDocument] = useState(doc);
  const [algorithm, setAlgorithm] = useState<'AES-256' | 'AES-128' | 'RC4-128'>('AES-256');
  const [allowPrint, setAllowPrint] = useState(true);
  const [allowCopy, setAllowCopy] = useState(true);
  const [allowModify, setAllowModify] = useState(false);
  const [policyName, setPolicyName] = useState('Confidential');
  const [policies, setPolicies] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    if (!doc || !engine) return;
    try {
      const full = await engine.securityEngine.inspector.inspectFull(doc);
      setReport(full);
      setPolicies(engine.securityEngine.policy.listPolicies());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [doc, engine]);

  if (passwordDocument !== doc) {
    setPasswordDocument(doc);
    setUserPassword('');
    setOwnerPassword('');
  }

  useEffect(() => {
    if (!doc || !engine) return;
    let active = true;
    void engine.securityEngine.inspector.inspectFull(doc).then(full => {
      if (!active) return;
      setReport(full);
      setPolicies(engine.securityEngine.policy.listPolicies());
    }).catch(e => {
      if (active) setError(e instanceof Error ? e.message : String(e));
    });
    return () => { active = false; };
  }, [doc, engine]);

  const run = useCallback(async (fn: () => Promise<string>) => {
    if (!doc || !engine) return;
    onBusyChange?.(true);
    setBusy(true);
    setError(null);
    setMessage(null);
    setRedactionStatus(null);
    setRedactionActionActive(false);
    try {
      // A failed security operation may have partially modified the graph.
      markDirty?.();
      const msg = await fn();
      onDocChange(doc);
      markDirty?.();
      setMessage(msg);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      onBusyChange?.(false);
      setBusy(false);
    }
  }, [doc, engine, onDocChange, markDirty, onBusyChange, refresh]);

  const runRedaction = useCallback(async (mode: 'marks' | 'region' | 'page') => {
    if (!onRedact) return;
    onBusyChange?.(true);
    setBusy(true);
    setError(null);
    setMessage(null);
    setRedactionStatus(null);
    setRedactionActionActive(true);
    try {
      const result = await onRedact(mode);
      if (doc) setRedactionStatus({ ...result, doc });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      onBusyChange?.(false);
      setBusy(false);
    }
  }, [doc, onRedact, onBusyChange, refresh]);

  if (!doc || !engine) {
    return (
      <div className="w-72 bg-panel/95 border-r border-app p-4 text-xs text-app-faint">
        Load a PDF to manage security.
      </div>
    );
  }

  if (isMobile && (selectingRedactionRegion || hasRedactionRegion)) {
    return (
      <div className="fixed bottom-14 left-2 right-2 z-[400] rounded-lg bg-zinc-900 p-3 text-xs text-white shadow-lg">
        <div className="flex items-center justify-between gap-2">
          <span>{selectingRedactionRegion ? 'Drag on the page to select a region.' : 'Check the selected area.'}</span>
          {hasRedactionRegion && <button type="button" disabled={busy} className="min-h-11 font-semibold underline" onClick={() => void runRedaction('region')}>Apply selected region</button>}
          <button type="button" disabled={busy} className="min-h-11 min-w-11 underline" onClick={onCancelRedactionRegion}>Cancel</button>
        </div>
        {error && <p role="alert" className="mt-2 text-red-300">{error}</p>}
      </div>
    );
  }

  const selectedPolicy = tab === 'policies' ? engine.securityEngine.policy.getPolicy(policyName) : null;

  return (
    <>
      {/* Z_LAYERS: chrome 100; mobile drawerBackdrop 300 / drawer 400. */}
      {isMobile && (
        <div className="fixed inset-0 z-[300] mobile-backdrop" onClick={onClose} />
      )}
      <div className={isMobile
        ? 'fixed bottom-0 left-0 right-0 z-[400] bg-panel/98 backdrop-blur-xl border-t border-app flex flex-col overflow-hidden mobile-sheet-up shadow-[0_-8px_40px_rgba(0,0,0,0.15)]'
        : 'w-72 bg-panel/95 backdrop-blur-md border-r border-app flex flex-col shrink-0 z-[100] overflow-hidden shadow-[4px_0_24px_rgba(0,0,0,0.08)] min-h-0 h-full'
      } style={isMobile ? { maxHeight: '65vh' } : undefined}>
      <div className="p-4 pb-2 border-b border-app">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[10px] font-bold tracking-widest text-emerald-500 uppercase">
            <Shield size={14} className="text-emerald-500" />
            Document Security
          </div>
          {onClose && (
            <button
              onClick={onClose}
              title="Hide sidebar panel"
              className="text-app-muted hover:text-app p-1 rounded-lg hover:bg-panel-elevated transition-colors"
            >
              <PanelLeftClose size={14} />
            </button>
          )}
        </div>
        {report && (
          <div className="mt-2 flex items-center justify-between text-xs">
            <span className="text-app-muted">Score</span>
            <span className={`font-semibold ${report.score >= 70 ? 'text-emerald-500' : report.score >= 40 ? 'text-amber-500' : 'text-red-500'}`}>
              {report.score}/100
            </span>
          </div>
        )}
      </div>

      <div className="flex border-b border-app text-[10px]">
        {([
          ['inspect', 'Inspect'],
          ['protect', 'Protect'],
          ['sanitize', 'Clean'],
          ['policies', 'Policy'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`flex-1 py-2.5 font-semibold uppercase tracking-wide transition-colors ${
              tab === id ? 'text-amber-500 border-b-2 border-amber-500 bg-panel-elevated' : 'text-app-muted hover:text-app'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3 text-xs">
        {tab === 'inspect' && report && (
          <>
            <Row label="Encryption" value={report.encrypted ? `${report.handler} / ${report.algorithm ?? '?'}` : 'None'} />
            <Row label="Revision" value={report.revision != null ? String(report.revision) : '—'} />
            <Row label="Metadata" value={report.metadata.hasInfo || report.metadata.hasXmp ? 'Present' : 'Clean'} />
            <Row label="Attachments" value={report.embeddedFiles.complete === false ? 'Inspection incomplete' : String(report.embeddedFiles.count)} warn={report.embeddedFiles.complete === false} />
            <Row label="JavaScript" value={report.javascript.present ? 'Detected' : 'None detected; inspection incomplete'} warn />
            <Row label="Integrity" value={report.integrity.ok ? 'OK' : `${report.integrity.issueCount} issue(s)`} warn={!report.integrity.ok} />
            <Row label="Redact marks" value={report.redactionMarksComplete === false ? `${report.redactionMarks} detected; inspection incomplete` : String(report.redactionMarks)} warn={report.redactionMarksComplete === false} />

            <div className="pt-2 space-y-1.5">
              <div className="text-[10px] font-bold tracking-widest text-app-faint uppercase">Recommendations</div>
              {report.recommendations.map((r) => (
                <div key={r} className="flex gap-2 text-app-muted leading-relaxed">
                  <AlertTriangle size={12} className="shrink-0 mt-0.5 text-amber-500" />
                  <span>{r}</span>
                </div>
              ))}
            </div>

            <button
              type="button"
              disabled={busy}
              onClick={() => run(async () => {
                await engine.securityEngine.integrity.scan(doc);
                return 'Integrity scan complete';
              })}
              className="w-full mt-2 flex items-center justify-center gap-2 rounded-lg bg-panel-elevated hover:bg-panel-elevated/80 py-2 text-app border border-app font-medium"
            >
              <FileSearch size={14} /> Rescan
            </button>
          </>
        )}

        {tab === 'protect' && (
          <>
            <label htmlFor="security-protect-user-password" className="block text-[10px] font-bold tracking-widest text-app-faint uppercase">User password</label>
            <input
              id="security-protect-user-password"
              type="password"
              value={userPassword}
              onChange={(e) => setUserPassword(e.target.value)}
              className="w-full rounded-lg border border-app bg-panel-elevated px-3 py-2 text-app outline-none focus:border-amber-500"
              placeholder="Optional open password"
            />
            <label htmlFor="security-protect-owner-password" className="block text-[10px] font-bold tracking-widest text-app-faint uppercase">Owner password</label>
            <input
              id="security-protect-owner-password"
              type="password"
              value={ownerPassword}
              onChange={(e) => setOwnerPassword(e.target.value)}
              className="w-full rounded-lg border border-app bg-panel-elevated px-3 py-2 text-app outline-none focus:border-amber-500"
              placeholder="Required for permissions"
              required
            />
            <p className="text-app-faint leading-relaxed">An owner password is required. Without a user password, anyone can open the PDF.</p>
            <label className="block text-[10px] font-bold tracking-widest text-app-faint uppercase">Algorithm</label>
            <select
              value={algorithm}
              onChange={(e) => setAlgorithm(e.target.value as typeof algorithm)}
              className="w-full rounded-lg border border-app bg-panel-elevated px-3 py-2 text-app"
            >
              <option value="AES-256">AES-256 (recommended)</option>
              <option value="AES-128">AES-128</option>
              <option value="RC4-128">RC4-128 (legacy)</option>
            </select>

            <div className="space-y-2 pt-1">
              <Toggle label="Allow print" checked={allowPrint} onChange={setAllowPrint} />
              <Toggle label="Allow copy" checked={allowCopy} onChange={setAllowCopy} />
              <Toggle label="Allow modify" checked={allowModify} onChange={setAllowModify} />
            </div>

            <button
              type="button"
              disabled={busy || engine.securityEngine.isEncrypted(doc) || ownerPassword.length === 0}
              onClick={() => run(async () => {
                await engine.securityEngine.encrypt(doc, {
                  userPassword,
                  ownerPassword,
                  algorithm,
                  permissions: {
                    print: allowPrint,
                    printHighQuality: allowPrint,
                    copy: allowCopy,
                    modify: allowModify,
                    annotate: allowModify,
                    fillForms: true,
                    accessibility: true,
                    assemble: allowModify,
                  },
                });
                return 'Document encrypted';
              })}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 py-2 text-white font-medium shadow-sm"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />}
              Encrypt PDF
            </button>

            {engine.securityEngine.isEncrypted(doc) && (
              <button
                type="button"
                disabled={busy}
                onClick={() => run(async () => {
                  await engine.securityEngine.decrypt(doc, userPassword);
                  return 'Document decrypted (Encrypt dict removed)';
                })}
                className="w-full flex items-center justify-center gap-2 rounded-lg bg-panel-elevated hover:bg-panel-elevated/80 py-2 text-app border border-app"
              >
                <Unlock size={14} /> Remove encryption
              </button>
            )}
          </>
        )}

        {tab === 'sanitize' && (
          <>
            {onRedact && (
              <div className="space-y-2 border-b border-app pb-3">
                <p className="font-semibold text-app">Secure redaction</p>
                <p className="text-app-faint leading-relaxed">
                  Select an area or the entire page. Unsupported content is refused; independent copies elsewhere may remain.
                </p>
                <button type="button" disabled={busy} onClick={() => { setRedactionStatus(null); setError(null); (selectingRedactionRegion ? onCancelRedactionRegion : onSelectRedactionRegion)?.(); }}
                  className="w-full rounded-lg bg-panel-elevated hover:bg-panel-elevated/80 py-2 text-app border border-app">
                  {selectingRedactionRegion ? 'Cancel region selection' : 'Select redaction region'}
                </button>
                {selectingRedactionRegion && <p role="status" className="text-app-faint">Drag across the page to select a region.</p>}
                {hasRedactionRegion && <button type="button" disabled={busy} onClick={() => void runRedaction('region')}
                  className="w-full rounded-lg bg-red-700 hover:bg-red-600 py-2 text-white font-medium">
                  Apply selected region
                </button>}
                <button type="button" disabled={busy} onClick={() => void runRedaction('page')}
                  className="w-full rounded-lg bg-panel-elevated hover:bg-panel-elevated/80 py-2 text-app border border-app">
                  Redact entire current page
                </button>
                <button type="button" disabled={busy} onClick={() => void runRedaction('marks')}
                  className="w-full rounded-lg bg-panel-elevated hover:bg-panel-elevated/80 py-2 text-app border border-app">
                  Apply existing redaction marks
                </button>
                {redactionStatus && redactionStatusVisible && (
                  <div role="status" className="flex gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2 text-emerald-500 font-medium">
                    <CheckCircle2 size={14} className="shrink-0 mt-0.5" />
                    <span>{redactionStatus.message}</span>
                  </div>
                )}
                {redactionActionActive && error && (
                  <div role="alert" className="flex gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-red-500 font-medium">
                    <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                    <span>{error}</span>
                  </div>
                )}
              </div>
            )}
            <p className="text-app-faint leading-relaxed">
              Remove metadata, JavaScript, attachments, and unused objects.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => run(async () => {
                const r = await engine.securityEngine.sanitization.sanitize(doc);
                return `${r.report.join(' · ') || 'Cleanup prepared'}. Download a new copy to apply changes; the original file is unchanged.`;
              })}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-amber-600 hover:bg-amber-500 py-2 text-white font-medium shadow-sm"
            >
              <Eraser size={14} /> Sanitize document
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => run(async () => {
                const result = engine.securityEngine.javascript.removeJavaScript(doc);
                return `Removed ${result.removed} known JavaScript action link(s); other action types are unchanged. Download a new copy to apply changes; the original file is unchanged.`;
              })}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-panel-elevated hover:bg-panel-elevated/80 py-2 text-app border border-app"
            >
              Remove JavaScript
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => run(async () => {
                const n = engine.securityEngine.embeddedFiles.removeAllAttachments(doc);
                return `Removed ${n} attachment(s). Download a new copy to apply changes; the original file is unchanged.`;
              })}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-panel-elevated hover:bg-panel-elevated/80 py-2 text-app border border-app"
            >
              Remove attachments
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => run(async () => {
                engine.securityEngine.metadata.stripMetadata(doc);
                return 'Metadata cleanup prepared. Download a new copy to apply changes; the original file is unchanged.';
              })}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-panel-elevated hover:bg-panel-elevated/80 py-2 text-app border border-app"
            >
              Strip metadata
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => run(async () => {
                const r = await engine.securityEngine.optimizer.optimizeWithReport(doc);
                return r.notes.join(' · ');
              })}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-panel-elevated hover:bg-panel-elevated/80 py-2 text-app border border-app"
            >
              <Sparkles size={14} /> Optimize (keep security)
            </button>
          </>
        )}

        {tab === 'policies' && (
          <>
            <label className="block text-[10px] font-bold tracking-widest text-app-faint uppercase">Policy</label>
            <select
              value={policyName}
              onChange={(e) => setPolicyName(e.target.value)}
              className="w-full rounded-lg border border-app bg-panel-elevated px-3 py-2 text-app"
            >
              {policies.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            <p className="text-app-faint leading-relaxed">
              {selectedPolicy?.description}
            </p>
            {selectedPolicy?.requireEncryption && (
              <>
                <label htmlFor="security-policy-user-password" className="block text-[10px] font-bold tracking-widest text-app-faint uppercase">User password{selectedPolicy.requireUserPassword ? ' (required)' : ' (optional)'}</label>
                <input id="security-policy-user-password" type="password" value={userPassword}
                  onChange={(e) => setUserPassword(e.target.value)} required={!!selectedPolicy.requireUserPassword}
                  className="w-full rounded-lg border border-app bg-panel-elevated px-3 py-2 text-app outline-none focus:border-amber-500" />
                <label htmlFor="security-policy-owner-password" className="block text-[10px] font-bold tracking-widest text-app-faint uppercase">Owner password (required)</label>
                <input id="security-policy-owner-password" type="password" value={ownerPassword}
                  onChange={(e) => setOwnerPassword(e.target.value)} required
                  className="w-full rounded-lg border border-app bg-panel-elevated px-3 py-2 text-app outline-none focus:border-amber-500" />
                {!selectedPolicy.requireUserPassword && <p className="text-app-faint leading-relaxed">Without a user password, anyone can open the PDF.</p>}
              </>
            )}
            <button
              type="button"
              disabled={busy || !selectedPolicy || (!!selectedPolicy.requireEncryption &&
                (ownerPassword.length === 0 || (!!selectedPolicy.requireUserPassword && userPassword.length === 0)))}
              onClick={() => run(async () => {
                await engine.securityEngine.policy.applyPolicy(doc, policyName, {
                  userPassword,
                  ownerPassword,
                });
                return `Applied policy: ${policyName}`;
              })}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-amber-600 hover:bg-amber-500 py-2 text-white font-medium shadow-sm"
            >
              <ScrollText size={14} /> Apply policy
            </button>
          </>
        )}

        {message && (
          <div className="flex gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2 text-emerald-500 font-medium">
            <CheckCircle2 size={14} className="shrink-0 mt-0.5" />
            <span>{message}</span>
          </div>
        )}
        {error && !redactionActionActive && (
          <div className="flex gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-red-500 font-medium">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
      </div>
    </div>
    </>
  );
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-app-faint">{label}</span>
      <span className={`font-medium text-right ${warn ? 'text-amber-500' : 'text-app'}`}>{value}</span>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 cursor-pointer">
      <span className="text-app-muted">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${checked ? 'bg-amber-500' : 'bg-panel-elevated border border-app'}`}
      >
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
      </button>
    </label>
  );
}
