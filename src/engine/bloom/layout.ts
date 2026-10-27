/**
 * Bloom layout — Word-like measure / wrap inside a block's content box.
 *
 * Important: do NOT reflow the whole page on ingest. Only reflow a block
 * when its text changes (edit path). layoutPage is a no-op passthrough
 * unless a block has empty lineBoxes.
 */

import { greedyWrap } from '../flow/line-break';
import type { BloomBlock, BloomLineBox, BloomPage, BloomRun } from './types';
import { blockPlainText } from './types';

/** Measure a string using the dominant run metrics of a block. */
export function measureWithRuns(text: string, runs: BloomRun[]): number {
  if (!text) return 0;
  if (runs.length === 0) return text.length * 6;

  let totalChars = 0;
  let weighted = 0;
  for (const r of runs) {
    const n = Math.max(1, r.text.length);
    totalChars += n;
    weighted += r.avgCharWidth * n;
  }
  const avg = totalChars > 0 ? weighted / totalChars : (runs[0].avgCharWidth || runs[0].fontSize * 0.5);
  return text.length * avg;
}

/**
 * Map a substring of block plain text back onto styled runs.
 */
export function sliceRunsForRange(
  runs: BloomRun[],
  start: number,
  end: number,
): BloomRun[] {
  const out: BloomRun[] = [];
  let cursor = 0;
  for (const run of runs) {
    const runStart = cursor;
    const runEnd = cursor + run.text.length;
    cursor = runEnd;
    if (runEnd <= start || runStart >= end) continue;
    const sliceStart = Math.max(0, start - runStart);
    const sliceEnd = Math.min(run.text.length, end - runStart);
    if (sliceStart >= sliceEnd) continue;
    out.push({
      ...run,
      text: run.text.slice(sliceStart, sliceEnd),
    });
  }
  if (out.length === 0 && runs[0]) {
    out.push({ ...runs[0], text: '' });
  }
  return out;
}

function findLineEndInPlain(plain: string, offset: number, wrappedLine: string): number {
  const target = wrappedLine.replace(/\s+/g, ' ').trim();
  if (!target) return offset;

  const words = target.split(' ');
  let i = offset;
  let wordIdx = 0;
  while (i < plain.length && wordIdx < words.length) {
    while (i < plain.length && /\s/.test(plain[i])) i += 1;
    const word = words[wordIdx];
    if (plain.slice(i, i + word.length) === word) {
      i += word.length;
      wordIdx += 1;
    } else {
      return Math.min(plain.length, offset + wrappedLine.length + 1);
    }
  }
  return i;
}

/**
 * Reflow one block into lineBoxes inside its content box.
 * Keeps the block's top edge fixed (PDF y-up) and grows downward.
 */
export function layoutBlock(block: BloomBlock): BloomBlock {
  const plain = blockPlainText(block);
  const maxWidth = Math.max(20, block.box.width);
  const measure = (s: string) => measureWithRuns(s, block.runs);
  const wrapped = plain.length === 0 ? [''] : greedyWrap(plain, maxWidth, measure);

  const fontSize = block.runs[0]?.fontSize || 12;
  const lineHeight = block.lineHeight || fontSize * 1.2;
  const top = block.box.y + block.box.height;

  let offset = 0;
  const lineBoxes: BloomLineBox[] = [];

  for (let i = 0; i < wrapped.length; i++) {
    let lineText = wrapped[i];
    if (i < wrapped.length - 1) {
      const nextStart = findLineEndInPlain(plain, offset, lineText);
      lineText = plain.slice(offset, nextStart).replace(/\s+$/, '') || lineText;
      const baseline = top - fontSize * 0.85 - i * lineHeight;
      lineBoxes.push({
        text: lineText,
        startOffset: offset,
        x: block.box.x,
        baseline,
        width: measure(lineText),
        height: lineHeight,
        fontSize,
        runs: sliceRunsForRange(block.runs, offset, offset + lineText.length),
      });
      offset = nextStart;
      while (offset < plain.length && /\s/.test(plain[offset])) offset += 1;
    } else {
      lineText = plain.slice(offset);
      const baseline = top - fontSize * 0.85 - i * lineHeight;
      lineBoxes.push({
        text: lineText,
        startOffset: offset,
        x: block.box.x,
        baseline,
        width: measure(lineText),
        height: lineHeight,
        fontSize,
        runs: sliceRunsForRange(block.runs, offset, plain.length),
      });
      offset = plain.length;
    }
  }

  if (lineBoxes.length === 0) {
    lineBoxes.push({
      text: '',
      startOffset: 0,
      x: block.box.x,
      baseline: top - fontSize * 0.85,
      width: 0,
      height: lineHeight,
      fontSize,
      runs: sliceRunsForRange(block.runs, 0, 0),
    });
  }

  const lastBaseline = lineBoxes[lineBoxes.length - 1].baseline;
  const newHeight = Math.max(lineHeight, top - (lastBaseline - fontSize * 0.25));

  return {
    ...block,
    lineBoxes,
    box: {
      ...block.box,
      height: newHeight,
      y: top - newHeight,
    },
  };
}

/**
 * Layout page: only fill missing lineBoxes. Never cascade/push other blocks
 * (that was collapsing resumes into overlapping bands).
 */
export function layoutPage(page: BloomPage): BloomPage {
  const blocks = page.blocks.map(block => {
    if (block.lineBoxes.length > 0) return block;
    return layoutBlock(block);
  });
  return { ...page, blocks };
}
