'use client';

import React, { useEffect, useRef } from 'react';
import { ChevronsUpDown, X } from 'lucide-react';
import { Button, TextInput } from '../ui';

export type LinkPopoverMode = 'hover' | 'edit';

export interface LinkPopoverProps {
  mode: LinkPopoverMode;
  /** CSS center-X of the link rect. */
  anchorX: number;
  /** CSS bottom-Y of the link rect (popover sits below). */
  anchorY: number;
  url: string;
  displayText: string;
  onUrlChange?: (url: string) => void;
  onDisplayChange?: (text: string) => void;
  onEdit: () => void;
  onOpen: () => void;
  onRemove: () => void;
  onClose?: () => void;
  onPopoverEnter?: () => void;
  onPopoverLeave?: () => void;
}

/**
 * Acrobat/Sejda-style link popovers over the PDF page.
 * Hover: URL + Edit + Open Link
 * Edit: Display / Link to / Link + Remove + Open Link
 */
export function LinkPopover({
  mode,
  anchorX,
  anchorY,
  url,
  displayText,
  onUrlChange,
  onDisplayChange,
  onEdit,
  onOpen,
  onRemove,
  onClose,
  onPopoverEnter,
  onPopoverLeave,
}: LinkPopoverProps) {
  const displayRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === 'edit') {
      displayRef.current?.focus();
      displayRef.current?.select();
    }
  }, [mode]);

  // Canvas-local z-50 (Z_LAYERS.canvasMin..canvasMax), not a global dropdown.
  return (
    <div
      className="absolute z-50"
      data-link-popover
      style={{ left: anchorX, top: anchorY, transform: 'translateX(-50%)' }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={onPopoverEnter}
      onMouseLeave={onPopoverLeave}
    >
      {/* Invisible bridge so the pointer can travel from the link into the popover */}
      <div className="h-3 w-full" aria-hidden />

      {/* Caret pointer */}
      <div
        className="absolute top-1.5 left-1/2 -translate-x-1/2 w-3 h-3 rotate-45 bg-panel border-l border-t border-app"
        aria-hidden
      />

      {mode === 'hover' ? (
        <div className="relative min-w-[220px] max-w-[320px] rounded-xl border border-app bg-panel p-2.5 text-app shadow-lg">
          <div className="mb-2 truncate rounded-lg bg-panel-elevated px-3 py-2 font-mono text-[12px] text-app-muted">
            {url || '(empty URL)'}
          </div>
          <div className="flex gap-2">
            <Button size="sm" className="flex-1" onClick={onEdit}>Edit</Button>
            <Button size="sm" variant="primary" className="flex-1" onClick={onOpen}>Open Link</Button>
          </div>
        </div>
      ) : (
        <div className="relative w-[280px] rounded-xl border border-app bg-panel p-3 text-app shadow-lg">
          <div className="space-y-2.5">
            <label className="flex items-center gap-2 text-[12px] text-app-muted">
              <span className="w-14 shrink-0">Display:</span>
              <TextInput
                ref={displayRef}
                value={displayText}
                onChange={(e) => onDisplayChange?.(e.target.value)}
                className="min-w-0 flex-1"
              />
            </label>
            <div className="flex items-center gap-2 text-[12px] text-app-muted">
              <span className="w-14 shrink-0">Link to:</span>
              <div className="flex flex-1 items-center rounded-xl border border-border-strong bg-panel-elevated px-3 py-1.5 text-[12px] text-app">
                <span className="flex-1">Web page</span>
                <ChevronsUpDown size={14} aria-hidden="true" className="text-accent" />
              </div>
            </div>
            <label className="flex items-center gap-2 text-[12px] text-app-muted">
              <span className="w-14 shrink-0">Link:</span>
              <TextInput
                type="url"
                value={url}
                onChange={(e) => onUrlChange?.(e.target.value)}
                className="min-w-0 flex-1"
              />
            </label>
            <div className="flex gap-2 pt-1">
              <Button size="sm" className="flex-1" onClick={onRemove}>Remove</Button>
              <Button size="sm" className="flex-1" onClick={onOpen}>Open Link</Button>
            </div>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full border border-app bg-panel-elevated text-app-muted shadow-sm hover:text-app"
              aria-label="Close"
            >
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
