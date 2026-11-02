'use client';

// Named `Sheet` (not `Dialog`) on purpose: zLayers.guard.test.ts then checks
// these nodes against the drawer tiers instead of the modal tiers.
import * as Sheet from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { Z_LAYERS } from '../zLayers';
import { cx } from './cx';
import { useReturnFocus } from './useReturnFocus';

type ContentProps = Omit<ComponentPropsWithoutRef<typeof Sheet.Content>, 'title' | 'children' | 'asChild' | 'forceMount'>;

export interface MobileSheetProps extends ContentProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name, shown in the sheet header. */
  title: ReactNode;
  description?: ReactNode;
  /** Accessible name of the 44px close button. */
  closeLabel?: string;
  children?: ReactNode;
}

/**
 * Bottom sheet portalled to document.body: --backdrop at Z_LAYERS.drawerBackdrop,
 * panel at Z_LAYERS.drawer, role=dialog with aria-modal, focus trap, Escape and
 * backdrop click close, safe-area bottom padding and a scrolling body.
 */
export function MobileSheet({
  open,
  onOpenChange,
  title,
  description,
  closeLabel = 'Close',
  className,
  children,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...rest
}: MobileSheetProps) {
  const focus = useReturnFocus(onOpenAutoFocus, onCloseAutoFocus);
  return (
    <Sheet.Root open={open} onOpenChange={onOpenChange}>
      <Sheet.Portal>
        <Sheet.Overlay
          data-ui="sheet-backdrop"
          style={{ zIndex: Z_LAYERS.drawerBackdrop }}
          className="mobile-backdrop fixed inset-0"
        />
        <Sheet.Content
          // Without a description, opt out of Radix's describedby wiring explicitly.
          {...(description ? {} : { 'aria-describedby': undefined })}
          aria-modal="true"
          {...rest}
          style={{ zIndex: Z_LAYERS.drawer, ...rest.style }}
          onOpenAutoFocus={focus.onOpenAutoFocus}
          onCloseAutoFocus={focus.onCloseAutoFocus}
          className={cx(
            'mobile-sheet-up fixed inset-x-0 bottom-0 flex max-h-[85dvh] flex-col rounded-t-2xl border-t border-app bg-panel pb-[env(safe-area-inset-bottom)] text-app shadow-2xl focus:outline-none',
            className,
          )}
        >
          <div aria-hidden="true" className="sheet-handle" />
          <div className="flex items-center justify-between gap-2 border-b border-app pl-4 pr-1">
            <div className="min-w-0 py-2">
              <Sheet.Title className="truncate text-sm font-semibold text-app">{title}</Sheet.Title>
              {description && <Sheet.Description className="text-xs text-app-muted">{description}</Sheet.Description>}
            </div>
            <Sheet.Close
              aria-label={closeLabel}
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-app-muted hover:bg-panel-elevated hover:text-app"
            >
              <X aria-hidden="true" className="size-5" />
            </Sheet.Close>
          </div>
          <div data-ui="sheet-body" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {children}
          </div>
        </Sheet.Content>
      </Sheet.Portal>
    </Sheet.Root>
  );
}
