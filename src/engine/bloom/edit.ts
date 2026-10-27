/**
 * Bloom edit — Word-like insert / delete / replace at caret, then reflow.
 */

import type { BloomBlock, BloomCaret, BloomPage, BloomRun } from './types';
import { blockPlainText } from './types';
import { layoutPage } from './layout';

function findBlock(page: BloomPage, blockId: string): BloomBlock | undefined {
  return page.blocks.find(b => b.id === blockId);
}

/**
 * Replace the entire plain text of a block, preserving the first run's style
 * (Word-like: typing into a paragraph keeps the active style).
 */
export function setBlockText(block: BloomBlock, newText: string): BloomBlock {
  const style = block.runs[0] ?? {
    text: '',
    fontName: 'F1',
    fontSize: 12,
    bold: false,
    italic: false,
    underline: false,
    color: [0, 0, 0] as [number, number, number],
    avgCharWidth: 6,
  };
  const runs: BloomRun[] = [{ ...style, text: newText }];

  // Keep single-line geometry when text still fits on one line (no collapse)
  const maxWidth = Math.max(20, block.box.width);
  const avg = style.avgCharWidth || style.fontSize * 0.5;
  const fits = newText.length * avg <= maxWidth * 1.05;
  const top = block.box.y + block.box.height;
  const fontSize = style.fontSize || 12;
  const lineHeight = block.lineHeight || fontSize * 1.2;

  if (fits || newText.length === 0) {
    const baseline = block.lineBoxes[0]?.baseline ?? top - fontSize * 0.85;
    const x = block.lineBoxes[0]?.x ?? block.box.x;
    return {
      ...block,
      runs,
      lineBoxes: [{
        text: newText,
        startOffset: 0,
        x,
        baseline,
        width: newText.length * avg,
        height: lineHeight,
        fontSize,
        runs: [{ ...style, text: newText }],
      }],
    };
  }

  // Multi-line: clear lineBoxes so layoutBlock reflows, keeping top edge
  return { ...block, runs, lineBoxes: [] };
}

/**
 * Insert text at caret offset inside a block.
 */
export function insertTextAtCaret(
  page: BloomPage,
  caret: BloomCaret,
  text: string,
): { page: BloomPage; caret: BloomCaret } {
  const block = findBlock(page, caret.blockId);
  if (!block) return { page, caret };

  const plain = blockPlainText(block);
  const offset = Math.max(0, Math.min(caret.offset, plain.length));
  const nextText = plain.slice(0, offset) + text + plain.slice(offset);
  const updated = setBlockText(block, nextText);
  const blocks = page.blocks.map(b => (b.id === block.id ? updated : b));
  const nextPage = layoutPage({ ...page, blocks, dirty: true });
  return {
    page: nextPage,
    caret: { blockId: caret.blockId, offset: offset + text.length },
  };
}

/**
 * Delete `count` characters before the caret (backspace) or after (delete).
 */
export function deleteTextAtCaret(
  page: BloomPage,
  caret: BloomCaret,
  count: number = 1,
  forward: boolean = false,
): { page: BloomPage; caret: BloomCaret } {
  const block = findBlock(page, caret.blockId);
  if (!block || count <= 0) return { page, caret };

  const plain = blockPlainText(block);
  const offset = Math.max(0, Math.min(caret.offset, plain.length));

  let start: number;
  let end: number;
  let newOffset: number;
  if (forward) {
    start = offset;
    end = Math.min(plain.length, offset + count);
    newOffset = offset;
  } else {
    start = Math.max(0, offset - count);
    end = offset;
    newOffset = start;
  }

  if (start === end) return { page, caret };

  const nextText = plain.slice(0, start) + plain.slice(end);
  const updated = setBlockText(block, nextText);
  const blocks = page.blocks.map(b => (b.id === block.id ? updated : b));
  const nextPage = layoutPage({ ...page, blocks, dirty: true });
  return {
    page: nextPage,
    caret: { blockId: caret.blockId, offset: newOffset },
  };
}

/**
 * Replace a range [start, end) in a block with `text`.
 */
