/**
 * Word-Like Text Editing — Core Data Models
 *
 * Type definitions for editing state, including caret positioning, selection,
 * transactions, layout planning, and edit results for surgical PDF content
 * stream modification.
 *
 * **Architecture**: These types support the three-layer editing system:
 * 1. HTML Overlay Layer — immediate visual feedback
 * 2. Bloom Engine — document model for hit-testing and layout
 * 3. Surgical Edit Layer — direct content stream modification
 */

import type { BloomCaret, BloomSelection } from '../bloom/types';
import type { TextRun } from '../content/interpreter';
import type { TextLine } from '../flow/types';

// ─── Caret State ────────────────────────────────────────────────────────────

/**
 * Tracks the current text insertion point (caret) position and visual state.
 *
 * The caret is the blinking cursor that indicates where new characters will be
 * inserted. This state includes both the logical position (block ID + offset)
 * and the visual position for rendering the caret overlay.
 *
 * **Validates Requirements**: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7
 */
export interface CaretState {
  /** Current position in document (block ID + character offset). */
  caret: BloomCaret | null;

  /** Visual position in PDF coordinates for rendering caret. */
  visualPosition: {
    /** X coordinate in PDF units. */
    x: number;
    /** Y coordinate (baseline) in PDF units. */
    y: number;
    /** Height of the caret line in PDF units. */
    height: number;
  } | null;

  /** Whether the caret is currently visible (for blink animation). */
  isVisible: boolean;

  /** Timer ID for blink animation (530ms interval). */
  blinkTimer: number | null;

  /** Preferred X position for vertical movement (preserves column on up/down). */
  preferredX: number | null;
}

// ─── Selection State ────────────────────────────────────────────────────────

/**
 * Tracks text selection range and selection interaction state.
 *
 * Selection spans from an anchor point (where selection started) to a focus
 * point (current position during drag). The range can be normalized to
 * [min, max] regardless of drag direction.
 *
 * **Validates Requirements**: 4.1, 4.2, 4.3, 4.4, 4.5
 */
export interface SelectionState {
  /** Selection range (null if no active selection). */
  selection: BloomSelection | null;

  /** Whether currently dragging to extend selection. */
  isSelecting: boolean;

  /** Anchor point saved for shift+arrow extend operations. */
  anchorCaret: BloomCaret | null;
}

// ─── Edit Transaction ───────────────────────────────────────────────────────

/**
 * Represents a single edit operation that can be undone/redone.
 *
 * Each transaction captures the PDF content stream state before an edit,
 * allowing the editor to restore previous states. Transactions are stored
 * in an undo/redo stack with a maximum size (default 50).
 *
 * **Validates Requirements**: 8.1, 8.2, 8.3, 8.4, 8.5
 */
export interface EditTransaction {
  /** Page index being edited (0-based). */
  pageIndex: number;

  /** Content stream bytes before edit (for undo). */
  contentBytes: Uint8Array;

  /** Human-readable label for debugging (e.g., "Insert 'a'", "Delete word"). */
  label: string;

  /** Timestamp when transaction was created (milliseconds since epoch). */
  timestamp: number;
}

// ─── Layout Plan ────────────────────────────────────────────────────────────

/**
 * Plan for reflow and content stream edits after text modification.
 *
 * When text length changes, the layout engine calculates:
 * - Which lines need new text content (line edits)
 * - Which runs need horizontal position shifts (multi-run alignment)
 * - Preview of wrapped lines for validation
 *
 * This plan is used by the commit engine to perform surgical edits.
 *
 * **Validates Requirements**: 2.2, 3.5, 6.1, 6.2, 6.3, 6.4, 6.5
 */
export interface LayoutPlan {
  /** Lines that need content stream text operator updates. */
  lineEdits: LineEdit[];

  /** Runs that need position shifts (Tm/Td operator updates). */
  shifts: RunPositionShift[];

  /** Preview of wrapped lines (for debugging and validation). */
  previewLines: string[];
}

/**
 * Specifies a text edit for a single line.
 *
 * Maps a TextLine to its new text content after editing. The commit engine
 * uses this to replace Tj/TJ operators in the PDF content stream.
 */
export interface LineEdit {
  /** The line to edit (contains original runs and position). */
  line: TextLine;

  /** New text content for this line (after insertion/deletion/reflow). */
  newText: string;
}

/**
 * Specifies a horizontal position shift for a text run.
 *
 * When text length changes within a multi-run line, subsequent runs must be
 * shifted horizontally to maintain alignment. The commit engine applies these
 * shifts by updating Tm (text matrix) operators.
 *
 * **Note**: Vertical shifts (dy) are typically 0 for single-line edits but
 * may be non-zero for multi-line reflow operations.
 */
export interface RunPositionShift {
  /** The run to shift (contains original position and style). */
  run: TextRun;

  /** Horizontal shift in PDF units (positive = right, negative = left). */
  dx: number;

  /** Vertical shift in PDF units (positive = up in PDF y-up coordinates). */
  dy: number;
}

// ─── Edit Result ────────────────────────────────────────────────────────────

/**
 * Result of a surgical edit operation on a PDF content stream.
 *
 * After applying text edits, this result indicates:
 * - The new content stream bytes (modified Tj/TJ operators)
 * - Whether font augmentation is needed (characters not in font encoding)
 * - List of missing character codes for background font processing
 *
 * **Validates Requirements**: 8.3, 11.1, 11.4, 11.5
 */
export interface EditResult {
  /** Modified PDF content stream bytes (ready to write to page). */
  newContentBytes: Uint8Array;

  /** Whether font augmentation is needed for missing glyphs. */
  needsFontAugmentation: boolean;

  /** Character codes not found in font encoding (for augmentation). */
  missingCharCodes: number[];
}
