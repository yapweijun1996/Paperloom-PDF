'use client';

import { X } from 'lucide-react';

/** Surface name changes so users can update any external field references. */
export function FieldRenameNotice({ changes, onDismiss }: {
  changes: Array<{ from: string; to: string }>;
  onDismiss: () => void;
}) {
  if (!changes.length) return null;
  return (
    <div role="status" aria-live="polite" className="fixed bottom-10 left-1/2 z-[700] flex max-h-48 w-max max-w-[90vw] -translate-x-1/2 gap-4 overflow-y-auto rounded-xl border border-amber-500/40 bg-zinc-900 px-4 py-3 text-sm text-amber-200 shadow-xl">
      <div>
        <p>Imported form fields were renamed to keep both sets of values:</p>
        <ul className="mt-1 list-inside list-disc break-all">
          {changes.map(({ from, to }) => <li key={`${from}\u0000${to}`}>{from} → {to}</li>)}
        </ul>
      </div>
      <button type="button" onClick={onDismiss} aria-label="Dismiss field name changes" className="flex min-h-11 min-w-11 shrink-0 items-center justify-center self-start rounded hover:bg-white/10"><X size={16} /></button>
    </div>
  );
}
