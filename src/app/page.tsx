'use client';

import { useCallback, useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import {
  clearOrphanRecovery,
  clearPdfFromStorage,
  inspectOrphanRecovery,
  loadEditorSession,
  loadPdfFromStorage,
  restoreOrphanRecovery,
  savePdfToStorage,
  type EditorSessionRecord,
} from '@/lib/pdfStorage';
import { isPdfFile } from '@/app/pdf-file-validation';
import { FileUp, Loader2, Sparkles } from 'lucide-react';
import { BRAND_BASE_PATH, BRAND_NAME } from '@/lib/brand';

export default function Home() {
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [savedDocument, setSavedDocument] = useState<{ fileName: string; hasRecovery: boolean } | null>(null);
  const [orphanRecovery, setOrphanRecovery] = useState<EditorSessionRecord | null>(null);
  const operationRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await loadPdfFromStorage();
        const session = stored ? await loadEditorSession() : null;
        const orphan = stored ? null : await inspectOrphanRecovery();
        if (cancelled) return;
        setSavedDocument(stored ? { fileName: session?.fileName || stored.fileName, hasRecovery: !!session } : null);
        setOrphanRecovery(orphan);
        setStorageReady(true);
      } catch (e) {
        if (cancelled) return;
        setError(`Could not check local documents: ${e instanceof Error ? e.message : 'Unknown error'}`);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleFile = useCallback(async (file: File) => {
    if (!storageReady || operationRef.current) return;
    if (orphanRecovery) {
      setError('A recovery record without its original document is still stored. Resolve it before opening another PDF.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    operationRef.current = true;
    try {
      const buffer = await file.arrayBuffer();
      if (!isPdfFile(file.name, file.type, new Uint8Array(buffer))) {
        setError('Please select a valid PDF document.');
        return;
      }
      setIsLoading(true);
      setError(null);
      await savePdfToStorage(buffer, file.name);
      router.push('/editor');
    } catch (e) {
      if (e instanceof Error && e.name === 'RecoveryExistsError') {
        setError('A saved local document or recovery exists. Resume and download it, or discard it before opening another PDF.');
        try {
          const stored = await loadPdfFromStorage();
          const session = stored ? await loadEditorSession() : null;
          const orphan = stored ? null : await inspectOrphanRecovery();
          setSavedDocument(stored ? { fileName: session?.fileName || stored.fileName, hasRecovery: !!session } : null);
          setOrphanRecovery(orphan);
          if (orphan) setError('A recovery record without its original document is still stored. Resolve it before opening another PDF.');
        } catch {
          setError('Saved recovery changes may exist, but could not be read. Reload this page before opening another PDF.');
          setStorageReady(false);
        }
      } else {
        setError(`Failed to load file: ${e instanceof Error ? e.message : 'Unknown error'}`);
      }
      setIsLoading(false);
    } finally {
      operationRef.current = false;
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [orphanRecovery, router, storageReady]);

  const handleDiscardSaved = useCallback(async () => {
    if (!storageReady || !savedDocument || operationRef.current) return;
    if (!window.confirm('Discard the saved local document and any recovery changes? This cannot be undone.')) return;
    operationRef.current = true;
    setIsLoading(true);
    setError(null);
    try {
      await clearPdfFromStorage();
      setSavedDocument(null);
    } catch (e) {
      setError(`Could not discard the saved document: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      operationRef.current = false;
      setIsLoading(false);
    }
  }, [savedDocument, storageReady]);

  const handleDiscardOrphan = useCallback(async () => {
    if (!storageReady || !orphanRecovery || operationRef.current) return;
    if (!window.confirm('Permanently discard this recovery record? Its changes may be lost and cannot be restored.')) return;
    operationRef.current = true;
    setIsLoading(true);
    setError(null);
    try {
      await clearOrphanRecovery(orphanRecovery);
      setOrphanRecovery(null);
    } catch (e) {
      setError(`Could not discard the recovery record: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      operationRef.current = false;
      setIsLoading(false);
    }
  }, [orphanRecovery, storageReady]);

  const handleResumeOrphan = useCallback(async () => {
    if (!storageReady || !orphanRecovery || operationRef.current) return;
    operationRef.current = true;
    setIsLoading(true);
    setError(null);
    try {
      await restoreOrphanRecovery(orphanRecovery);
      router.push('/editor');
    } catch (e) {
      setError(`Could not resume the recovery: ${e instanceof Error ? e.message : 'Unknown error'}`);
      setIsLoading(false);
    } finally {
      operationRef.current = false;
    }
  }, [orphanRecovery, router, storageReady]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const onFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center py-10 px-5 font-sans bg-surface text-app relative overflow-hidden">
      {/* Subtle Paperloom ambient glow */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-accent/10 blur-[120px] rounded-full pointer-events-none" />

      <div className="flex flex-col items-center mb-8 z-10">
        <div className="flex items-center gap-3 mb-3">
          <Image
            src={`${BRAND_BASE_PATH}/brand/paperloom-mark.svg`}
            alt={BRAND_NAME}
            width={48}
            height={48}
            className="w-12 h-12 object-contain"
            priority
          />
          <h1 className="text-4xl font-extrabold tracking-tight text-app">
            {BRAND_NAME}
          </h1>
        </div>
        <div className="inline-flex items-center gap-1.5 px-3.5 py-1 rounded-full bg-bloom-100 border border-accent/20 text-accent text-xs font-semibold tracking-wide">
          <Sparkles size={13} />
          PDF Editor — Pure TypeScript Engine
        </div>
      </div>

      {/* Drop zone */}
      <div
        role="button"
        tabIndex={storageReady && !isLoading ? 0 : -1}
        aria-label="Open a PDF file"
        aria-disabled={!storageReady || isLoading}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onClick={() => { if (storageReady && !isLoading) fileInputRef.current?.click(); }}
        onKeyDown={(event) => {
          if ((event.key === 'Enter' || event.key === ' ') && storageReady && !isLoading) {
            event.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        className={`w-full max-w-lg min-h-[260px] rounded-3xl flex flex-col items-center justify-center cursor-pointer transition-all duration-300 p-8 border-2 border-dashed relative z-10 backdrop-blur-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent ${
          isDragging 
            ? 'border-accent bg-bloom-100 scale-[1.02] shadow-xl shadow-accent/25'
            : 'border-app-strong bg-panel/70 hover:bg-panel-elevated hover:border-accent/50 hover:shadow-xl hover:shadow-accent/5'
        }`}
      >
        {isLoading ? (
          <>
            <Loader2 size={48} className="animate-spin text-accent mb-4" />
            <p className="text-sm font-medium text-app-muted animate-pulse">Loading PDF Document...</p>
          </>
        ) : (
          <>
            <div className={`p-4 rounded-2xl mb-4 transition-colors duration-300 ${isDragging ? 'bg-bloom-100 text-accent' : 'bg-panel-elevated text-accent'}`}>
              <FileUp size={40} />
            </div>
            <p className="text-base font-semibold text-app mb-1">
              Drop a PDF here or click to browse
            </p>
            <p className="text-xs text-app-faint font-medium">
              100% Client-Side Engine &bull; Private &bull; Fast
            </p>
          </>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,application/pdf"
        onChange={onFileSelect}
        className="hidden"
      />

      {savedDocument && (
        <section aria-label="Saved local document" className="mt-5 w-full max-w-lg rounded-2xl border border-app bg-panel p-4 z-10">
          <p className="text-sm font-semibold text-app">{savedDocument.fileName}</p>
          <p className="mt-1 text-xs text-app-muted">
            {savedDocument.hasRecovery ? 'Recovery changes are available on this device.' : 'A saved document is available on this device.'}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" disabled={!storageReady || isLoading} onClick={() => router.push('/editor')} className="rounded-xl bg-bloom-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
              Resume saved document
            </button>
            <button type="button" disabled={!storageReady || isLoading} onClick={() => void handleDiscardSaved()} className="rounded-xl border border-app px-3 py-2 text-sm text-app-muted hover:bg-panel-elevated disabled:opacity-50">
              Discard saved document
            </button>
          </div>
        </section>
      )}

      {orphanRecovery && !savedDocument && (
        <section aria-label="Recovery record without its document" className="mt-5 w-full max-w-lg rounded-2xl border border-app bg-panel p-4 z-10">
          <p className="text-sm font-semibold text-app">Recovery record{orphanRecovery.fileName ? `: ${orphanRecovery.fileName}` : ''}</p>
          <p className="mt-1 text-xs text-app-muted">
            Its original document record is missing. You can restore the saved recovery, or discard it if you no longer need those changes.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" disabled={!storageReady || isLoading} onClick={() => void handleResumeOrphan()} className="rounded-xl bg-bloom-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
              Resume recovery
            </button>
            <button type="button" disabled={!storageReady || isLoading} onClick={() => void handleDiscardOrphan()} className="rounded-xl border border-app px-3 py-2 text-sm text-app-muted hover:bg-panel-elevated disabled:opacity-50">
              Discard orphaned recovery
            </button>
          </div>
        </section>
      )}

      {error && (
        <p role="alert" className="text-red-400 bg-red-400/10 border border-red-400/20 px-4 py-2.5 rounded-xl text-sm mt-6 max-w-lg text-center font-medium animate-in slide-in-from-bottom-2 fade-in z-10">
          {error}
        </p>
      )}
    </div>
  );
}
