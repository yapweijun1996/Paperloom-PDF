'use client';

import React, { useState, useCallback } from 'react';
import {
  X,
  Image as ImageIcon,
  Camera,
  FileCode,
  AlignLeft,
  Download,
  ChevronRight,
  Check,
  Loader2,
} from 'lucide-react';
import { Button, Dialog, Field, MobileSheet, Notice, NumberInput } from '../ui';
import type { PDFDocumentData } from '@/engine/browser-core';
import {
  EXPORT_FORMATS,
  exportDocument,
  type ExportFormat,
  type ExportOptions,
} from '../export-formats';

// ─── Icon mapping ───────────────────────────────────────────────────────────────

const FORMAT_ICONS: Record<ExportFormat, React.ReactNode> = {
  png: <ImageIcon size={22} />,
  jpeg: <Camera size={22} />,
  svg: <FileCode size={22} />,
  txt: <AlignLeft size={22} />,
};

// ─── Props ──────────────────────────────────────────────────────────────────────

interface ExportPanelProps {
  isOpen: boolean;
  onClose: () => void;
  doc: PDFDocumentData | null;
  engine: typeof import('@/engine/browser-core') | null;
  fileName: string;
  totalPages: number;
  currentPage: number;
  /** Phones get a bottom sheet; larger screens a centred dialog. */
  isMobile?: boolean;
}

// ─── Component ──────────────────────────────────────────────────────────────────

