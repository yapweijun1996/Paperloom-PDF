'use client';

import { useState, useCallback, FormEvent } from 'react';
import { Lock } from 'lucide-react';
import { Button, Dialog, DialogFooter, Field, SecretInput } from '../ui';

interface PasswordDialogProps {
  fileName?: string;
  error?: string | null;
  isVerifying?: boolean;
  onSubmit: (password: string) => void;
  onCancel?: () => void;
}

/**
 * Prompt for PDF open password (Security Engine Phase 3 UI).
 * Without onCancel, or while verifying, the dialog cannot be dismissed.
 */
export function PasswordDialog({
  fileName,
  error,
  isVerifying,
  onSubmit,
  onCancel,
}: PasswordDialogProps) {
  const [password, setPassword] = useState('');

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      onSubmit(password);
    },
    [onSubmit, password],
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onCancel?.(); }}
      dismissible={Boolean(onCancel) && !isVerifying}
      aria-busy={isVerifying || undefined}
      size="sm"
      icon={<Lock size={20} />}
      title="Password required"
      description={fileName ? `"${fileName}" is encrypted` : 'This PDF is encrypted'}
    >
      <form onSubmit={handleSubmit} className="mt-4">
        <Field id="pdf-password" label="Document password" error={error || undefined}>
          <SecretInput
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter password"
            disabled={isVerifying}
          />
        </Field>
        <DialogFooter>
          {onCancel && (
            <Button variant="ghost" onClick={onCancel} disabled={isVerifying}>
              Cancel
            </Button>
          )}
          <Button type="submit" variant="primary" loading={isVerifying}>
            Unlock
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
