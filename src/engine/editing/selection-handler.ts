/**
 * Selection Handler — tracks text selection range and provides operations.
 *
 * Selection spans from an anchor point (where selection started) to a focus
 * point (current position during drag). The range can be normalized to
 * [min, max] regardless of drag direction.
 *
 * **Validates Requirements**: 4.1, 4.2, 4.3, 4.4, 4.5
 */

import type { BloomCaret, BloomSelection } from '../bloom/types';
import type { SelectionState } from './types';

// ─── Normalized Range ───────────────────────────────────────────────────────

export interface NormalizedRange {
  blockId: string;
  start: number;
  end: number;
}

// ─── SelectionHandler ───────────────────────────────────────────────────────

export class SelectionHandler {
  private state: SelectionState = {
    selection: null,
    isSelecting: false,
    anchorCaret: null,
  };

  /** Get current selection (may be null). */
  getSelection(): BloomSelection | null {
    return this.state.selection;
  }

  /** Get full selection state. */
  getState(): Readonly<SelectionState> {
    return this.state;
  }

  /** Whether there is an active selection. */
  hasSelection(): boolean {
    return this.state.selection !== null;
  }

  /** Whether currently dragging to extend selection. */
  isSelecting(): boolean {
    return this.state.isSelecting;
  }

  /**
   * Start selection from the given caret position.
   * Sets the anchor point for the selection range.
   */
  startSelection(caret: BloomCaret): void {
    this.state.anchorCaret = { ...caret };
    this.state.selection = {
      start: { ...caret },
      end: { ...caret },
    };
    this.state.isSelecting = true;
  }

  /**
   * Extend selection to a new offset (within same block).
   * Updates the focus (end) point of the selection.
   */
  extendSelection(offset: number): void {
    if (!this.state.anchorCaret) return;

    this.state.selection = {
      start: { ...this.state.anchorCaret },
      end: { blockId: this.state.anchorCaret.blockId, offset },
    };
  }

  /**
   * Extend selection using a full caret position (for mouse drag).
   */
  extendSelectionTo(caret: BloomCaret): void {
    if (!this.state.anchorCaret) return;

    this.state.selection = {
      start: { ...this.state.anchorCaret },
      end: { ...caret },
    };
  }

  /**
   * End selection drag (mouse up).
   */
  endSelecting(): void {
    this.state.isSelecting = false;
  }

  /**
   * Clear the selection entirely.
   */
  clearSelection(): void {
    this.state.selection = null;
    this.state.isSelecting = false;
    this.state.anchorCaret = null;
  }

  /**
   * Get the normalized selection range (start < end).
   * Returns null if no selection or selection is collapsed (start === end).
   *
   * **Property 9**: Normalized range always has start < end regardless of drag direction.
   */
  getNormalizedRange(): NormalizedRange | null {
    if (!this.state.selection) return null;

    const { start, end } = this.state.selection;

    // Only support same-block selections
    if (start.blockId !== end.blockId) return null;

    const lo = Math.min(start.offset, end.offset);
    const hi = Math.max(start.offset, end.offset);

    // Collapsed selection (caret, no actual range)
    if (lo === hi) return null;

    return { blockId: start.blockId, start: lo, end: hi };
  }

  /**
   * Get selected text from the block's full text.
   */
  getSelectedText(blockText: string): string {
    const range = this.getNormalizedRange();
    if (!range) return '';
    return blockText.slice(range.start, range.end);
  }

  /**
   * Select all text in the given block.
   *
   * **Property 11**: Select-all produces range [0, text.length].
   */
  selectAll(blockId: string, textLength: number): void {
    this.state.anchorCaret = { blockId, offset: 0 };
    this.state.selection = {
      start: { blockId, offset: 0 },
      end: { blockId, offset: textLength },
    };
    this.state.isSelecting = false;
  }

  /**
   * Set selection from external state (e.g., from textarea selectionStart/End).
   */
  setFromOffsets(blockId: string, start: number, end: number): void {
    if (start === end) {
      this.clearSelection();
      return;
    }
    this.state.anchorCaret = { blockId, offset: start };
    this.state.selection = {
      start: { blockId, offset: start },
      end: { blockId, offset: end },
    };
    this.state.isSelecting = false;
  }
}
