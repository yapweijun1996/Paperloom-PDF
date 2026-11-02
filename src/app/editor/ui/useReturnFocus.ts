'use client';

import { useRef } from 'react';

type AutoFocusHandler = (event: Event) => void;

/**
 * Radix dialogs only return focus to a `Dialog.Trigger`. Our dialogs are
 * controlled without triggers, so remember the element focused when the
 * content mounts and restore it on close. A consumer handler that calls
 * preventDefault() takes over focus placement.
 */
export function useReturnFocus(onOpenAutoFocus?: AutoFocusHandler, onCloseAutoFocus?: AutoFocusHandler) {
  const previous = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus(event: Event) {
      const active = document.activeElement;
      previous.current = active instanceof HTMLElement && active !== document.body ? active : null;
      onOpenAutoFocus?.(event);
    },
    onCloseAutoFocus(event: Event) {
      onCloseAutoFocus?.(event);
      if (event.defaultPrevented) return;
      event.preventDefault();
      const target = previous.current;
      previous.current = null;
      if (target?.isConnected) target.focus();
    },
  };
}
