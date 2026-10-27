/**
 * Editor Controller — central coordinator for Word-like text editing.
 *
 * Integrates CaretManager, SelectionHandler, and InputHandler into a
 * coherent editing session with state machine:
 *   idle → editing → committing → idle
 *
 * The controller is a headless logic layer — it does not touch the DOM.
 * The UI layer (page.tsx) reads state from the controller and applies
 * it to the textarea overlay and canvas.
 *
 * **Validates Requirements**: 1.1, 2.1, 4.1, 5.4, 10.1, 10.2, 10.3
 */

import type { BloomCaret, BloomPage } from '../bloom/types';
import { blockPlainText } from '../bloom/types';
import {
  insertTextAtCaret,
  deleteTextAtCaret,
  replaceRange,
} from '../bloom/edit';
import { CaretManager } from './caret-manager';
import { SelectionHandler, type NormalizedRange } from './selection-handler';
import { InputHandler, type KeyModifiers, type EditState, type EditActionKind } from './input-handler';

// ─── Types ──────────────────────────────────────────────────────────────────

export type EditorPhase = 'idle' | 'editing' | 'committing';

export interface EditorSnapshot {
  /** Text before this edit session started. */
  originalText: string;
  /** Block ID being edited. */
  blockId: string;
}

export interface EditEvent {
  kind: EditActionKind;
  newText: string;
  newCaretOffset: number;
  /** Whether Bloom model was updated. */
  bloomUpdated: boolean;
  /** Updated Bloom page (if bloomUpdated). */
  bloomPage?: BloomPage;
}

// ─── EditorController ───────────────────────────────────────────────────────

export class EditorController {
  readonly caret = new CaretManager();
  readonly selection = new SelectionHandler();
  readonly input = new InputHandler();

  private phase: EditorPhase = 'idle';
  private snapshot: EditorSnapshot | null = null;
  private currentText = '';

  // ── State queries ──────────────────────────────────────────────────────

  getPhase(): EditorPhase {
    return this.phase;
  }

  isEditing(): boolean {
    return this.phase === 'editing';
  }

  getCurrentText(): string {
    return this.currentText;
  }

  getBlockId(): string | null {
    return this.snapshot?.blockId ?? null;
  }

  getOriginalText(): string {
    return this.snapshot?.originalText ?? '';
  }

  hasTextChanged(): boolean {
    return this.currentText !== (this.snapshot?.originalText ?? '');
  }

  // ── Session lifecycle ──────────────────────────────────────────────────

  /**
   * Start an editing session from a click at PDF coordinates.
   * Returns the block ID + initial text if a block was hit, or null.
   */
  startEditFromClick(
    bloomPage: BloomPage,
    pdfX: number,
    pdfY: number,
  ): { blockId: string; text: string; caretOffset: number } | null {
    this.caret.setBloomPage(bloomPage);
    const caretHit = this.caret.setCaretFromClick(pdfX, pdfY);
    if (!caretHit) return null;

    const block = bloomPage.blocks.find(b => b.id === caretHit.blockId);
    if (!block) return null;

    const text = blockPlainText(block);
    this.beginSession(caretHit.blockId, text, caretHit.offset);

    return { blockId: caretHit.blockId, text, caretOffset: caretHit.offset };
  }

  /**
   * Start an editing session with explicit block ID and text.
   * Used when the UI has already determined which line to edit.
   */
  startEdit(
    bloomPage: BloomPage,
    blockId: string,
    text: string,
    caretOffset: number,
  ): void {
    this.caret.setBloomPage(bloomPage);
    this.caret.setCaret({ blockId, offset: caretOffset });
    this.beginSession(blockId, text, caretOffset);
  }

  /**
   * End the editing session. Returns whether text was changed.
   */
  endEdit(): boolean {
    const changed = this.hasTextChanged();
    this.phase = 'idle';
    this.snapshot = null;
    this.currentText = '';
    this.caret.clear();
    this.selection.clearSelection();
    return changed;
  }

  /**
   * Mark session as committing (prevents re-entry).
   */
  beginCommit(): void {
    this.phase = 'committing';
  }

  /**
   * Mark commit as complete, return to idle.
   */
  endCommit(): void {
    this.phase = 'idle';
    this.snapshot = null;
    this.currentText = '';
    this.caret.clear();
    this.selection.clearSelection();
  }

  // ── Input processing ───────────────────────────────────────────────────

  /**
   * Process a textarea input event (character was typed or text changed).
   * This is the primary handler for the hidden textarea's `onInput`.
   */
  handleTextInput(newText: string, newCaretOffset: number): EditEvent {
    if (this.phase !== 'editing') {
      return { kind: 'noop', newText: this.currentText, newCaretOffset: 0, bloomUpdated: false };
    }

    this.currentText = newText;
    this.caret.setOffset(newCaretOffset);
    this.selection.clearSelection();
    this.caret.resetBlink();

    // Update Bloom model
    const bloomPage = this.updateBloomModel(newText, newCaretOffset);

    return {
      kind: 'insert',
      newText,
      newCaretOffset,
      bloomUpdated: !!bloomPage,
      bloomPage: bloomPage ?? undefined,
    };
  }