export function replaceRange(
  page: BloomPage,
  blockId: string,
  start: number,
  end: number,
  text: string,
): { page: BloomPage; caret: BloomCaret } {
  const block = findBlock(page, blockId);
  if (!block) {
    return { page, caret: { blockId, offset: start } };
  }

  const plain = blockPlainText(block);
  const s = Math.max(0, Math.min(start, plain.length));
  const e = Math.max(s, Math.min(end, plain.length));
  const nextText = plain.slice(0, s) + text + plain.slice(e);
  const updated = setBlockText(block, nextText);
  const blocks = page.blocks.map(b => (b.id === block.id ? updated : b));
  const nextPage = layoutPage({ ...page, blocks, dirty: true });
  return {
    page: nextPage,
    caret: { blockId, offset: s + text.length },
  };
}

/**
 * Replace entire block text (used when the editor commits a line/block edit).
 */
export function replaceBlockText(
  page: BloomPage,
  blockId: string,
  newText: string,
): BloomPage {
  const block = findBlock(page, blockId);
  if (!block) return page;
  const updated = setBlockText(block, newText);
  const blocks = page.blocks.map(b => (b.id === block.id ? updated : b));
  return layoutPage({ ...page, blocks, dirty: true });
}

/**
 * Hit-test: find block and caret offset from PDF page coordinates.
 */
export function hitTestBloomPage(
  page: BloomPage,
  pdfX: number,
  pdfY: number,
): BloomCaret | null {
  for (const block of page.blocks) {
    const { box } = block;
    const pad = 4;
    if (
      pdfX >= box.x - pad &&
      pdfX <= box.x + box.width + pad &&
      pdfY >= box.y - pad &&
      pdfY <= box.y + box.height + pad
    ) {
      // Find nearest line box
      let bestLine = block.lineBoxes[0];
      let bestDist = Infinity;
      for (const lb of block.lineBoxes) {
        const d = Math.abs(pdfY - lb.baseline);
        if (d < bestDist) {
          bestDist = d;
          bestLine = lb;
        }
      }
      if (!bestLine) {
        return { blockId: block.id, offset: blockPlainText(block).length };
      }

      const localX = pdfX - bestLine.x;
      const avg =
        bestLine.runs[0]?.avgCharWidth ||
        bestLine.fontSize * 0.5 ||
        6;
      let col = Math.round(localX / avg);
      col = Math.max(0, Math.min(bestLine.text.length, col));
      return { blockId: block.id, offset: bestLine.startOffset + col };
    }
  }
  return null;
}

/**
 * Nearest block by baseline distance (for clicks near text).
 */
export function findNearestBlock(
  page: BloomPage,
  pdfX: number,
  pdfY: number,
  maxDist: number = 40,
): BloomCaret | null {
  let best: BloomCaret | null = null;
  let bestScore = Infinity;

  for (const block of page.blocks) {
    for (const lb of block.lineBoxes) {
      const dy = Math.abs(pdfY - lb.baseline);
      const dx =
        pdfX < lb.x
          ? lb.x - pdfX
          : pdfX > lb.x + lb.width
            ? pdfX - (lb.x + lb.width)
            : 0;
      const score = dy + dx * 0.25;
      if (score < bestScore && dy < maxDist) {
        bestScore = score;
        const avg = lb.runs[0]?.avgCharWidth || lb.fontSize * 0.5 || 6;
        let col = Math.round((pdfX - lb.x) / avg);
        col = Math.max(0, Math.min(lb.text.length, col));
        best = { blockId: block.id, offset: lb.startOffset + col };
      }
    }
  }
  return best;
}

/** Caret PDF position for drawing. */
export function caretPdfPosition(
  page: BloomPage,
  caret: BloomCaret,
): { x: number; y: number; height: number } | null {
  const block = findBlock(page, caret.blockId);
  if (!block) return null;

  for (const lb of block.lineBoxes) {
    const end = lb.startOffset + lb.text.length;
    if (caret.offset >= lb.startOffset && caret.offset <= end) {
      const col = caret.offset - lb.startOffset;
      const avg = lb.runs[0]?.avgCharWidth || lb.fontSize * 0.5 || 6;
      return {
        x: lb.x + col * avg,
        y: lb.baseline,
        height: lb.fontSize,
      };
    }
  }

  const last = block.lineBoxes[block.lineBoxes.length - 1];
  if (last) {
    return {
      x: last.x + last.width,
      y: last.baseline,
      height: last.fontSize,
    };
  }
  return {
    x: block.box.x,
    y: block.box.y + block.box.height * 0.5,
    height: block.runs[0]?.fontSize || 12,
  };
}
