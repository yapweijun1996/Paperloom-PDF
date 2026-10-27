/**
 * Input Handler — processes keyboard events for text editing.
 *
 * Pure logic module: takes current text + caret position, returns new text +
 * new caret position. No DOM or side-effect coupling.
 *
 * Handles:
 * - Character insertion (with selection replacement)
 * - Backspace / Delete (with selection awareness)
 * - Paste (batch insert with selection replacement)
 * - Special key dispatch (arrows, Home, End, Escape)
 *
 * **Validates Requirements**: 2.1, 3.1, 3.2, 3.3, 3.4, 4.3, 4.4, 11.2
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface KeyModifiers {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean; // Cmd on Mac
}

export interface EditState {
  text: string;
  caretOffset: number;
  /** Selection range, null if no selection. start < end always. */
  selectionStart: number | null;
  selectionEnd: number | null;
}

export interface EditAction {
  newText: string;
  newCaretOffset: number;
  /** Whether selection should be cleared after this action. */
  clearSelection: boolean;
  /** New selection range (for shift+arrow operations). */
  newSelectionStart?: number;
  newSelectionEnd?: number;
}

/**
 * What action was taken — useful for the controller to decide
 * whether to update Bloom model, trigger reflow, etc.
 */
export type EditActionKind =
  | 'insert'
  | 'delete'
  | 'move'
  | 'select'
  | 'selectAll'
  | 'paste'
  | 'noop'
  | 'commit'
  | 'cancel';

export interface EditResult {
  action: EditAction;
  kind: EditActionKind;
}

// ─── InputHandler ───────────────────────────────────────────────────────────

export class InputHandler {
  /**
   * Handle a printable character insertion.
   *
   * **Property 4**: Inserting char C at position P results in:
   *   text = text[0..P] + C + text[P..]
   *   length = oldLength + 1  (or oldLength - selectionLength + 1 if selection)
   */
  handleCharacterInput(state: EditState, char: string): EditResult {
    const { text, caretOffset, selectionStart, selectionEnd } = state;

    // If selection exists, replace it
    if (selectionStart !== null && selectionEnd !== null && selectionStart !== selectionEnd) {
      const lo = Math.min(selectionStart, selectionEnd);
      const hi = Math.max(selectionStart, selectionEnd);
      const newText = text.slice(0, lo) + char + text.slice(hi);
      return {
        action: {
          newText,
          newCaretOffset: lo + char.length,
          clearSelection: true,
        },
        kind: 'insert',
      };
    }

    // Normal insertion
    const pos = clamp(caretOffset, 0, text.length);
    const newText = text.slice(0, pos) + char + text.slice(pos);
    return {
      action: {
        newText,
        newCaretOffset: pos + char.length,
        clearSelection: true,
      },
      kind: 'insert',
    };
  }

  /**
   * Handle backspace key.
   *
   * **Property 7**: Backspace at position P (P > 0) removes text[P-1]:
   *   text = text[0..P-1] + text[P..]
   *   length = oldLength - 1
   *
   * **Property 8**: Backspace at position 0 is idempotent (no change).
   */
  handleBackspace(state: EditState): EditResult {
    const { text, caretOffset, selectionStart, selectionEnd } = state;

    // If selection exists, delete the selected range
    if (selectionStart !== null && selectionEnd !== null && selectionStart !== selectionEnd) {
      return this.deleteRange(text, selectionStart, selectionEnd);
    }

    // At beginning — no-op
    if (caretOffset <= 0) {
      return { action: { newText: text, newCaretOffset: 0, clearSelection: true }, kind: 'noop' };
    }

    const pos = clamp(caretOffset, 0, text.length);
    const newText = text.slice(0, pos - 1) + text.slice(pos);
    return {
      action: { newText, newCaretOffset: pos - 1, clearSelection: true },
      kind: 'delete',
    };
  }

  /**
   * Handle delete key (forward delete).
   *
   * **Property 7**: Delete at position P (P < length) removes text[P]:
   *   text = text[0..P] + text[P+1..]
   *   length = oldLength - 1
   *
   * **Property 8**: Delete at end is idempotent (no change).
   */
  handleDelete(state: EditState): EditResult {
    const { text, caretOffset, selectionStart, selectionEnd } = state;

    // If selection exists, delete the selected range
    if (selectionStart !== null && selectionEnd !== null && selectionStart !== selectionEnd) {
      return this.deleteRange(text, selectionStart, selectionEnd);
    }

    // At end — no-op
    if (caretOffset >= text.length) {
      return {
        action: { newText: text, newCaretOffset: text.length, clearSelection: true },
        kind: 'noop',
      };
    }

    const pos = clamp(caretOffset, 0, text.length);
    const newText = text.slice(0, pos) + text.slice(pos + 1);
    return {
      action: { newText, newCaretOffset: pos, clearSelection: true },
      kind: 'delete',
    };
  }

  /**
   * Handle paste from clipboard.
   *
   * **Property 15**: Paste produces same result as sequential character insertions.
   *
   * **Property 10**: If selection exists, replaces selection then inserts.
   */
  handlePaste(state: EditState, pastedText: string): EditResult {
    const { text, caretOffset, selectionStart, selectionEnd } = state;

    // If selection exists, replace it with pasted text
    if (selectionStart !== null && selectionEnd !== null && selectionStart !== selectionEnd) {
      const lo = Math.min(selectionStart, selectionEnd);
      const hi = Math.max(selectionStart, selectionEnd);
      const newText = text.slice(0, lo) + pastedText + text.slice(hi);
      return {
        action: { newText, newCaretOffset: lo + pastedText.length, clearSelection: true },
        kind: 'paste',
      };
    }

    // Normal paste at caret
    const pos = clamp(caretOffset, 0, text.length);
    const newText = text.slice(0, pos) + pastedText + text.slice(pos);
    return {
      action: { newText, newCaretOffset: pos + pastedText.length, clearSelection: true },
      kind: 'paste',
    };
  }

