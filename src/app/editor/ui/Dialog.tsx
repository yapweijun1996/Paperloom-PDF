'use client';

// Keep the namespace named `Dialog`: zLayers.guard.test.ts recognises
// `Dialog.Overlay` / `Dialog.Content` as modal tiers. The exported component is
// defined under another local name and re-exported as `Dialog`.
import * as Dialog from '@radix-ui/react-dialog';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { Z_LAYERS } from '../zLayers';
import { Button } from './Button';
import { cx } from './cx';
import { useReturnFocus } from './useReturnFocus';

export type DialogSize = 'sm' | 'md' | 'lg';

const SIZE_CLASSES: Record<DialogSize, string> = {
  sm: 'w-[min(384px,calc(100vw-2rem))]',
  md: 'w-[min(440px,calc(100vw-2rem))]',
  lg: 'w-[min(560px,calc(100vw-2rem))]',
};

type ContentProps = Omit<ComponentPropsWithoutRef<typeof Dialog.Content>, 'title' | 'children' | 'asChild' | 'forceMount'>;

export interface DialogProps extends ContentProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name (Radix Title). */
  title: ReactNode;
  /** Accessible description (Radix Description). */
  description: ReactNode;
  /** Optional decoration shown beside the title. */
  icon?: ReactNode;
  /** When false, Escape and outside clicks do nothing (required choices, busy states). Default true. */
  dismissible?: boolean;
  size?: DialogSize;
  children?: ReactNode;
}

/**
 * Modal dialog on Radix: focus trap, focus return, Escape and outside-click
 * dismissal (unless `dismissible` is false), --scrim overlay at
 * Z_LAYERS.modalBackdrop and content at Z_LAYERS.modal. Content mounts only while open.
 */
function ModalDialog({
  open,
  onOpenChange,
  title,
  description,
  icon,
  dismissible = true,
  size = 'md',
  className,
  children,
  onEscapeKeyDown,
  onPointerDownOutside,
  onInteractOutside,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...rest
}: DialogProps) {
  const focus = useReturnFocus(onOpenAutoFocus, onCloseAutoFocus);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (next || dismissible) onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          data-ui="dialog-overlay"
          style={{ zIndex: Z_LAYERS.modalBackdrop }}
          className="fixed inset-0 bg-scrim backdrop-blur-sm"
        />
        <Dialog.Content
          aria-modal="true"
          {...rest}
          style={{ zIndex: Z_LAYERS.modal, ...rest.style }}
          onOpenAutoFocus={focus.onOpenAutoFocus}
          onCloseAutoFocus={focus.onCloseAutoFocus}
          onEscapeKeyDown={(event) => {
            if (!dismissible) event.preventDefault();
            onEscapeKeyDown?.(event);
          }}
          onPointerDownOutside={(event) => {
            if (!dismissible) event.preventDefault();
            onPointerDownOutside?.(event);
          }}
          onInteractOutside={(event) => {
            if (!dismissible) event.preventDefault();
            onInteractOutside?.(event);
          }}
          className={cx(
            'fixed left-1/2 top-1/2 max-h-[calc(100dvh-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-app bg-panel p-6 text-app shadow-2xl focus:outline-none',
            SIZE_CLASSES[size],
            className,
          )}
        >
          <div className="flex items-start gap-3">
            {icon && <div aria-hidden="true" className="shrink-0 rounded-xl bg-bloom-100 p-2.5 text-accent">{icon}</div>}
            <div className="min-w-0">
              <Dialog.Title className="text-base font-semibold text-app">{title}</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-app-muted">{description}</Dialog.Description>
            </div>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export { ModalDialog as Dialog };

/** Right-aligned action row for the bottom of a Dialog (place inside a form when submitting). */
export function DialogFooter({ className, ...rest }: ComponentPropsWithoutRef<'div'>) {
  return <div {...rest} className={cx('mt-5 flex flex-wrap justify-end gap-2', className)} />;
}

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  message: ReactNode;
  onConfirm: () => void;
  /** Called for the cancel button, Escape and outside clicks. */
  onCancel: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'default';
  /** Shows a spinner on confirm, disables both actions and blocks dismissal. */
  busy?: boolean;
  children?: ReactNode;
}

/** Two-choice confirmation. Cancel comes first in the DOM, so it receives initial focus. */
export function ConfirmDialog({
  open,
  title,
  message,
  onConfirm,
  onCancel,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  busy = false,
  children,
}: ConfirmDialogProps) {
  return (
    <ModalDialog
      open={open}
      onOpenChange={(next) => { if (!next) onCancel(); }}
      title={title}
      description={message}
      dismissible={!busy}
      aria-busy={busy || undefined}
      size="sm"
      data-tone={tone}
    >
      {children}
      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>{cancelLabel}</Button>
        <Button variant={tone === 'danger' ? 'danger' : 'primary'} loading={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </ModalDialog>
  );
}
