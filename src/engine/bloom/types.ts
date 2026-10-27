/**
 * Bloom Engine — Word-like document model.
 *
 * PDF glyph runs are ingested into blocks/runs; editing reflows inside
 * content boxes; compile emits clean BT/ET (no in-place TJ patching).
 */

/** Styled inline span (Word "run"). */
export interface BloomRun {
  text: string;
  fontName: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: [number, number, number];
  /** Average char width in page units (from source run metrics). */
  avgCharWidth: number;
}

export type BloomBlockKind = 'heading' | 'paragraph' | 'list-item';

export type BloomAlign = 'left' | 'center' | 'right' | 'justify';

export interface BloomBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One laid-out visual line inside a block. */
export interface BloomLineBox {
  text: string;
  /** Character offset into block plain text where this line starts. */
  startOffset: number;
  x: number;
  /** Baseline in PDF y-up coordinates. */
  baseline: number;
  width: number;
  height: number;
  fontSize: number;
  /** Run slices covering this line (for multi-style lines). */
  runs: BloomRun[];
}

/** Paragraph / heading / list item — Word-like block. */
export interface BloomBlock {
  id: string;
  kind: BloomBlockKind;
  level?: number;
  runs: BloomRun[];
  /** Content box (reflow width). y is bottom of first-line baseline area. */
  box: BloomBox;
  align: BloomAlign;
  lineHeight: number;
  listMarker?: string;
  /** Original PDF text-showing instruction indices owned by this block. */
  sourceInstructionIndices: number[];
  /** Laid out after layoutPage(). */
  lineBoxes: BloomLineBox[];
}

/** Non-text frame (image) kept for hybrid layout. */
export interface BloomFrame {
  id: string;
  kind: 'image';
  name: string;
  box: BloomBox;
}

export interface BloomPage {
  sourcePageIndex: number;
  width: number;
  height: number;
  blocks: BloomBlock[];
  frames: BloomFrame[];
  /** Dirty when Bloom text differs from last compile. */
  dirty: boolean;
}

export interface BloomDocument {
  pages: BloomPage[];
}

/** Caret inside a block (Unicode code-unit index into block plain text). */
export interface BloomCaret {
  blockId: string;
  offset: number;
}

export interface BloomSelection {
  start: BloomCaret;
  end: BloomCaret;
}

/** Plain text of a block (concatenation of runs). */
export function blockPlainText(block: { runs: { text: string }[] }): string {
  return block.runs.map(r => r.text).join('');
}