  /**
   * Handle special key dispatch.
   * Returns edit result with kind indicating what happened.
   */
  handleSpecialKey(state: EditState, key: string, modifiers: KeyModifiers): EditResult {
    const { text, caretOffset } = state;
    const isMac = modifiers.meta;
    const isWordNav = modifiers.ctrl || modifiers.alt || isMac;

    switch (key) {
      case 'ArrowLeft': {
        if (modifiers.shift) {
          return this.handleShiftArrow(state, 'left', isWordNav);
        }
        if (isWordNav) {
          const newPos = this.findWordStart(text, caretOffset);
          return {
            action: { newText: text, newCaretOffset: newPos, clearSelection: true },
            kind: 'move',
          };
        }
        const newPos = Math.max(0, caretOffset - 1);
        return {
          action: { newText: text, newCaretOffset: newPos, clearSelection: true },
          kind: 'move',
        };
      }

      case 'ArrowRight': {
        if (modifiers.shift) {
          return this.handleShiftArrow(state, 'right', isWordNav);
        }
        if (isWordNav) {
          const newPos = this.findWordEnd(text, caretOffset);
          return {
            action: { newText: text, newCaretOffset: newPos, clearSelection: true },
            kind: 'move',
          };
        }
        const newPos = Math.min(text.length, caretOffset + 1);
        return {
          action: { newText: text, newCaretOffset: newPos, clearSelection: true },
          kind: 'move',
        };
      }

      case 'Home': {
        if (modifiers.shift) {
          return {
            action: {
              newText: text,
              newCaretOffset: 0,
              clearSelection: false,
              newSelectionStart: state.selectionStart ?? caretOffset,
              newSelectionEnd: 0,
            },
            kind: 'select',
          };
        }
        return {
          action: { newText: text, newCaretOffset: 0, clearSelection: true },
          kind: 'move',
        };
      }

      case 'End': {
        if (modifiers.shift) {
          return {
            action: {
              newText: text,
              newCaretOffset: text.length,
              clearSelection: false,
              newSelectionStart: state.selectionStart ?? caretOffset,
              newSelectionEnd: text.length,
            },
            kind: 'select',
          };
        }
        return {
          action: { newText: text, newCaretOffset: text.length, clearSelection: true },
          kind: 'move',
        };
      }

      case 'a':
      case 'A': {
        // Ctrl+A / Cmd+A — select all
        if (modifiers.ctrl || modifiers.meta) {
          return {
            action: {
              newText: text,
              newCaretOffset: text.length,
              clearSelection: false,
              newSelectionStart: 0,
              newSelectionEnd: text.length,
            },
            kind: 'selectAll',
          };
        }
        break;
      }

      case 'Enter': {
        return {
          action: { newText: text, newCaretOffset: caretOffset, clearSelection: true },
          kind: 'commit',
        };
      }

      case 'Escape': {
        return {
          action: { newText: text, newCaretOffset: caretOffset, clearSelection: true },
          kind: 'cancel',
        };
      }
    }

    // Unhandled key
    return {
      action: { newText: text, newCaretOffset: caretOffset, clearSelection: false },
      kind: 'noop',
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────

  /**
   * Delete a range of text (used for selection delete).
   *
   * **Property 10**: Selection replacement = delete range then set caret to start.
   */
  private deleteRange(text: string, start: number, end: number): EditResult {
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    const newText = text.slice(0, lo) + text.slice(hi);
    return {
      action: { newText, newCaretOffset: lo, clearSelection: true },
      kind: 'delete',
    };
  }

  /**
   * Handle Shift+Arrow for extending selection.
   */
  private handleShiftArrow(
    state: EditState,
    direction: 'left' | 'right',
    isWordNav: boolean,
  ): EditResult {
    const { text, caretOffset, selectionStart } = state;

    // Anchor is where the selection started (or current caret if no selection)
    const anchor = selectionStart ?? caretOffset;

    let newFocus: number;
    if (direction === 'left') {
      newFocus = isWordNav
        ? this.findWordStart(text, caretOffset)
        : Math.max(0, caretOffset - 1);
    } else {
      newFocus = isWordNav
        ? this.findWordEnd(text, caretOffset)
        : Math.min(text.length, caretOffset + 1);
    }

    return {
      action: {
        newText: text,
        newCaretOffset: newFocus,
        clearSelection: false,
        newSelectionStart: anchor,
        newSelectionEnd: newFocus,
      },
      kind: 'select',
    };
  }

  /**
   * Find the start of the word before position.
   * Skips whitespace then non-whitespace going left.
   */
  private findWordStart(text: string, pos: number): number {
    let p = pos;
    // Skip whitespace going left
    while (p > 0 && /\s/.test(text[p - 1])) p--;
    // Skip non-whitespace going left
    while (p > 0 && !/\s/.test(text[p - 1])) p--;
    return p;
  }

  /**
   * Find the end of the word after position.
   * Skips whitespace then non-whitespace going right.
   */
  private findWordEnd(text: string, pos: number): number {
    let p = pos;
    // Skip whitespace going right
    while (p < text.length && /\s/.test(text[p])) p++;
    // Skip non-whitespace going right
    while (p < text.length && !/\s/.test(text[p])) p++;
    return p;
  }
}

// ─── Utility ────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
