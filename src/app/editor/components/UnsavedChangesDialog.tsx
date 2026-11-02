'use client';

import { Button, Dialog, DialogFooter, Notice } from '../ui';

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
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => { if (!nextOpen) onCancel(); }}
      dismissible={!busy}
      aria-busy={busy}
      title="Unsaved changes"
      description="Download your document before closing, or discard your changes. Your browser starts the download; the app cannot confirm that it finishes."
    >
      {error && <Notice tone="danger" className="mt-3">{error}</Notice>}
      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Keep editing
        </Button>
        <Button variant="danger" disabled={busy} onClick={onDiscard}>
          Discard changes
        </Button>
        <Button variant="primary" loading={busy} onClick={onSave}>
          {busy ? 'Working…' : 'Download and close'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
