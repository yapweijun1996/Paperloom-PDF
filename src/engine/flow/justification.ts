/**
 * Justification analysis and space distribution.
 *
 * PDF justified lines encode extra space in TJ numeric arrays (thousandths of em)
 * and/or Tw (word spacing). This module analyzes gaps and computes even distribution.
 *
 * Maths:
 *   displacement = −n/1000 × fontSize × (Tz/100)   (PDF TJ spec)
 *   justified gap = (targetWidth − naturalWidth) / numWordBoundaries
 */

import type { TextRun } from '../content/interpreter';
import type { TextLine } from './types';
import { averageCharWidth, gapBetweenRuns, getRunBounds } from './metrics';

export interface JustificationAnalysis {
  naturalWidth: number;
  actualWidth: number;
  extraSpace: number;
  wordBoundaries: number;
  gaps: Array<{ betweenRuns: [number, number]; gap: number; isLarge: boolean }>;
}

/** Count word boundaries (spaces) across all runs on a line. */
export function countWordBoundaries(line: TextLine): number {
  let count = 0;
  for (let i = 0; i < line.text.length; i++) {
    if (line.text[i] === ' ') count++;
  }
  return count;
}

/** Analyze how space is distributed across a line's runs. */
export function analyzeJustification(line: TextLine): JustificationAnalysis {
  const gaps: JustificationAnalysis['gaps'] = [];
  let naturalWidth = 0;
  const avgCharW = line.runs.reduce((s, r) => s + averageCharWidth(r), 0) / Math.max(1, line.runs.length);
  const largeGapThreshold = Math.max(line.fontSize * 0.5, avgCharW * 1.8);

  for (let i = 0; i < line.runs.length; i++) {
    naturalWidth += getRunBounds(line.runs[i]).width;
    if (i < line.runs.length - 1) {
      const gap = gapBetweenRuns(line.runs[i], line.runs[i + 1]);
      gaps.push({
        betweenRuns: [i, i + 1],
        gap,
        isLarge: gap > largeGapThreshold,
      });
    }
  }

  const actualWidth = line.width;
  const extraSpace = Math.max(0, actualWidth - naturalWidth);

  return {
    naturalWidth,
    actualWidth,
    extraSpace,
    wordBoundaries: countWordBoundaries(line),
    gaps,
  };
}

/**
 * Compute per-gap justified spacing for even word distribution.
 * Returns gap adjustments in PDF units to add between runs.
 */
export function distributeJustifiedSpace(line: TextLine): number[] {
  const analysis = analyzeJustification(line);
  if (!line.isJustified || analysis.gaps.length === 0) {
    return analysis.gaps.map(g => g.gap);
  }

  const largeGaps = analysis.gaps.filter(g => g.isLarge);
  if (largeGaps.length === 0) return analysis.gaps.map(g => g.gap);

  const totalLargeGap = largeGaps.reduce((s, g) => s + g.gap, 0);
  const evenGap = totalLargeGap / largeGaps.length;

  return analysis.gaps.map(g => g.isLarge ? evenGap : g.gap);
}

/** TJ array spacing value (thousandths) for a gap in PDF units. */
export function gapToTJSpacing(gap: number, fontSize: number): number {
  if (fontSize <= 0) return 0;
  return Math.round(-(gap / fontSize) * 1000);
}

export interface GlueOptions {
  /** Minimum inter-word space as fraction of natural (default 0.8). */
  minStretch?: number;
  /** Maximum inter-word space as fraction of natural (default 1.5). */
  maxStretch?: number;
  /** Allow inter-letter spacing when word stretch is exhausted. */
  allowLetterSpacing?: boolean;
  /** Max extra letter spacing in ems (default 0.05). */
  maxLetterEm?: number;
}

/**
 * Distribute glue across word gaps (and optionally letters) to fill targetWidth.
 * Returns per-word-gap widths and optional uniform letter spacing.
 */
export function distributeGlue(
  targetWidth: number,
  wordWidths: number[],
  options: GlueOptions = {},
): { gaps: number[]; letterSpacing: number; naturalWidth: number } {
  const {
    minStretch = 0.8,
    maxStretch = 1.5,
    allowLetterSpacing = true,
    maxLetterEm = 0.05,
  } = options;

  const n = wordWidths.length;
  if (n === 0) return { gaps: [], letterSpacing: 0, naturalWidth: 0 };

  const naturalWidth = wordWidths.reduce((s, w) => s + w, 0);
  const spaceCount = Math.max(0, n - 1);
  if (spaceCount === 0) {
    return { gaps: [], letterSpacing: 0, naturalWidth };
  }

  // Assume natural space ≈ 0.25 × average word width
  const avgWord = naturalWidth / n;
  const naturalSpace = avgWord * 0.25;
  const naturalTotal = naturalWidth + spaceCount * naturalSpace;
  const extra = targetWidth - naturalTotal;

  let gap = naturalSpace + extra / spaceCount;
  const minGap = naturalSpace * minStretch;
  const maxGap = naturalSpace * maxStretch;
  let letterSpacing = 0;

  if (gap < minGap) {
    gap = minGap;
  } else if (gap > maxGap) {
    gap = maxGap;
    if (allowLetterSpacing) {
      const remaining = targetWidth - (naturalWidth + spaceCount * gap);
      const letterSlots = Math.max(1, wordWidths.reduce((s, w, i) => {
        // Approximate letter count from width
        return s + Math.max(1, Math.round(w / (avgWord * 0.1)));
      }, 0) - n);
      letterSpacing = Math.max(0, Math.min(remaining / letterSlots, avgWord * maxLetterEm));
    }
  }

  return {
    gaps: new Array(spaceCount).fill(gap),
    letterSpacing,
    naturalWidth: naturalTotal,
  };
}

const HANGING_PUNCT = new Set(['.', ',', ';', ':', '!', '?', '-', '–', '—', '"', "'", ')', ']', '»']);
const LEADING_HANG = new Set(['"', "'", '(', '[', '«']);

/**
 * Optical margin alignment — hang punctuation slightly outside the measure.
 * Adjusts glyph x positions in-place conceptually; returns dx per character index.
 */
export function opticalMarginAdjust(
  lineText: string,
  positions: number[],
  fontSize: number,
): number[] {
  const dx = new Array(Math.max(positions.length, lineText.length)).fill(0);
  if (lineText.length === 0 || positions.length === 0) return dx;

  const hang = fontSize * 0.35;
  const first = lineText[0];
  const last = lineText[lineText.length - 1];

  if (LEADING_HANG.has(first)) {
    dx[0] = -hang * 0.6;
  }
  if (HANGING_PUNCT.has(last)) {
    const i = Math.min(positions.length - 1, lineText.length - 1);
    dx[i] = hang * 0.5;
  }
  return dx;
}
