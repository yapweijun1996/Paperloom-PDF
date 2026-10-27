/**
 * Bloom compile — strip owned text ops for edited blocks, append clean BT/ET.
 */

import { parseContentStream, type CSInstruction } from '../content/operator-lexer';
import { PDFName, PDFNumber, PDFString, type PDFObject, type PDFPageInfo } from '../types';
import { compileInstructions, encodeTextForFont, loadFontForName } from '../editor/text-editor';
import { ensureFallbackFont } from '../fonts/font-augmentation';
import type { BloomBlock, BloomPage } from './types';
import { blockPlainText } from './types';

const TEXT_SHOWING = new Set(['Tj', 'TJ', "'", '"']);

export function stripOwnedTextOps(
  instructions: CSInstruction[],
  ownedIndices: Set<number>,
): CSInstruction[] {
  const out: CSInstruction[] = [];
  for (let i = 0; i < instructions.length; i++) {
    const inst = instructions[i];
    if (ownedIndices.has(i) && TEXT_SHOWING.has(inst.operator)) {
      continue;
    }
    out.push(inst);
  }
  return out;
}

export function collectOwnedIndices(page: BloomPage): Set<number> {
  const set = new Set<number>();
  for (const block of page.blocks) {
    for (const idx of block.sourceInstructionIndices) set.add(idx);
  }
  return set;
}

function collectBlockIndices(block: BloomBlock): Set<number> {
  return new Set(block.sourceInstructionIndices);
}

function pickFontName(block: BloomBlock, pageInfo: PDFPageInfo, objects: Map<string, PDFObject>): string {
  const preferred = block.runs[0]?.fontName;
  if (preferred) {
    const font = loadFontForName(preferred, pageInfo, objects);
    if (font) return preferred;
  }
  try {
    return ensureFallbackFont(pageInfo, objects);
  } catch {
    return preferred || 'F1';
  }
}

function emitBlockInstructions(
  block: BloomBlock,
  fontName: string,
  pageInfo: PDFPageInfo,
  objects: Map<string, PDFObject>,
): CSInstruction[] {
  const ops: CSInstruction[] = [];
  const fontData = loadFontForName(fontName, pageInfo, objects);

  ops.push({ operator: 'BT', operands: [], offset: 0 });

  for (const lb of block.lineBoxes) {
    const text = lb.text;
    if (!text) continue;

    const fontSize = lb.fontSize || block.runs[0]?.fontSize || 12;
    const [r, g, b] = block.runs[0]?.color ?? [0, 0, 0];

    ops.push({
      operator: 'rg',
      operands: [new PDFNumber(r), new PDFNumber(g), new PDFNumber(b)],
      offset: 0,
    });
    ops.push({
      operator: 'Tf',
      operands: [new PDFName(fontName), new PDFNumber(fontSize)],
      offset: 0,
    });
    ops.push({
      operator: 'Tm',
      operands: [
        new PDFNumber(1), new PDFNumber(0),
        new PDFNumber(0), new PDFNumber(1),
        new PDFNumber(lb.x), new PDFNumber(lb.baseline),
      ],
      offset: 0,
    });

    let pdfString: PDFObject;
    if (fontData) {
      const encoded = encodeTextForFont(text, fontData);
      pdfString = encoded.pdfString;
    } else {
      pdfString = new PDFString(text);
    }

    ops.push({
      operator: 'Tj',
      operands: [pdfString],
      offset: 0,
    });
  }

  ops.push({ operator: 'ET', operands: [], offset: 0 });
  return ops;
}

export interface CompilePageResult {
  newContentBytes: Uint8Array;
  blockCount: number;
}

/**
 * Compile only the given blocks (safe edit path).
 * Leaves all other page text untouched.
 */
export function compileBlocks(
  contentBytes: Uint8Array,
  blocks: BloomBlock[],
  pageInfo: PDFPageInfo,
  objects: Map<string, PDFObject>,
): CompilePageResult {
  const instructions = parseContentStream(contentBytes);
  const owned = new Set<number>();
  for (const block of blocks) {
    for (const idx of collectBlockIndices(block)) owned.add(idx);
  }
  const stripped = stripOwnedTextOps(instructions, owned);

  const bloomOps: CSInstruction[] = [];
  for (const block of blocks) {
    if (!blockPlainText(block) && block.lineBoxes.every(l => !l.text)) continue;
    const fontName = pickFontName(block, pageInfo, objects);
    bloomOps.push(...emitBlockInstructions(block, fontName, pageInfo, objects));
  }

  return {
    newContentBytes: compileInstructions([...stripped, ...bloomOps]),
    blockCount: blocks.length,
  };
}

/**
 * Full-page compile — prefer compileBlocks for edits.
 */
export function compilePage(
  contentBytes: Uint8Array,
  bloomPage: BloomPage,
  pageInfo: PDFPageInfo,
  objects: Map<string, PDFObject>,
): CompilePageResult {
  return compileBlocks(contentBytes, bloomPage.blocks, pageInfo, objects);
}

export function compilePageAndClearDirty(
  contentBytes: Uint8Array,
  bloomPage: BloomPage,
  pageInfo: PDFPageInfo,
  objects: Map<string, PDFObject>,
): { result: CompilePageResult; page: BloomPage } {
  const result = compilePage(contentBytes, bloomPage, pageInfo, objects);
  return {
    result,
    page: { ...bloomPage, dirty: false },
  };
}

export function compileBlocksAndClearDirty(
  contentBytes: Uint8Array,
  bloomPage: BloomPage,
  blockIds: string[],
  pageInfo: PDFPageInfo,
  objects: Map<string, PDFObject>,
): { result: CompilePageResult; page: BloomPage } {
  const blocks = bloomPage.blocks.filter(b => blockIds.includes(b.id));
  const result = compileBlocks(contentBytes, blocks, pageInfo, objects);
  return {
    result,
    page: { ...bloomPage, dirty: false },
  };
}
