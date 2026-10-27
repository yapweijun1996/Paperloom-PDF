import type { TextRun, TextLine, PathItem, RenderResult } from '@/engine/browser-core';
import { visualFontSize, resolveRunStyleFlags, distributeTextChangeToSegments, segmentAtIndex } from '@/engine/browser-core';
import type { TextStyleUI } from './hooks/useTextStyleActions';

/** True if the run is underlined or a thin stroke path sits under it (certificate labels). */
export function runHasPathUnderline(run: TextRun, paths: PathItem[]): boolean {
  if (run.isUnderline) return true;
  const fs = visualFontSize(run);
  const yTarget = run.y - fs * 0.12;
  for (const p of paths) {
    if (p.paintType !== 'stroke' && p.paintType !== 'both') continue;
    if (p.height > fs * 0.5) continue;
    if (p.width < fs * 0.4) continue;
    if (p.lineWidth > fs * 0.4) continue;
    const py = p.y + p.height * 0.5;
    if (Math.abs(py - yTarget) > fs * 0.45 && Math.abs(p.y - yTarget) > fs * 0.45) continue;
    const overlapL = Math.max(p.x, run.x);
    const overlapR = Math.min(p.x + p.width, run.x + Math.max(run.width, fs));
    if (overlapR - overlapL < fs * 0.3) continue;
    return true;
  }
  return false;
}

export type TypingStyle = Partial<Pick<TextStyleUI, 'bold' | 'italic' | 'underline' | 'color' | 'fontSize' | 'fontFamily'>>;

/**
 * Map a char index in the *current* edit text to the PDF run that owns it
 * after caret-aware redistribute. Using frozen-anchor indices directly is
 * wrong once inserts push the caret past later original segments (e.g. into
 * an unbold neighbor), which then falsely queues bold patches.
 */
export function runAtDistributedEditIndex(
  line: TextLine,
  initialText: string,
  currentText: string,
  charIndex: number,
): TextRun | null {
  if (!currentText) {
    return line.segments[0]?.run ?? null;
  }
  const idx = Math.max(0, Math.min(charIndex, currentText.length - 1));
  const edits = distributeTextChangeToSegments(
    line,
    initialText,
    currentText,
    Math.min(charIndex + 1, currentText.length),
  );
  let pos = 0;
  for (const edit of edits) {
    const end = pos + edit.newText.length;
    if (idx >= pos && idx < end) return edit.run;
    pos = end;
  }
  if (edits.length > 0) return edits[edits.length - 1].run;
  return segmentAtIndex(line, Math.min(idx, line.text.length))?.run ?? null;
}

/**
 * Word-like style at the caret: inherit from the character to the LEFT
 * (or index 0 at line start), including path-drawn underlines and overrides.
 */
export function resolveTypingStyleFromCaret(
  line: TextLine,
  caret: number,
  fonts: RenderResult['fonts'] | undefined,
  paths: PathItem[],
  overrides: EditStyleOverride[],
  currentText?: string,
  initialText?: string,
): TypingStyle {
  const styleIndex = caret > 0 ? caret - 1 : 0;
  const text = currentText ?? line.text;
  const initial = initialText ?? line.text;
  const run = runAtDistributedEditIndex(line, initial, text, styleIndex)
    ?? segmentAtIndex(line, Math.min(styleIndex, line.text.length))?.run;
  if (!run) return {};
  const fontData = fonts?.get(run.fontName);
  const flags = resolveRunStyleFlags(run.fontName, fontData);
  let bold = flags.bold;
  let italic = flags.italic;
  let underline = !!run.isUnderline || runHasPathUnderline(run, paths);
  let fontSize = visualFontSize(run);
  let color: string | undefined;
  if (run.fillColor) {
    const [r, g, b] = run.fillColor;
    color = '#' + [r, g, b].map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
  }
  for (const ov of overrides) {
    if (styleIndex >= ov.start && styleIndex < ov.end) {
      if (ov.bold != null) bold = ov.bold;
      if (ov.italic != null) italic = ov.italic;
      if (ov.underline != null) underline = ov.underline;
      if (ov.fontSize != null) fontSize = ov.fontSize;
      if (ov.color) color = ov.color;
    }
  }
  return {
    bold,
    italic,
    underline,
    fontSize,
    // Intentionally omit fontFamily — display names strip "Bold" and would
    // replace the PDF face with synthetic weight on insert overrides.
    ...(color ? { color } : {}),
  };
}

/**
 * Remap a [start,end) style range across an insert (delta>0) or delete (delta<0).
 * Deletes must collapse points inside the removed span — never shift a range
 * that starts at editAt leftward onto the previous character.
 */
