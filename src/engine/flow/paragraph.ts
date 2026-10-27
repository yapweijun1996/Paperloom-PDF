/**
 * Paragraph reconstruction — group consecutive lines into paragraphs.
 */

import type { Paragraph, TextLine } from './types';

let paraIdCounter = 0;

function nextParaId(): string {
  paraIdCounter += 1;
  return `para-${paraIdCounter}`;
}

export function resetParagraphIdCounter(): void {
  paraIdCounter = 0;
}

/**
 * Group lines into paragraphs by left-margin similarity and vertical proximity.
 */
export function reconstructParagraphs(lines: TextLine[]): Paragraph[] {
  if (lines.length === 0) return [];

  const sorted = [...lines].sort((a, b) => b.baseline - a.baseline);
  const paragraphs: Paragraph[] = [];
  let current: TextLine[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const line = sorted[i];
    const marginDelta = Math.abs(line.leftMargin - prev.leftMargin);
    const verticalGap = prev.baseline - line.baseline;
    const lineHeight = Math.max(prev.height, line.height, prev.fontSize, line.fontSize);
    const marginTolerance = Math.max(8, prev.fontSize * 0.8);
    const gapTolerance = lineHeight * 2.8;

    if (marginDelta <= marginTolerance && verticalGap <= gapTolerance && verticalGap > 0) {
      current.push(line);
    } else {
      paragraphs.push(finalizeParagraph(current));
      current = [line];
    }
  }

  if (current.length > 0) {
    paragraphs.push(finalizeParagraph(current));
  }

  return paragraphs;
}

function finalizeParagraph(lines: TextLine[]): Paragraph {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let marginSum = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.x < minX) minX = line.x;
    if (line.rightEdge > maxX) maxX = line.rightEdge;
    if (line.y < minY) minY = line.y;
    if (line.y + line.height > maxY) maxY = line.y + line.height;
    marginSum += line.leftMargin;
  }

  return {
    id: nextParaId(),
    lines,
    leftMargin: marginSum / lines.length,
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}
