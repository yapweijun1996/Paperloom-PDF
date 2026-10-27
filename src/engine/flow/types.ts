/**
 * Document flow model — logical lines and paragraphs built from PDF glyph runs.
 *
 * PDF stores absolutely-positioned runs (bold/regular are separate operators).
 * The flow layer reconstructs reading order so editing works like Word.
 */

import type { TextRun } from '../content/interpreter';

/** A styled fragment within a line (maps to one PDF text-showing instruction). */
export interface StyledSegment {
  run: TextRun;
  startIndex: number;
  endIndex: number;
  text: string;
}

/** A logical line of text — may contain multiple styled runs (bold, regular, etc.). */
export interface TextLine {
  id: string;
  runs: TextRun[];
  /** Full line text (all runs concatenated). */
  text: string;
  segments: StyledSegment[];
  baseline: number;
  x: number;
  y: number;
  width: number;
  height: number;
  leftMargin: number;
  rightEdge: number;
  fontSize: number;
  /** True when inter-run gaps suggest full justification. */
  isJustified: boolean;
  /** Index of last run in the left column before a tab-to-right gap (-1 if none). */
  tabSplitIndex: number;
}

/** A paragraph — consecutive lines with similar left margin. */
export interface Paragraph {
  id: string;
  lines: TextLine[];
  leftMargin: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Full document flow for one page. */
export interface DocumentFlow {
  lines: TextLine[];
  paragraphs: Paragraph[];
  /** Original runs in content-stream order. */
  rawRuns: TextRun[];
}

/** Result of distributing edited line text back to styled runs. */
export interface SegmentEdit {
  run: TextRun;
  newText: string;
}