export function ExportPanel({
  isOpen,
  onClose,
  doc,
  engine,
  fileName,
  totalPages,
  currentPage,
  isMobile = false,
}: ExportPanelProps) {
  const [selectedFormat, setSelectedFormat] = useState<ExportFormat>('png');
  const [pageRange, setPageRange] = useState<'all' | 'current' | 'custom'>('all');
  const [customFrom, setCustomFrom] = useState('1');
  const [customTo, setCustomTo] = useState(String(totalPages));
  const [dpi, setDpi] = useState(150);
  const [jpegQuality, setJpegQuality] = useState(92);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportTotal, setExportTotal] = useState(0);
  const [exportDone, setExportDone] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  // Reset transient results on open or page-count change while retaining format choices.
  const [previousPanel, setPreviousPanel] = useState({ isOpen: false, totalPages });
  if (previousPanel.isOpen !== isOpen || previousPanel.totalPages !== totalPages) {
    setPreviousPanel({ isOpen, totalPages });
    if (isOpen) {
      setExportDone(false);
      setExportError(null);
      setExportProgress(0);
      setCustomTo(String(totalPages));
    }
  }
  const formatInfo = EXPORT_FORMATS.find((f) => f.id === selectedFormat)!;

  const getPageIndices = useCallback((): number[] | null => {
    if (pageRange === 'all') return null;
    if (pageRange === 'current') return [currentPage];
    const fromPage = Number(customFrom);
    const toPage = Number(customTo);
    if (!/^\d+$/.test(customFrom) || !/^\d+$/.test(customTo) ||
        !Number.isSafeInteger(fromPage) || !Number.isSafeInteger(toPage) ||
        fromPage < 1 || toPage > totalPages || fromPage > toPage) {
      throw new Error(`Enter a valid page range from 1 to ${totalPages}, with From no greater than To.`);
    }
    const from = fromPage - 1;
    const to = toPage - 1;
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }, [pageRange, currentPage, customFrom, customTo, totalPages]);

  const triggerDownload = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  const handleRenderExport = useCallback(async () => {
    if (!doc || !engine) return;

    let pages: number[] | null;
    try {
      pages = getPageIndices();
    } catch (err) {
      setExportDone(false);
      setExportError(err instanceof Error ? err.message : String(err));
      return;
    }

    setIsExporting(true);
    setExportDone(false);
    setExportError(null);
    setExportProgress(0);

    try {
      const title = fileName.replace(/\.pdf$/i, '') || 'export';
      const options: ExportOptions = {
        format: selectedFormat,
        pages,
        dpi,
        quality: jpegQuality / 100,
        title,
      };

      const result = await exportDocument(doc, engine, options, (current, total) => {
        setExportProgress(current);
        setExportTotal(total);
      });

      triggerDownload(result.blob, result.filename);
      setExportDone(true);
    } catch (err) {
      console.error('[Export] Failed:', err);
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsExporting(false);
    }
  }, [doc, engine, fileName, selectedFormat, getPageIndices, dpi, jpegQuality, triggerDownload]);

  const progressPct = exportTotal > 0 ? Math.round((exportProgress / exportTotal) * 100) : 0;
  const primaryDisabled = !doc || !engine || isExporting;
  const title = 'Export Document';
  const description = `${fileName} · ${totalPages} page${totalPages !== 1 ? 's' : ''}`;
  const onOpenChange = (open: boolean) => { if (!open) onClose(); };

  const content = (
    <>
      <div className="space-y-6 py-5">
        <div>
          <p className="mb-3 text-xs font-medium uppercase tracking-widest text-app-muted">Render format</p>
          <div className="grid grid-cols-2 gap-2">
            {EXPORT_FORMATS.map((fmt) => {
              const selected = selectedFormat === fmt.id;
              return (
                <button
                  key={fmt.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setSelectedFormat(fmt.id)}
                  className={`group relative flex items-center gap-3 rounded-xl border py-3.5 pl-3 pr-7 text-left transition-colors sm:pl-4 ${
                    selected
                      ? 'border-accent bg-panel-elevated ring-2 ring-accent'
                      : 'border-app bg-panel-elevated hover:border-app-strong'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`flex size-10 shrink-0 items-center justify-center rounded-lg bg-panel ${
                      selected ? 'text-accent' : 'text-app-muted group-hover:text-app'
                    }`}
                  >
                    {FORMAT_ICONS[fmt.id]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-sm font-medium ${selected ? 'text-app' : 'text-app-muted'}`}>{fmt.label}</span>
                    <span className="mt-0.5 block truncate text-[10px] leading-snug text-app-faint">{fmt.extension}</span>
                  </span>
                  {selected && (
                    <span aria-hidden="true" className="absolute right-2 top-2 flex size-5 items-center justify-center rounded-full bg-bloom-100 text-accent">
                      <Check size={12} strokeWidth={3} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <p className="mt-3 text-xs leading-relaxed text-app-muted">{formatInfo.description}</p>
        </div>

        <div>
          <p className="mb-3 text-xs font-medium uppercase tracking-widest text-app-muted">Pages</p>
          <div className="flex gap-1.5 rounded-xl border border-app bg-panel-elevated p-1">
            {[
              { value: 'all' as const, label: 'All Pages' },
              { value: 'current' as const, label: `Page ${currentPage + 1}` },
              { value: 'custom' as const, label: 'Range' },
            ].map((opt) => (
              <button
                key={opt.value}
                type="button"
                aria-pressed={pageRange === opt.value}
                onClick={() => setPageRange(opt.value)}
                className={`flex-1 rounded-lg px-3 py-2 text-xs font-medium transition-colors pointer-coarse:min-h-11 ${
                  pageRange === opt.value ? 'bg-panel text-app shadow-sm' : 'text-app-muted hover:text-app'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {pageRange === 'custom' && (
            <div className="mt-3 flex items-end gap-3">
              <Field label="From" id="export-page-from" className="flex-1">
                <NumberInput min={1} max={totalPages} inputMode="numeric" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
              </Field>
              <span className="pb-2.5 text-xs text-app-faint">to</span>
              <Field label="To" id="export-page-to" className="flex-1">
                <NumberInput min={1} max={totalPages} inputMode="numeric" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
              </Field>
            </div>
          )}
        </div>

        {(formatInfo.supportsDpi || formatInfo.supportsQuality) && (
          <div className="space-y-4">
            <p className="text-xs font-medium uppercase tracking-widest text-app-muted">Quality Settings</p>

            {formatInfo.supportsDpi && (
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs text-app-muted">Resolution (DPI)</span>
                  <span className="rounded bg-panel-elevated px-2 py-0.5 font-mono text-xs text-app">{dpi}</span>
                </div>
                <div className="flex gap-1.5 rounded-xl border border-app bg-panel-elevated p-1">
                  {[
                    { value: 72, label: 'Screen' },
                    { value: 150, label: 'Standard' },
                    { value: 300, label: 'Print' },
                    { value: 600, label: 'High' },
                  ].map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      aria-pressed={dpi === opt.value}
                      onClick={() => setDpi(opt.value)}
                      className={`flex-1 rounded-lg px-2 py-2 text-xs font-medium transition-colors ${
                        dpi === opt.value ? 'bg-panel text-app shadow-sm' : 'text-app-muted hover:text-app'
                      }`}
                    >
                      <span className="block">{opt.label}</span>
                      <span className="mt-0.5 block text-[9px] opacity-60">{opt.value} DPI</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {formatInfo.supportsQuality && (
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <label htmlFor="export-jpeg-quality" className="text-xs text-app-muted">JPEG Quality</label>
                  <span className="rounded bg-panel-elevated px-2 py-0.5 font-mono text-xs text-app">{jpegQuality}%</span>
                </div>
                <input
                  id="export-jpeg-quality"
                  type="range"
                  min={10}
                  max={100}
                  value={jpegQuality}
                  onChange={(e) => setJpegQuality(Number(e.target.value))}
                  className="w-full accent-accent"
                  style={{ height: '4px' }}
                />
                <div className="mt-1 flex justify-between">
                  <span className="text-[10px] text-app-faint">Smaller file</span>
                  <span className="text-[10px] text-app-faint">Best quality</span>
                </div>
              </div>
            )}
          </div>
        )}

        {exportError && <Notice tone="danger" className="text-xs">{exportError}</Notice>}
        {exportDone && <Notice tone="success" className="text-xs">Export complete — file downloaded!</Notice>}
      </div>

      <div className="border-t border-app pt-4">
        {isExporting ? (
          <div className="space-y-3" role="status">
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 text-app-muted">
                <Loader2 size={12} aria-hidden="true" className="animate-spin" />
                Exporting…
              </span>
              <span className="font-mono text-app">{exportProgress}/{exportTotal}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-panel-elevated">
              <div className="h-full rounded-full bg-bloom-500 transition-all duration-300 ease-out" style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        ) : (
          <Button variant="primary" className="h-11 w-full" onClick={() => void handleRenderExport()} disabled={primaryDisabled}>
            <Download size={16} aria-hidden="true" />
            {`Export as ${formatInfo.label}`}
            <ChevronRight size={14} aria-hidden="true" className="opacity-60" />
          </Button>
        )}
      </div>
    </>
  );

  if (isMobile) {
    return (
      <MobileSheet open={isOpen} onOpenChange={onOpenChange} title={title} description={description} closeLabel="Close export panel">
        <div className="px-4 pb-4">{content}</div>
      </MobileSheet>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange} title={title} description={description} size="lg">
      <Button variant="ghost" size="sm" aria-label="Close export panel" className="absolute right-3 top-3 w-8 px-0" onClick={onClose}>
        <X size={18} aria-hidden="true" className="shrink-0" />
      </Button>
      {content}
    </Dialog>
  );
}