export function remapStyleRange(
  start: number,
  end: number,
  editAt: number,
  delta: number,
): { start: number; end: number } | null {
  if (delta > 0) {
    if (end <= editAt) return { start, end };
    if (start >= editAt) return { start: start + delta, end: end + delta };
    return { start, end: end + delta };
  }
  if (delta < 0) {
    const delEnd = editAt - delta;
    const mapPoint = (p: number) => {
      if (p <= editAt) return p;
      if (p >= delEnd) return p + delta;
      return editAt;
    };
    const ns = mapPoint(start);
    const ne = mapPoint(end);
    if (ne <= ns) return null;
    return { start: ns, end: ne };
  }
  return { start, end };
}

/**
 * Merge same fontSize-only patches across whitespace/punctuation gaps.
 * Per-keystroke inserts leave holes on spaces (intentionally not committed),
 * so sequential applies split the same run repeatedly with stale indices and
 * only the first chunk keeps the new size — later typed text looks "unbold"
 * / small and trailing glyphs overlap.
 */
export function coalesceFontSizePatches<T extends { start: number; end: number; patch: Partial<TextStyleUI> }>(
  queued: T[],
  commitText: string,
): T[] {
  if (queued.length <= 1) return queued;
  const out: T[] = [];
  for (const item of queued) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push({ ...item, patch: { ...item.patch } });
      continue;
    }
    const prevKeys = Object.keys(prev.patch).filter(k => (prev.patch as Record<string, unknown>)[k] != null);
    const itemKeys = Object.keys(item.patch).filter(k => (item.patch as Record<string, unknown>)[k] != null);
    const prevOnlyFs = prevKeys.length === 1 && prevKeys[0] === 'fontSize';
    const itemOnlyFs = itemKeys.length === 1 && itemKeys[0] === 'fontSize';
    const sameFs =
      prevOnlyFs
      && itemOnlyFs
      && prev.patch.fontSize != null
      && prev.patch.fontSize === item.patch.fontSize;
    const gap = commitText.slice(prev.end, item.start);
    const gapOk = prev.end <= item.start && /^[\s.,;:!?…\-–—]*$/.test(gap);
    if (sameFs && gapOk) {
      prev.end = Math.max(prev.end, item.end);
      continue;
    }
    out.push({ ...item, patch: { ...item.patch } });
  }
  return out;
}

/**
 * Spaces are painted large in the overlay but not queued as fontSize commits.
 * Without expanding the range, the separator before the residual word stays
 * small (` nt` at 10pt after `yfuyct fdu` at 16pt) so glyphs look glued and
 * users mash Space.
 */
export function expandFontSizePatchesThroughSpaces<T extends { start: number; end: number; patch: Partial<TextStyleUI> }>(
  queued: T[],
  commitText: string,
): T[] {
  return queued.map(item => {
    if (item.patch.fontSize == null) return item;
    let s = item.start;
    let e = item.end;
    // Include at most one separator space (+ trailing punct). Absorbing a
    // whole space-river into the enlarged mid inflates TJ width and can
    // orphan the trailing clause onto another flow line.
    while (s > 0 && /[.,;:!?…]/.test(commitText[s - 1]!)) s--;
    if (s > 0 && commitText[s - 1] === ' ') s--;
    while (e < commitText.length && /[.,;:!?…]/.test(commitText[e]!)) e++;
    if (e < commitText.length && commitText[e] === ' ') e++;
    if (s === item.start && e === item.end) return item;
    return { ...item, start: s, end: e };
  });
}

export type EditStyleOverride = {
  start: number;
  end: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  fontSize?: number;
  fontFamily?: string;
};

/** Map sidebar font names to a CSS font-family stack for the edit overlay. */
export function cssFontFamilyFromUI(name: string): string {
  const n = name.trim();
  if (!n) return 'Helvetica, Arial, sans-serif';
  const lower = n.toLowerCase();
  if (lower === 'helvetica') return 'Helvetica, Arial, sans-serif';
  if (lower === 'times-roman' || lower === 'times') return '"Times New Roman", Times, serif';
  if (lower === 'courier') return '"Courier New", Courier, monospace';
  if (lower.includes('mono') || lower.includes('consolas') || lower.includes('courier')) {
    return `"${n}", "Courier New", monospace`;
  }
  if (lower.includes('serif') || lower.includes('times') || lower.includes('georgia') || lower.includes('garamond') || lower.includes('palatino') || lower.includes('cambria')) {
    return `"${n}", "Times New Roman", serif`;
  }
  return `"${n}", Helvetica, Arial, sans-serif`;
}
