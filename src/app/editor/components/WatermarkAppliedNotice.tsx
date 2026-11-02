'use client';

import { useEffect } from 'react';
import { X } from 'lucide-react';

/**
 * Non-blocking confirmation after a watermark is applied. Applying turns live
 * preview off (so the applied mark is not drawn twice); say so and offer to
 * turn it back on. Z_LAYERS.toast (700).
 */
export function WatermarkAppliedNotice({ open, onDismiss, onTurnOnPreview }: {
  open: boolean;
  onDismiss: () => void;
  onTurnOnPreview: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onDismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onDismiss]);

  if (!open) return null;
  return (
    <div role="status" aria-live="polite" className="fixed bottom-20 md:bottom-10 left-1/2 z-[700] flex w-max max-w-[90vw] -translate-x-1/2 items-start gap-3 rounded-xl border border-app bg-panel px-4 py-3 text-sm text-app shadow-xl">
      <div className="space-y-2">
        <p><strong className="font-semibold">Watermark applied.</strong> Live preview is now off so the watermark is not shown twice.</p>
        <button
          type="button"
          onClick={() => { onTurnOnPreview(); onDismiss(); }}
          className="min-h-9 pointer-coarse:min-h-11 rounded-lg border border-accent/40 bg-bloom-100 px-3 text-xs font-semibold text-accent hover:opacity-90"
        >
          Turn live preview back on
        </button>
      </div>
      <button type="button" onClick={onDismiss} aria-label="Dismiss watermark notice" className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded text-app-muted hover:text-app hover:bg-panel-elevated">
        <X size={16} />
      </button>
    </div>
  );
}
