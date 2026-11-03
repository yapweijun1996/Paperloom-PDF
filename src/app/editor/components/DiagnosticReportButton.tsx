'use client';

import React, { useState } from 'react';
import { ClipboardCopy } from 'lucide-react';

interface DiagnosticReportButtonProps {
  getReport: () => string;
  className?: string;
}

/** Copies a shareable diagnostic report; nothing leaves the device unless the user pastes it. */
export function DiagnosticReportButton({ getReport, className = '' }: DiagnosticReportButtonProps) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(getReport());
          setStatus('copied');
        } catch {
          setStatus('failed');
        }
      }}
      title="Copy a report about this error, the browser and the PDF's structure (no file name or content) to paste into an issue"
      className={`inline-flex shrink-0 items-center gap-1 rounded text-xs underline-offset-2 opacity-80 transition-opacity hover:underline hover:opacity-100 ${className}`}
    >
      <ClipboardCopy size={13} aria-hidden="true" />
      {status === 'copied' ? 'Report copied' : status === 'failed' ? 'Copy failed' : 'Copy report'}
    </button>
  );
}
