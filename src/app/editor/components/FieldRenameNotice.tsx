'use client';

import { X } from 'lucide-react';
import { Notice } from '../ui';

/** Surface name changes so users can update any external field references. */
export function FieldRenameNotice({ changes, onDismiss }: {
  changes: Array<{ from: string; to: string }>;
  onDismiss: () => void;
}) {
  if (!changes.length) return null;
  // Z_LAYERS.toast (700).
  return (
    <Notice tone="warning" aria-live="polite" className="fixed bottom-10 left-1/2 z-[700] max-h-48 w-max max-w-[90vw] -translate-x-1/2 overflow-y-auto shadow-xl">
      <div className="flex gap-4">
        <div>
          <p>Imported form fields were renamed to keep both sets of values:</p>
          <ul className="mt-1 list-inside list-disc break-all">
            {changes.map(({ from, to }) => <li key={`${from}\u0000${to}`}>{from} → {to}</li>)}
          </ul>
        </div>
        <button type="button" onClick={onDismiss} aria-label="Dismiss field name changes" className="flex min-h-11 min-w-11 shrink-0 items-center justify-center self-start rounded opacity-80 hover:opacity-100">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </Notice>
  );
}
