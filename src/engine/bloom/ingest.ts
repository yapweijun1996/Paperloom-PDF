/**
 * Bloom ingest — PDF text runs / flow → Word-like BloomPage.
 *
 * v1: one block per flow line, preserving PDF baselines.
 * Reflow only happens later when the user edits a block.
 */

import type { TextRun, ImageItem, DisplayItem } from '../content/interpreter';
import { buildDocumentFlow } from '../flow/index';
import type { DocumentFlow, TextLine } from '../flow/types';
import { averageCharWidth, getRunBounds } from '../flow/metrics';
import type {
  BloomBlock,
  BloomBlockKind,
  BloomDocument,
  BloomFrame,
  BloomLineBox,
  BloomPage,
  BloomRun,
} from './types';

let blockIdCounter = 0;
let frameIdCounter = 0;

export function resetBloomIds(): void {
  blockIdCounter = 0;
  frameIdCounter = 0;
}

function nextBlockId(): string {
  blockIdCounter += 1;
  return `bloom-blk-${blockIdCounter}`;
}

function nextFrameId(): string {
  frameIdCounter += 1;
  return `bloom-frm-${frameIdCounter}`;
}

function inferKind(line: TextLine, fontSize: number): BloomBlockKind {
  if (fontSize >= 16) return 'heading';
  if (/^[\u2022\u25CF\u2023\-\*]\s/.test(line.text) || /^\d+\.\s/.test(line.text)) {
    return 'list-item';
  }
  return 'paragraph';
}

function headingLevel(fontSize: number): number {
  if (fontSize >= 24) return 1;
  if (fontSize >= 20) return 2;
  if (fontSize >= 16) return 3;
  return 4;
}

function looksBold(fontName: string): boolean {
  const n = fontName.toLowerCase();
  return n.includes('bold') || n.includes('black') || n.includes('heavy');
}

function looksItalic(fontName: string): boolean {
  const n = fontName.toLowerCase();
  return n.includes('italic') || n.includes('oblique');
}

function runToBloomRun(run: TextRun): BloomRun {
  return {
    text: run.text,
    fontName: run.fontName,
    fontSize: run.fontSize || 12,
    bold: looksBold(run.fontName),
    italic: looksItalic(run.fontName),
    underline: !!run.isUnderline,
    color: [...run.fillColor] as [number, number, number],
    avgCharWidth: averageCharWidth(run),
  };
}

function mergeAdjacentRuns(runs: BloomRun[]): BloomRun[] {
  if (runs.length === 0) return [];
  const out: BloomRun[] = [{ ...runs[0] }];
  for (let i = 1; i < runs.length; i++) {
    const prev = out[out.length - 1];
    const cur = runs[i];
    if (
      prev.fontName === cur.fontName &&
      prev.fontSize === cur.fontSize &&
      prev.bold === cur.bold &&
      prev.italic === cur.italic &&
      prev.underline === cur.underline &&
      prev.color[0] === cur.color[0] &&
      prev.color[1] === cur.color[1] &&
      prev.color[2] === cur.color[2]
    ) {
      prev.text += cur.text;
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

function collectSourceIndices(line: TextLine): number[] {
  const set = new Set<number>();
  for (const run of line.runs) {
    for (const i of run.sourceInstructionIndices ?? []) set.add(i);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * One Bloom block per PDF flow line — keeps original baseline/x so the
 * page looks identical until the user edits.
 */
function lineToBlock(line: TextLine): BloomBlock {
  const runs: BloomRun[] = [];
  for (const seg of line.segments) {
    if (!seg.text) continue;
    const br = runToBloomRun(seg.run);
    br.text = seg.text;
    runs.push(br);
  }
  const merged = mergeAdjacentRuns(runs);
  const fontSize = line.fontSize || 12;
  const lineHeight = Math.max(fontSize * 1.2, line.height || fontSize * 1.2);

  let top = line.baseline + fontSize * 0.85;
  let bottom = line.baseline - fontSize * 0.25;
  if (line.runs[0]) {
    const b = getRunBounds(line.runs[0]);
    top = Math.max(top, b.top);
    bottom = Math.min(bottom, b.bottom);
  }

  const contentWidth = Math.max(40, line.rightEdge - line.leftMargin);
  const kind = inferKind(line, fontSize);

  const lineBox: BloomLineBox = {
    text: line.text,
    startOffset: 0,
    x: line.x,
    baseline: line.baseline,
    width: line.width,
    height: lineHeight,
    fontSize,
    runs: merged.length > 0 ? merged : [{
      text: line.text,
      fontName: line.runs[0]?.fontName || 'F1',
      fontSize,
      bold: false,
      italic: false,
      underline: false,
      color: [0, 0, 0],
      avgCharWidth: fontSize * 0.5,
    }],
  };

  return {
    id: nextBlockId(),
    kind,
    level: kind === 'heading' ? headingLevel(fontSize) : undefined,
    runs: lineBox.runs.map(r => ({ ...r })),
    box: {
      x: line.leftMargin,
      y: bottom,
      width: contentWidth,
      height: Math.max(lineHeight, top - bottom),
    },
    align: line.isJustified ? 'justify' : 'left',
    lineHeight,
    listMarker:
      kind === 'list-item'
        ? line.text.match(/^([\u2022\u25CF\u2023\-\*]|\d+\.)/)?.[1]
        : undefined,
    sourceInstructionIndices: collectSourceIndices(line),
    lineBoxes: [lineBox],
  };
}

function framesFromDisplayList(displayList: DisplayItem[]): BloomFrame[] {
  const frames: BloomFrame[] = [];
  for (const item of displayList) {
    if (item.type !== 'image') continue;
    const img = item as ImageItem;
    frames.push({
      id: nextFrameId(),
      kind: 'image',
      name: img.name,
      box: { x: img.x, y: img.y, width: img.width, height: img.height },
    });
  }
  return frames;
}

export interface IngestPageOptions {
  pageIndex: number;
  width: number;
  height: number;
  flow?: DocumentFlow;
  displayList?: DisplayItem[];
}

/**
 * Ingest PDF page text into a BloomPage.
 * Preserves PDF line geometry — no reflow until edit.
 */
export function ingestPage(runs: TextRun[], options: IngestPageOptions): BloomPage {
  resetBloomIds();
  const flow = options.flow ?? buildDocumentFlow(runs);
  const blocks = flow.lines.map(lineToBlock);
  const frames = options.displayList ? framesFromDisplayList(options.displayList) : [];

  return {
    sourcePageIndex: options.pageIndex,
    width: options.width,
    height: options.height,
    blocks,
    frames,
    dirty: false,
  };
}

export function ingestDocument(
  pages: Array<{ runs: TextRun[]; options: IngestPageOptions }>,
): BloomDocument {
  return {
    pages: pages.map(p => ingestPage(p.runs, p.options)),
  };
}
