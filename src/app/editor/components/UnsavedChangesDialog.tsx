'use client';

import * as Dialog from '@radix-ui/react-dialog';

interface UnsavedChangesDialogProps {
  open: boolean;
  busy: boolean;
  error?: string | null;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
}

export function UnsavedChangesDialog({
  open,
  busy,
  error,
  onCancel,
  onDiscard,
  onSave,
}: UnsavedChangesDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen && !busy) onCancel();
    }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[500] bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          aria-busy={busy}
          onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
          onPointerDownOutside={(event) => { if (busy) event.preventDefault(); }}
          className="fixed left-1/2 top-1/2 z-[600] w-[min(440px,94vw)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-app bg-panel p-6 text-app shadow-2xl focus:outline-none"
        >
          <Dialog.Title className="text-base font-semibold">Unsaved changes</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-app-muted">
            Download your document before closing, or discard your changes. Your browser starts
            the download; the app cannot confirm that it finishes.
          </Dialog.Description>
          {error && <p role="alert" className="mt-3 text-sm text-red-500">{error}</p>}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onCancel}
              className="rounded-xl px-3 py-2 text-sm text-app-muted hover:bg-panel-elevated disabled:opacity-50"
            >
              Keep editing
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onDiscard}
              className="rounded-xl border border-app px-3 py-2 text-sm text-red-500 hover:bg-panel-elevated disabled:opacity-50"
            >
              Discard changes
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onSave}
              className="rounded-xl bg-bloom-500 px-3 py-2 text-sm font-semibold text-white hover:bg-bloom-600 disabled:opacity-50"
            >
              {busy ? 'Working…' : 'Download and close'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
