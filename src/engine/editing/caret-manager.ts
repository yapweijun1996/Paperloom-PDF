/**
 * Caret Manager — tracks and controls the text insertion point.
 *
 * Encapsulates caret positioning, movement (character/word/line),
 * visual position calculation, and blink animation.
 *
 * Delegates to Bloom engine for hit-testing and PDF position calculation.
 *
 * **Validates Requirements**: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 5.1
 */

import type { BloomCaret, BloomPage } from '../bloom/types';
import { blockPlainText } from '../bloom/types';
import {
  hitTestBloomPage,
  findNearestBlock,
  caretPdfPosition,
} from '../bloom/edit';
import type { CaretState } from './types';

// ─── CaretManager ───────────────────────────────────────────────────────────

export class CaretManager {
  private state: CaretState = {
    caret: null,
    visualPosition: null,
    isVisible: true,
    blinkTimer: null,
    preferredX: null,
  };

  private bloomPage: BloomPage | null = null;

  /** Get current caret position. */
  getCaret(): BloomCaret | null {
    return this.state.caret;
  }

  /** Get full caret state (for rendering). */
  getState(): Readonly<CaretState> {
    return this.state;
  }

  /** Update the Bloom page reference (on re-render or edit). */
  setBloomPage(page: BloomPage | null): void {
    this.bloomPage = page;
  }

  /** Get current Bloom page. */
  getBloomPage(): BloomPage | null {
    return this.bloomPage;
  }

  /**
   * Set caret from user click in PDF coordinates.
   * Delegates to Bloom hit-testing with fallback to nearest block.
   */
  setCaretFromClick(pdfX: number, pdfY: number): BloomCaret | null {
    if (!this.bloomPage) return null;

    // Direct hit-test
    let caret = hitTestBloomPage(this.bloomPage, pdfX, pdfY);

    // Fallback: find nearest block within 40pt
    if (!caret) {
      caret = findNearestBlock(this.bloomPage, pdfX, pdfY, 40);
    }

    if (caret) {
      this.state.caret = caret;
      this.updateVisualPosition();
      this.state.preferredX = null;
    }

    return caret;
  }

  /**
   * Set caret directly (e.g., from textarea selection change).
   */
  setCaret(caret: BloomCaret | null): void {
    this.state.caret = caret;
    if (caret) {
      this.updateVisualPosition();
    } else {
      this.state.visualPosition = null;
    }
    this.state.preferredX = null;
  }

  /**
   * Set caret offset within the current block.
   */
  setOffset(offset: number): void {
    if (!this.state.caret) return;
    const text = this.getBlockText();
    this.state.caret = {
      ...this.state.caret,
      offset: clamp(offset, 0, text.length),
    };
    this.updateVisualPosition();
  }

  /**
   * Move caret by delta characters.
   * Negative = left, positive = right.
   * Returns new offset.
   *
   * **Property 2**: Always results in 0 ≤ position ≤ length.
   */
  moveCaret(delta: number): number {
    if (!this.state.caret) return 0;

    const text = this.getBlockText();
    const newOffset = clamp(this.state.caret.offset + delta, 0, text.length);
    this.state.caret = { ...this.state.caret, offset: newOffset };
    this.updateVisualPosition();
    this.state.preferredX = null;
    return newOffset;
  }

  /**
   * Move caret to start of current line.
   */
  moveToLineStart(): number {
    if (!this.state.caret || !this.bloomPage) return 0;

    const block = this.findBlock();
    if (!block) return this.state.caret.offset;

    const lineBox = this.findLineBox(block);
    if (!lineBox) return 0;

    const newOffset = lineBox.startOffset;
    this.state.caret = { ...this.state.caret, offset: newOffset };
    this.updateVisualPosition();
    return newOffset;
  }

