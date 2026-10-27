/**
 * Document compare — text-level diff between pages/documents.
 */

import type { PDFDocumentData } from '../types';
import { getPageContentBytes } from '../parser/parser';
import { interpretPage } from '../content/interpreter';
import { buildDocumentFlow } from '../flow';

export interface TextDiff {
  added: string[];
  removed: string[];
  unchanged: string[];
}

/** LCS-based line diff for page text. */
export function comparePageText(a: string, b: string): TextDiff {
  const aLines = a.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const bLines = b.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  const m = aLines.length;
  const n = bLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (aLines[i - 1] === bLines[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const added: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aLines[i - 1] === bLines[j - 1]) {
      unchanged.push(aLines[i - 1]);
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      added.push(bLines[j - 1]);
      j--;
    } else {
      removed.push(aLines[i - 1]);
      i--;
    }
  }

  return {
    added: added.reverse(),
    removed: removed.reverse(),
    unchanged: unchanged.reverse(),
  };
}

export function extractPagePlainText(doc: PDFDocumentData, pageIndex: number): string {
  const page = doc.pages[pageIndex];
  const bytes = getPageContentBytes(page, doc.objects);
  const interpreted = interpretPage(bytes, page, doc.objects);
  const flow = buildDocumentFlow(interpreted.textRuns);
  return flow.lines.map(l => l.text).join('\n');
}

export interface DocumentCompareResult {
  pageDiffs: Array<{ pageIndex: number; diff: TextDiff }>;
  pagesOnlyInA: number[];
  pagesOnlyInB: number[];
}

export function compareDocuments(
  docA: PDFDocumentData,
  docB: PDFDocumentData,
): DocumentCompareResult {
  const pageCount = Math.min(docA.pages.length, docB.pages.length);
  const pageDiffs: DocumentCompareResult['pageDiffs'] = [];

  for (let i = 0; i < pageCount; i++) {
    const a = extractPagePlainText(docA, i);
    const b = extractPagePlainText(docB, i);
    pageDiffs.push({ pageIndex: i, diff: comparePageText(a, b) });
  }

  const pagesOnlyInA: number[] = [];
  const pagesOnlyInB: number[] = [];
  for (let i = pageCount; i < docA.pages.length; i++) pagesOnlyInA.push(i);
  for (let i = pageCount; i < docB.pages.length; i++) pagesOnlyInB.push(i);

  return { pageDiffs, pagesOnlyInA, pagesOnlyInB };
}
