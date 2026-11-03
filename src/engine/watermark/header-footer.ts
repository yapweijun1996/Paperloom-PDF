/**
 * Headers, footers, page numbers and Bates numbers, built as text watermarks
 * so they reuse the watermark engine's font, resource and content handling.
 *
 * Each slot is laid out in the page's visual frame (CropBox after /Rotate)
 * and mapped back to user space, so text sits upright at the visual top or
 * bottom of rotated pages too.
 */
import type { PDFPageInfo } from '../types';
import { getStandardFontCharWidth } from '../fonts/standard14';
import type { TextWatermark } from './watermark-engine';

export type HeaderFooterSlot =
  | 'headerLeft' | 'headerCenter' | 'headerRight'
  | 'footerLeft' | 'footerCenter' | 'footerRight';

export const HEADER_FOOTER_SLOTS: HeaderFooterSlot[] = [
  'headerLeft', 'headerCenter', 'headerRight', 'footerLeft', 'footerCenter', 'footerRight',
];

export interface HeaderFooterOptions {
  /** Text per slot; tokens: {page}, {total}, {date}, {bates}. */
  text: Partial<Record<HeaderFooterSlot, string>>;
  fontSize: number;
  color: [number, number, number];
  /** Distance from the page edge in points. */
  margin: number;
  /** Zero-based, inclusive page range. */
  pageFrom: number;
  pageTo: number;
  /** Number shown on the first page of the range for {page} and {bates}. */
  startNumber: number;
  batesPrefix: string;
  batesDigits: number;
}

export const DEFAULT_HEADER_FOOTER: HeaderFooterOptions = {
  text: { footerCenter: 'Page {page} of {total}' },
  fontSize: 10,
  color: [0, 0, 0],
  margin: 28,
  pageFrom: 0,
  pageTo: Number.MAX_SAFE_INTEGER,
  startNumber: 1,
  batesPrefix: '',
  batesDigits: 6,
};

const FONT_RESOURCE = 'PLHeaderFooter';
const BASE_FONT = 'Helvetica';

/** Text must stay within printable ASCII: the standard font has no other glyphs here. */
export function unsupportedHeaderFooterText(text: string): string | null {
  const bad = [...text].find(ch => ch < ' ' || ch > '~');
  return bad === undefined ? null : bad;
}

export function formatHeaderFooterText(
  template: string,
  values: { page: number; total: number; date: string; batesPrefix: string; batesDigits: number },
): string {
  return template
    .replace(/\{page\}/g, String(values.page))
    .replace(/\{total\}/g, String(values.total))
    .replace(/\{date\}/g, values.date)
    .replace(/\{bates\}/g, `${values.batesPrefix}${String(values.page).padStart(values.batesDigits, '0')}`);
}

export function measureHelvetica(text: string, fontSize: number): number {
  let width = 0;
  for (const ch of text) width += getStandardFontCharWidth(BASE_FONT, ch.charCodeAt(0));
  return (width / 1000) * fontSize;
}

function isoDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Maps a point in the rotated, cropped visual frame to PDF user space. */
function visualToUser(page: Pick<PDFPageInfo, 'cropBox' | 'rotate'>, u: number, v: number): [number, number] {
  const { x, y, width: w, height: h } = page.cropBox;
  switch (((page.rotate % 360) + 360) % 360) {
    case 90: return [x + w - v, y + u];
    case 180: return [x + w - u, y + h - v];
    case 270: return [x + v, y + h - u];
    default: return [x + u, y + v];
  }
}

export function buildHeaderFooterWatermarks(
  options: HeaderFooterOptions,
  pages: Pick<PDFPageInfo, 'cropBox' | 'rotate'>[],
  now: Date,
): TextWatermark[] {
  const watermarks: TextWatermark[] = [];
  const last = Math.min(options.pageTo, pages.length - 1);
  const date = isoDate(now);
  for (let pageIndex = Math.max(0, options.pageFrom); pageIndex <= last; pageIndex++) {
    const page = pages[pageIndex];
    const rotation = ((page.rotate % 360) + 360) % 360;
    const quarter = rotation === 90 || rotation === 270;
    const visualWidth = quarter ? page.cropBox.height : page.cropBox.width;
    const visualHeight = quarter ? page.cropBox.width : page.cropBox.height;
    for (const slot of HEADER_FOOTER_SLOTS) {
      const template = options.text[slot]?.trim();
      if (!template) continue;
      const text = formatHeaderFooterText(template, {
        page: options.startNumber + pageIndex - Math.max(0, options.pageFrom),
        total: pages.length,
        date,
        batesPrefix: options.batesPrefix,
        batesDigits: options.batesDigits,
      });
      const width = measureHelvetica(text, options.fontSize);
      const u = slot.endsWith('Left') ? options.margin + width / 2
        : slot.endsWith('Right') ? visualWidth - options.margin - width / 2
        : visualWidth / 2;
      // The watermark builder puts the baseline 0.3 em below the centre.
      const baseline = slot.startsWith('header') ? visualHeight - options.margin - options.fontSize * 0.7 : options.margin;
      const v = baseline + options.fontSize * 0.3;
      watermarks.push({
        id: `hf-${pageIndex}-${slot}`,
        type: 'text',
        text,
        textWidth: width,
        fontName: FONT_RESOURCE,
        baseFont: BASE_FONT,
        fontSize: options.fontSize,
        color: options.color,
        opacity: 1,
        rotation,
        tile: false,
        layer: 'above',
        position: visualToUser(page, u, v),
        pageIndices: [pageIndex],
      });
    }
  }
  return watermarks;
}
