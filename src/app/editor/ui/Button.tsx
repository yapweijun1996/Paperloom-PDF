'use client';

import * as Tooltip from '@radix-ui/react-tooltip';
import { Loader2 } from 'lucide-react';
import type { ComponentPropsWithRef, ReactNode } from 'react';
import { Z_LAYERS } from '../zLayers';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

// Static literals only: Tailwind must see every class at build time.
// Primary text uses --on-accent, which is only valid on the bloom-500/600/700 fills.
const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-bloom-500 font-semibold text-on-accent shadow-sm hover:bg-bloom-600 active:bg-bloom-700',
  secondary: 'border border-border-strong bg-panel text-app hover:bg-panel-elevated',
  ghost: 'text-app-muted hover:bg-panel-elevated hover:text-app',
  danger: 'border border-danger bg-danger-soft font-semibold text-danger hover:bg-panel-elevated',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 px-3 text-xs',
  md: 'h-9 gap-2 px-4 text-sm',
};

const BASE_CLASSES = 'inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-xl transition-colors disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:min-h-11';

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, sets aria-busy and disables the button. */
  loading?: boolean;
}

type ButtonBaseProps = Omit<ButtonProps, 'size'> & { sizeClasses: string };

/** Shared rendering for Button and IconButton; each passes its own static size classes. */
function ButtonBase({
  variant = 'secondary',
  sizeClasses,
  loading = false,
  disabled,
  type = 'button',
  className,
  children,
  ...rest
}: ButtonBaseProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-variant={variant}
      className={cx(BASE_CLASSES, VARIANT_CLASSES[variant], sizeClasses, className)}
    >
      {loading && <Loader2 aria-hidden="true" data-testid="button-spinner" className="size-4 animate-spin" />}
      {children}
    </button>
  );
}

export function Button({ size = 'md', ...rest }: ButtonProps) {
  return <ButtonBase {...rest} sizeClasses={SIZE_CLASSES[size]} />;
}

const ICON_SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'size-7 min-h-6 min-w-6 pointer-coarse:min-w-11',
  md: 'size-9 min-h-6 min-w-6 pointer-coarse:min-w-11',
};

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'aria-label' | 'size'> {
  /** Required accessible name; also the default tooltip text. */
  'aria-label': string;
  icon: ReactNode;
  size?: ButtonSize;
  /** Visible tooltip text; defaults to aria-label. */
  tooltip?: string;
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
}

/**
 * Icon-only button: 24px minimum, 44px under a coarse pointer, with a visible
 * tooltip on hover and keyboard focus. The tooltip portals at Z_LAYERS.dropdown,
 * so it paints below drawers and modals; inside those, prefer a labelled Button.
 */
export function IconButton({
  icon,
  tooltip,
  tooltipSide = 'top',
  variant = 'ghost',
  size = 'md',
  className,
  ...rest
}: IconButtonProps) {
  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <ButtonBase {...rest} variant={variant} sizeClasses={ICON_SIZE_CLASSES[size]} className={className}>
            {!rest.loading && <span aria-hidden="true" className="inline-flex">{icon}</span>}
          </ButtonBase>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side={tooltipSide}
            sideOffset={6}
            style={{ zIndex: Z_LAYERS.dropdown }}
            className="rounded-md border border-border-strong bg-panel-elevated px-2 py-1 text-xs text-app shadow-md"
          >
            {tooltip ?? rest['aria-label']}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
