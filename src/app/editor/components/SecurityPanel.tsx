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
  PanelLeftClose,
} from 'lucide-react';
import type { PDFDocumentData, FullSecurityReport } from '@/engine/browser-core';
import { Button, Field, Notice, SecretInput, Select, TextInput, useConfirm } from '../ui';
import { REDACTION_PRESETS, customPreset, type RedactionPreset, type RedactionPresetId } from '../redaction-patterns';

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
  /** Places redaction marks on every match for review; resolves to a status message. */
  onMarkPattern?: (preset: RedactionPreset) => Promise<string>;
}

type Tab = 'inspect' | 'protect' | 'sanitize' | 'policies';

export function SecurityPanel({ doc, engine, onDocChange, markDirty, onBusyChange, onClose, isMobile = false,
  onRedact, onSelectRedactionRegion, onCancelRedactionRegion, selectingRedactionRegion = false,
  hasRedactionRegion = false, documentRevision = 0, documentEditRevision = 0, documentPageKey = '', onMarkPattern }: SecurityPanelProps) {
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
  const [presetId, setPresetId] = useState<RedactionPresetId>('email');
  const [customPattern, setCustomPattern] = useState('');
  const [findStatus, setFindStatus] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const { confirm: requestConfirm, dialog: confirmDialog } = useConfirm();

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

  // Page and marks redaction remove content outright, so they ask first.
  const confirmRedaction = useCallback(async (mode: 'page' | 'marks') => {
    const confirmed = await requestConfirm(mode === 'page' ? {
      title: 'Redact entire page',
      message: 'Remove all content from the current page? You can undo this before downloading; a downloaded copy keeps the redaction.',
      confirmLabel: 'Redact page',
      tone: 'danger',
    } : {
      title: 'Apply redaction marks',
      message: 'Remove the content under every existing redaction mark? You can undo this before downloading; a downloaded copy keeps the redaction.',
      confirmLabel: 'Apply marks',
      tone: 'danger',
    });
    if (confirmed) await runRedaction(mode);
  }, [requestConfirm, runRedaction]);

  if (!doc || !engine) {
    return (
      <div className="w-64 bg-panel/95 border-r border-app p-4 text-xs text-app-faint">
        Load a PDF to manage security.
      </div>
    );
  }

  if (isMobile && (selectingRedactionRegion || hasRedactionRegion)) {
    return (
      <div className="fixed bottom-14 left-2 right-2 z-[400] rounded-lg border border-app bg-panel p-3 text-xs text-app shadow-lg">
        <div className="flex items-center justify-between gap-2">
          <span>{selectingRedactionRegion ? 'Drag on the page to select a region.' : 'Check the selected area.'}</span>
          {hasRedactionRegion && <button type="button" disabled={busy} className="min-h-11 font-semibold text-danger underline" onClick={() => void runRedaction('region')}>Apply selected region</button>}
          <button type="button" disabled={busy} className="min-h-11 min-w-11 underline" onClick={onCancelRedactionRegion}>Cancel</button>
        </div>
        {error && <p role="alert" className="mt-2 text-danger">{error}</p>}
      </div>
    );
  }

  const selectedPolicy = tab === 'policies' ? engine.securityEngine.policy.getPolicy(policyName) : null;
  const sectionLabel = 'block text-[10px] font-bold tracking-widest text-app-faint uppercase';

  return (
    <>
      {/* Z_LAYERS: chrome 100; mobile drawerBackdrop 300 / drawer 400. */}
      {isMobile && (
        <div className="fixed inset-0 z-[300] mobile-backdrop" onClick={onClose} />
      )}
      <div data-security-panel className={isMobile
        ? 'fixed bottom-0 left-0 right-0 z-[400] bg-panel/98 backdrop-blur-xl border-t border-app flex flex-col overflow-hidden mobile-sheet-up shadow-[0_-8px_40px_rgba(0,0,0,0.15)]'
        : 'w-64 bg-panel/95 backdrop-blur-md border-r border-app flex flex-col shrink-0 z-[100] overflow-hidden shadow-[4px_0_24px_rgba(0,0,0,0.08)] min-h-0 h-full'
      } style={isMobile ? { maxHeight: '65vh' } : undefined}>
      <div className="p-4 pb-2 border-b border-app">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[10px] font-bold tracking-widest text-accent uppercase">
            <Shield size={14} aria-hidden="true" />
            Document Security
          </div>
          {onClose && (
            <button
              onClick={onClose}
              title="Hide sidebar panel"
              aria-label="Hide sidebar panel"
              className="text-app-muted hover:text-app p-1 rounded-lg hover:bg-panel-elevated transition-colors pointer-coarse:min-h-11 pointer-coarse:min-w-11"
            >
              <PanelLeftClose size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        {report && (
          <div className="mt-2 flex items-center justify-between text-xs">
            <span className="text-app-muted">Score</span>
            <span className={`font-semibold ${report.score >= 70 ? 'text-success' : report.score >= 40 ? 'text-warning' : 'text-danger'}`}>
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
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
            className={`flex-1 py-2.5 font-semibold uppercase tracking-wide transition-colors pointer-coarse:min-h-11 ${
              tab === id ? 'text-accent border-b-2 border-accent bg-panel-elevated' : 'text-app-muted hover:text-app'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div data-security-panel-scroll className="flex-1 overflow-y-auto p-4 space-y-3 text-xs">
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
              <div className={sectionLabel}>Recommendations</div>
              {report.recommendations.map((r) => (
                <div key={r} className="flex gap-2 text-app-muted leading-relaxed">
                  <AlertTriangle size={12} aria-hidden="true" className="shrink-0 mt-0.5 text-warning" />
                  <span>{r}</span>
                </div>
              ))}
            </div>

            <Button
              className="mt-2 w-full"
              disabled={busy}
              onClick={() => run(async () => {
                await engine.securityEngine.integrity.scan(doc);
                return 'Integrity scan complete';
              })}
            >
              <FileSearch size={14} aria-hidden="true" /> Rescan
            </Button>
          </>
        )}

        {tab === 'protect' && (
          <>
            <label htmlFor="security-protect-user-password" className={sectionLabel}>User password</label>
            <SecretInput
              id="security-protect-user-password"
              autoComplete="new-password"
              value={userPassword}
              onChange={(e) => setUserPassword(e.target.value)}
              placeholder="Optional open password"
            />
            <label htmlFor="security-protect-owner-password" className={sectionLabel}>Owner password</label>
            <SecretInput
              id="security-protect-owner-password"
              autoComplete="new-password"
              value={ownerPassword}
              onChange={(e) => setOwnerPassword(e.target.value)}
              placeholder="Required for permissions"
              required
            />
            <p className="text-app-faint leading-relaxed">An owner password is required. Without a user password, anyone can open the PDF.</p>
            <label htmlFor="security-protect-algorithm" className={sectionLabel}>Algorithm</label>
            <Select
              id="security-protect-algorithm"
              value={algorithm}
              onChange={(e) => setAlgorithm(e.target.value as typeof algorithm)}
            >
              <option value="AES-256">AES-256 (recommended)</option>
              <option value="AES-128">AES-128</option>
              <option value="RC4-128">RC4-128 (legacy)</option>
            </Select>

            <div className="space-y-2 pt-1">
              <Toggle label="Allow print" checked={allowPrint} onChange={setAllowPrint} />
              <Toggle label="Allow copy" checked={allowCopy} onChange={setAllowCopy} />
              <Toggle label="Allow modify" checked={allowModify} onChange={setAllowModify} />
            </div>

            <Button
              variant="danger"
              className="w-full"
              loading={busy}
              disabled={engine.securityEngine.isEncrypted(doc) || ownerPassword.length === 0}
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
            >
              {!busy && <Lock size={14} aria-hidden="true" />}
              Encrypt PDF
            </Button>

            {engine.securityEngine.isEncrypted(doc) && (
              <Button
                className="w-full"
                disabled={busy}
                onClick={() => run(async () => {
                  await engine.securityEngine.decrypt(doc, userPassword);
                  return 'Document decrypted (Encrypt dict removed)';
                })}
              >
                <Unlock size={14} aria-hidden="true" /> Remove encryption
              </Button>
            )}
          </>
        )}

        {tab === 'sanitize' && (
          <>
            {onRedact && (
              <div className="space-y-2 border-b border-app pb-3">
                <p className="font-semibold text-app">Secure redaction</p>
                <p className="text-app-faint leading-relaxed">
                  Select an area, the entire page, or find text to mark. Text under a mark is removed from the file; content that cannot be removed safely is refused and nothing changes.
                </p>
                <Button className="w-full" disabled={busy} onClick={() => { setRedactionStatus(null); setError(null); (selectingRedactionRegion ? onCancelRedactionRegion : onSelectRedactionRegion)?.(); }}>
                  {selectingRedactionRegion ? 'Cancel region selection' : 'Select redaction region'}
                </Button>
                {selectingRedactionRegion && <p role="status" className="text-app-faint">Drag across the page to select a region.</p>}
                {hasRedactionRegion && (
                  <Button variant="danger" className="w-full" disabled={busy} onClick={() => void runRedaction('region')}>
                    Apply selected region
                  </Button>
                )}
                <Button variant="danger" className="w-full" disabled={busy} onClick={() => void confirmRedaction('page')}>
                  Redact entire current page
                </Button>
                <Button variant="danger" className="w-full" disabled={busy} onClick={() => void confirmRedaction('marks')}>
                  Apply existing redaction marks
                </Button>
                {redactionStatus && redactionStatusVisible && (
                  <Notice tone="success" className="text-xs font-medium">{redactionStatus.message}</Notice>
                )}
                {redactionActionActive && error && (
                  <Notice tone="danger" className="text-xs font-medium">{error}</Notice>
                )}
                {onMarkPattern && (
                  <div className="space-y-2 rounded-md border border-app p-2">
                    <p className="font-semibold text-app">Find and mark</p>
                    <Field label="Find">
                      <Select value={presetId} onChange={event => { setPresetId(event.target.value as RedactionPresetId); setFindStatus(null); }}>
                        {REDACTION_PRESETS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                        <option value="custom">Custom pattern</option>
                      </Select>
                    </Field>
                    {presetId === 'custom' && (
                      <Field label="Pattern (regular expression)">
                        <TextInput value={customPattern} placeholder="INV-\d+" onChange={event => setCustomPattern(event.target.value)} />
                      </Field>
                    )}
                    <Button className="w-full" disabled={busy} onClick={async () => {
                      const preset = presetId === 'custom' ? customPreset(customPattern) : REDACTION_PRESETS.find(item => item.id === presetId)!;
                      if (typeof preset === 'string') { setFindStatus({ tone: 'danger', text: preset }); return; }
                      setBusy(true);
                      onBusyChange?.(true);
                      try {
                        setFindStatus({ tone: 'success', text: await onMarkPattern(preset) });
                      } catch (e) {
                        setFindStatus({ tone: 'danger', text: e instanceof Error ? e.message : String(e) });
                      } finally {
                        setBusy(false);
                        onBusyChange?.(false);
                      }
                    }}>
                      Mark matches
                    </Button>
                    {findStatus && <Notice tone={findStatus.tone} className="text-xs font-medium">{findStatus.text}</Notice>}
                  </div>
                )}
              </div>
            )}
            <p className="text-app-faint leading-relaxed">
              Remove metadata, JavaScript, attachments, and unused objects.
            </p>
            <Button
              variant="primary"
              className="w-full"
              disabled={busy}
              onClick={() => run(async () => {
                const r = await engine.securityEngine.sanitization.sanitize(doc);
                return `${r.report.join(' · ') || 'Cleanup prepared'}. Download a new copy to apply changes; the original file is unchanged.`;
              })}
            >
              <Eraser size={14} aria-hidden="true" /> Sanitize document
            </Button>
            <Button
              className="w-full"
              disabled={busy}
              onClick={() => run(async () => {
                const result = engine.securityEngine.javascript.removeJavaScript(doc);
                return `Removed ${result.removed} known JavaScript action link(s); other action types are unchanged. Download a new copy to apply changes; the original file is unchanged.`;
              })}
            >
              Remove JavaScript
            </Button>
            <Button
              className="w-full"
              disabled={busy}
              onClick={() => run(async () => {
                const n = engine.securityEngine.embeddedFiles.removeAllAttachments(doc);
                return `Removed ${n} attachment(s). Download a new copy to apply changes; the original file is unchanged.`;
              })}
            >
              Remove attachments
            </Button>
            <Button
              className="w-full"
              disabled={busy}
              onClick={() => run(async () => {
                engine.securityEngine.metadata.stripMetadata(doc);
                return 'Metadata cleanup prepared. Download a new copy to apply changes; the original file is unchanged.';
              })}
            >
              Strip metadata
            </Button>
            <Button
              className="w-full"
              disabled={busy}
              onClick={() => run(async () => {
                const r = await engine.securityEngine.optimizer.optimizeWithReport(doc);
                return r.notes.join(' · ');
              })}
            >
              <Sparkles size={14} aria-hidden="true" /> Optimize (keep security)
            </Button>
          </>
        )}

        {tab === 'policies' && (
          <>
            <label htmlFor="security-policy-name" className={sectionLabel}>Policy</label>
            <Select
              id="security-policy-name"
              value={policyName}
              onChange={(e) => setPolicyName(e.target.value)}
            >
              {policies.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </Select>
            <p className="text-app-faint leading-relaxed">
              {selectedPolicy?.description}
            </p>
            {selectedPolicy?.requireEncryption && (
              <>
                <label htmlFor="security-policy-user-password" className={sectionLabel}>User password{selectedPolicy.requireUserPassword ? ' (required)' : ' (optional)'}</label>
                <SecretInput id="security-policy-user-password" autoComplete="new-password" value={userPassword}
                  onChange={(e) => setUserPassword(e.target.value)} required={!!selectedPolicy.requireUserPassword} />
                <label htmlFor="security-policy-owner-password" className={sectionLabel}>Owner password (required)</label>
                <SecretInput id="security-policy-owner-password" autoComplete="new-password" value={ownerPassword}
                  onChange={(e) => setOwnerPassword(e.target.value)} required />
                {!selectedPolicy.requireUserPassword && <p className="text-app-faint leading-relaxed">Without a user password, anyone can open the PDF.</p>}
              </>
            )}
            <Button
              variant={selectedPolicy?.requireEncryption ? 'danger' : 'primary'}
              className="w-full"
              disabled={busy || !selectedPolicy || (!!selectedPolicy.requireEncryption &&
                (ownerPassword.length === 0 || (!!selectedPolicy.requireUserPassword && userPassword.length === 0)))}
              onClick={() => run(async () => {
                await engine.securityEngine.policy.applyPolicy(doc, policyName, {
                  userPassword,
                  ownerPassword,
                });
                return `Applied policy: ${policyName}`;
              })}
            >
              <ScrollText size={14} aria-hidden="true" /> Apply policy
            </Button>
          </>
        )}

        {message && <Notice tone="success" className="text-xs font-medium">{message}</Notice>}
        {error && !redactionActionActive && <Notice tone="danger" className="text-xs font-medium">{error}</Notice>}
      </div>
    </div>
    {confirmDialog}
    </>
  );
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-app-faint">{label}</span>
      <span className={`font-medium text-right ${warn ? 'text-warning' : 'text-app'}`}>{value}</span>
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
        className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-colors ${checked ? 'border-transparent bg-bloom-500' : 'border-app bg-panel-elevated'}`}
      >
        {/* The knob is --on-accent (white in both themes), like the jade fill it sits on. */}
        <span className={`inline-block h-4 w-4 transform rounded-full bg-on-accent shadow-sm transition-transform ${checked ? 'translate-x-[17px]' : 'translate-x-0.5'}`} />
      </button>
    </label>
  );
}
