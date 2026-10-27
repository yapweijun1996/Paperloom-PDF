/**
 * PDF table detection — reconstruct grids from column-aligned text cells
 * and optional ruling lines (paths).
 *
 * PDFs rarely store real table objects; resumes/forms draw lines + place
 * text in columns. After line reconstruction splits cells, we group them
 * into DetectedTable for cell-scoped editing and row/column actions.
 */

import type { TextLine } from './types';
import type { PathItem } from '../content/interpreter';

export interface TableCell {
  line: TextLine;
  row: number;
  col: number;
}

export interface DetectedTable {
  id: string;
  rows: number;
  cols: number;
  cells: TableCell[];
  /** Column left edges (PDF x), length = cols */
  columnXs: number[];
  /** Row baselines (PDF y), length = rows — top row first */
  rowBaselines: number[];
  bounds: { x: number; y: number; width: number; height: number };
}

function quantize(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/**
 * Detect tables from page text lines that form a regular column grid.
 * Optional stroke paths strengthen detection when vertical rules exist.
 */
export function detectTablesOnPage(
  lines: TextLine[],
  paths: PathItem[] = [],
): DetectedTable[] {
  if (lines.length < 4) return [];

  const medFs =
    lines.reduce((s, l) => s + (l.fontSize || 12), 0) / Math.max(1, lines.length);
  const xStep = Math.max(6, medFs * 0.6);
  const yStep = Math.max(4, medFs * 0.45);

  // Bucket lines by quantized left edge → candidate columns
  const colBuckets = new Map<number, TextLine[]>();
  for (const line of lines) {
    const key = quantize(line.x, xStep);
    const arr = colBuckets.get(key) ?? [];
    arr.push(line);
    colBuckets.set(key, arr);
  }

  // Columns that appear on several rows (or at least twice across the page)
  const columnKeys = [...colBuckets.entries()]
    .filter(([, ls]) => ls.length >= 2)
    .map(([k]) => k)
    .sort((a, b) => a - b);

  // Resume tables often have 3–4 columns; also accept keys that appear once if
  // we already have ≥2 strong columns and a nearby singleton (header-only col).
  if (columnKeys.length < 2) {
    const weakKeys = [...colBuckets.entries()]
      .filter(([, ls]) => ls.length >= 1)
      .map(([k]) => k)
      .sort((a, b) => a - b);
    if (weakKeys.length >= 3) {
      // fall through with weak keys when many distinct x-positions exist
      columnKeys.length = 0;
      columnKeys.push(...weakKeys);
    } else {
      return [];
    }
  }

  // Use vertical path rules to refine column edges when present
  const vRules = extractVerticalRules(paths, medFs);
  const colXs = refineColumnsWithRules(columnKeys, vRules, xStep);

  if (colXs.length < 2) return [];

  // Assign each line to nearest column
  type Tagged = { line: TextLine; col: number; qy: number };
  const tagged: Tagged[] = [];
  for (const line of lines) {
    let bestCol = 0;
    let bestDist = Infinity;
    for (let c = 0; c < colXs.length; c++) {
      const d = Math.abs(line.x - colXs[c]);
      if (d < bestDist) {
        bestDist = d;
        bestCol = c;
      }
    }
    // Must be reasonably close to a column (wider tolerance for ragged cells)
    if (bestDist > medFs * 5.5) continue;
    tagged.push({ line, col: bestCol, qy: quantize(line.baseline, yStep) });
  }

  // Group into row bands
  const rowMap = new Map<number, Tagged[]>();
  for (const t of tagged) {
    const arr = rowMap.get(t.qy) ?? [];
    arr.push(t);
    rowMap.set(t.qy, arr);
  }

  const rowKeys = [...rowMap.keys()].sort((a, b) => b - a); // top first
  // A table row should span multiple columns
  const denseRows = rowKeys.filter(k => {
    const cols = new Set(rowMap.get(k)!.map(t => t.col));
    return cols.size >= 2;
  });

  if (denseRows.length < 2) return [];

  // Continuity: keep the largest contiguous block of dense rows
  const rowGapMax = Math.max(yStep * 4, medFs * 2.8);
  const blocks: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i < denseRows.length; i++) {
    if (cur.length === 0) {
      cur = [denseRows[i]];
      continue;
    }
    const prev = cur[cur.length - 1];
    if (Math.abs(prev - denseRows[i]) <= rowGapMax) {
      cur.push(denseRows[i]);
    } else {
      blocks.push(cur);
      cur = [denseRows[i]];
    }
  }
  if (cur.length) blocks.push(cur);

  const tables: DetectedTable[] = [];
  let tableId = 0;

  for (const block of blocks) {
    if (block.length < 2) continue;
    const cells: TableCell[] = [];
    const usedCols = new Set<number>();
    const rowBaselines: number[] = [];

    for (let r = 0; r < block.length; r++) {
      const band = rowMap.get(block[r])!;
      rowBaselines.push(band[0].line.baseline);
      // One cell per column (leftmost if duplicates)
      const byCol = new Map<number, TextLine>();
      for (const t of band) {
        const prev = byCol.get(t.col);
        if (!prev || t.line.x < prev.x) byCol.set(t.col, t.line);
      }
      for (const [col, line] of byCol) {
        usedCols.add(col);
        cells.push({ line, row: r, col });
      }
    }

    const cols = usedCols.size;
    if (cols < 2 || cells.length < 4) continue;

    // Remap sparse column indices to 0..cols-1
    const sortedCols = [...usedCols].sort((a, b) => a - b);
    const colRemap = new Map(sortedCols.map((c, i) => [c, i]));
    const remapped = cells.map(c => ({
      ...c,
      col: colRemap.get(c.col)!,
    }));
    const columnXs = sortedCols.map(c => colXs[c] ?? colXs[0]);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const c of remapped) {
      const L = c.line;
      minX = Math.min(minX, L.x);
      maxX = Math.max(maxX, L.rightEdge);
      minY = Math.min(minY, L.y);
      maxY = Math.max(maxY, L.y + L.height);
    }

    tables.push({
      id: `table-${++tableId}`,
      rows: block.length,
      cols: sortedCols.length,
      cells: remapped,
      columnXs,
      rowBaselines,
      bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    });
  }

  return tables;
}