  /**
   * Move caret to end of current line.
   */
  moveToLineEnd(): number {
    if (!this.state.caret || !this.bloomPage) return 0;

    const block = this.findBlock();
    if (!block) return this.state.caret.offset;

    const lineBox = this.findLineBox(block);
    if (!lineBox) return this.state.caret.offset;

    const newOffset = lineBox.startOffset + lineBox.text.length;
    this.state.caret = { ...this.state.caret, offset: newOffset };
    this.updateVisualPosition();
    return newOffset;
  }

  /**
   * Move caret to start of previous word.
   * Uses whitespace detection for word boundaries.
   *
   * **Property 3**: Moves to position where previous char is whitespace or boundary.
   */
  moveToWordStart(): number {
    if (!this.state.caret) return 0;

    const text = this.getBlockText();
    let pos = this.state.caret.offset;

    // Skip whitespace going left
    while (pos > 0 && /\s/.test(text[pos - 1])) {
      pos--;
    }

    // Skip non-whitespace going left (the word itself)
    while (pos > 0 && !/\s/.test(text[pos - 1])) {
      pos--;
    }

    this.state.caret = { ...this.state.caret, offset: pos };
    this.updateVisualPosition();
    this.state.preferredX = null;
    return pos;
  }

  /**
   * Move caret to end of next word.
   * Uses whitespace detection for word boundaries.
   *
   * **Property 3**: Moves to position where next char is whitespace or boundary.
   */
  moveToWordEnd(): number {
    if (!this.state.caret) return 0;

    const text = this.getBlockText();
    let pos = this.state.caret.offset;

    // Skip whitespace going right
    while (pos < text.length && /\s/.test(text[pos])) {
      pos++;
    }

    // Skip non-whitespace going right (the word itself)
    while (pos < text.length && !/\s/.test(text[pos])) {
      pos++;
    }

    this.state.caret = { ...this.state.caret, offset: pos };
    this.updateVisualPosition();
    this.state.preferredX = null;
    return pos;
  }

  /**
   * Get visual position for drawing caret in PDF coordinates.
   */
  getCaretPdfPosition(): { x: number; y: number; height: number } | null {
    if (!this.state.caret || !this.bloomPage) return null;
    return caretPdfPosition(this.bloomPage, this.state.caret);
  }

  /**
   * Start caret blink animation (530ms interval).
   * @param onBlink Callback invoked on each blink toggle.
   */
  startBlinking(onBlink?: (visible: boolean) => void): void {
    this.stopBlinking();
    this.state.isVisible = true;
    this.state.blinkTimer = window.setInterval(() => {
      this.state.isVisible = !this.state.isVisible;
      onBlink?.(this.state.isVisible);
    }, 530) as unknown as number;
  }

  /**
   * Stop caret blink animation.
   */
  stopBlinking(): void {
    if (this.state.blinkTimer !== null) {
      clearInterval(this.state.blinkTimer);
      this.state.blinkTimer = null;
    }
    this.state.isVisible = true;
  }

  /** Reset caret to show immediately (e.g., after keystroke). */
  resetBlink(): void {
    this.state.isVisible = true;
  }

  /** Clear all caret state. */
  clear(): void {
    this.stopBlinking();
    this.state = {
      caret: null,
      visualPosition: null,
      isVisible: true,
      blinkTimer: null,
      preferredX: null,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private getBlockText(): string {
    const block = this.findBlock();
    return block ? blockPlainText(block) : '';
  }

  private findBlock() {
    if (!this.state.caret || !this.bloomPage) return null;
    return this.bloomPage.blocks.find(b => b.id === this.state.caret!.blockId) ?? null;
  }

  private findLineBox(block: { lineBoxes: Array<{ startOffset: number; text: string }> }) {
    if (!this.state.caret) return null;
    const offset = this.state.caret.offset;
    for (const lb of block.lineBoxes) {
      const end = lb.startOffset + lb.text.length;
      if (offset >= lb.startOffset && offset <= end) {
        return lb;
      }
    }
    // Fallback to last line
    return block.lineBoxes[block.lineBoxes.length - 1] ?? null;
  }

  private updateVisualPosition(): void {
    const pos = this.getCaretPdfPosition();
    this.state.visualPosition = pos;
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