  /**
   * Process a keyboard event from the textarea.
   * Handles special keys that the textarea doesn't handle natively.
   */
  handleKeyDown(key: string, modifiers: KeyModifiers): EditEvent {
    if (this.phase !== 'editing') {
      return { kind: 'noop', newText: this.currentText, newCaretOffset: 0, bloomUpdated: false };
    }

    const caretOffset = this.caret.getCaret()?.offset ?? 0;
    const range = this.selection.getNormalizedRange();

    const state: EditState = {
      text: this.currentText,
      caretOffset,
      selectionStart: range?.start ?? null,
      selectionEnd: range?.end ?? null,
    };

    // Ctrl+A / Cmd+A — select all
    if ((key === 'a' || key === 'A') && (modifiers.ctrl || modifiers.meta)) {
      const result = this.input.handleSpecialKey(state, key, modifiers);
      const action = result.action;

      if (action.newSelectionStart !== undefined && action.newSelectionEnd !== undefined) {
        this.selection.selectAll(
          this.snapshot!.blockId,
          this.currentText.length,
        );
      }

      this.caret.setOffset(action.newCaretOffset);
      return {
        kind: result.kind,
        newText: this.currentText,
        newCaretOffset: action.newCaretOffset,
        bloomUpdated: false,
      };
    }

    // Enter — commit
    if (key === 'Enter' && !modifiers.shift) {
      return {
        kind: 'commit',
        newText: this.currentText,
        newCaretOffset: caretOffset,
        bloomUpdated: false,
      };
    }

    // Escape — cancel
    if (key === 'Escape') {
      return {
        kind: 'cancel',
        newText: this.currentText,
        newCaretOffset: caretOffset,
        bloomUpdated: false,
      };
    }

    // Arrow keys, Home, End — let the textarea handle movement natively.
    // The UI layer syncs caret from textarea.selectionStart after the event.
    // But we do track selection for Shift+Arrow.
    if (key.startsWith('Arrow') || key === 'Home' || key === 'End') {
      const result = this.input.handleSpecialKey(state, key, modifiers);
      const action = result.action;

      if (result.kind === 'select' && action.newSelectionStart !== undefined && action.newSelectionEnd !== undefined) {
        this.selection.setFromOffsets(
          this.snapshot!.blockId,
          action.newSelectionStart,
          action.newSelectionEnd,
        );
      } else if (action.clearSelection) {
        this.selection.clearSelection();
      }

      // Don't override caret here — let the textarea handle it natively
      // and sync from selectionStart in the UI layer.
      return {
        kind: result.kind,
        newText: this.currentText,
        newCaretOffset: action.newCaretOffset,
        bloomUpdated: false,
      };
    }

    return {
      kind: 'noop',
      newText: this.currentText,
      newCaretOffset: caretOffset,
      bloomUpdated: false,
    };
  }

  /**
   * Sync caret offset from the textarea's selectionStart.
   * Called after the browser processes key events.
   */
  syncCaretFromTextarea(selectionStart: number, selectionEnd: number): void {
    if (this.phase !== 'editing') return;

    this.caret.setOffset(selectionStart);
    this.caret.resetBlink();

    // If textarea has a selection range, update our selection state
    if (selectionStart !== selectionEnd && this.snapshot) {
      this.selection.setFromOffsets(this.snapshot.blockId, selectionStart, selectionEnd);
    } else if (!this.selection.isSelecting()) {
      // Only clear if we're not in a shift+arrow operation
      this.selection.clearSelection();
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private beginSession(blockId: string, text: string, caretOffset: number): void {
    this.phase = 'editing';
    this.currentText = text;
    this.snapshot = { originalText: text, blockId };
    this.selection.clearSelection();
  }

  /**
   * Update the Bloom model after text changes.
   * Returns updated BloomPage if successful, null otherwise.
   */
  private updateBloomModel(newText: string, caretOffset: number): BloomPage | null {
    const bloomPage = this.caret.getBloomPage();
    if (!bloomPage || !this.snapshot) return null;

    const blockId = this.snapshot.blockId;
    const block = bloomPage.blocks.find(b => b.id === blockId);
    if (!block) return null;

    // Use replaceRange to update the entire block text
    const oldText = blockPlainText(block);
    const result = replaceRange(bloomPage, blockId, 0, oldText.length, newText);

    this.caret.setBloomPage(result.page);
    this.caret.setCaret({ blockId, offset: caretOffset });

    return result.page;
  }
}