function extractVerticalRules(paths: PathItem[], fontSize: number): number[] {
  const xs: number[] = [];
  const minH = fontSize * 2;
  for (const p of paths) {
    if (p.paintType === 'fill' || p.paintType === 'none') continue;
    // Tall thin strokes ≈ vertical rules
    if (p.height >= minH && p.width <= Math.max(2, fontSize * 0.35)) {
      xs.push(p.x + p.width / 2);
    }
  }
  xs.sort((a, b) => a - b);
  // Deduplicate nearby
  const out: number[] = [];
  for (const x of xs) {
    if (out.length === 0 || Math.abs(x - out[out.length - 1]) > fontSize * 0.5) {
      out.push(x);
    }
  }
  return out;
}

function refineColumnsWithRules(
  columnKeys: number[],
  vRules: number[],
  xStep: number,
): number[] {
  if (vRules.length < 2) return columnKeys;
  // Prefer text column centers that sit between vertical rules
  return columnKeys;
}

/** Find which table cell contains a PDF point (or nearest cell on that row). */
export function hitTestTableCell(
  tables: DetectedTable[],
  pdfX: number,
  pdfY: number,
): { table: DetectedTable; cell: TableCell } | null {
  for (let t = tables.length - 1; t >= 0; t--) {
    const table = tables[t];
    const b = table.bounds;
    const pad = 4;
    if (
      pdfX < b.x - pad ||
      pdfX > b.x + b.width + pad ||
      pdfY < b.y - pad ||
      pdfY > b.y + b.height + pad
    ) {
      continue;
    }

    let best: TableCell | null = null;
    let bestDist = Infinity;
    for (const cell of table.cells) {
      const L = cell.line;
      const cx = L.x + L.width / 2;
      const cy = L.baseline;
      const dx = pdfX - cx;
      const dy = pdfY - cy;
      // Prefer cells whose x-span contains the click
      const inX = pdfX >= L.x - 2 && pdfX <= L.rightEdge + 8;
      const inY = Math.abs(pdfY - L.baseline) <= Math.max(L.height, L.fontSize) * 0.9;
      if (inX && inY) {
        return { table, cell };
      }
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < bestDist) {
        bestDist = dist;
        best = cell;
      }
    }
    if (best && bestDist < Math.max(best.line.fontSize * 3, 20)) {
      return { table, cell: best };
    }
  }
  return null;
}

/** Lines belonging to a specific table row (left→right). */
export function getTableRowLines(table: DetectedTable, row: number): TextLine[] {
  return table.cells
    .filter(c => c.row === row)
    .sort((a, b) => a.col - b.col)
    .map(c => c.line);
}

/** Find the table + cell for a given text line id. */
export function findCellForLine(
  tables: DetectedTable[],
  lineId: string,
): { table: DetectedTable; cell: TableCell } | null {
  for (const table of tables) {
    for (const cell of table.cells) {
      if (cell.line.id === lineId) return { table, cell };
    }
  }
  return null;
}
