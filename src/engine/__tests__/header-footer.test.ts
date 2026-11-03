import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEADER_FOOTER,
  buildHeaderFooterWatermarks,
  formatHeaderFooterText,
  measureHelvetica,
  unsupportedHeaderFooterText,
} from '../watermark/header-footer';

const a4 = { cropBox: { x: 0, y: 0, width: 595, height: 842 }, rotate: 0 };
const now = new Date(2026, 10, 3);

describe('header and footer text', () => {
  it('fills page, total, date and Bates tokens', () => {
    const values = { page: 7, total: 12, date: '2026-11-03', batesPrefix: 'ABC', batesDigits: 6 };
    expect(formatHeaderFooterText('Page {page} of {total} - {date}', values)).toBe('Page 7 of 12 - 2026-11-03');
    expect(formatHeaderFooterText('{bates}', values)).toBe('ABC000007');
  });

  it('accepts printable ASCII only', () => {
    expect(unsupportedHeaderFooterText('Page {page}')).toBeNull();
    expect(unsupportedHeaderFooterText('第 {page} 页')).toBe('第');
  });
});

describe('header and footer layout', () => {
  it('numbers each page in the range from the start number', () => {
    const marks = buildHeaderFooterWatermarks({ ...DEFAULT_HEADER_FOOTER, pageFrom: 1, startNumber: 1 }, [a4, a4, a4], now);
    expect(marks.map(mark => [mark.pageIndices, mark.text])).toEqual([[[1], 'Page 1 of 3'], [[2], 'Page 2 of 3']]);
  });

  it('aligns left, centre and right slots inside the margin', () => {
    const marks = buildHeaderFooterWatermarks({
      ...DEFAULT_HEADER_FOOTER,
      text: { headerLeft: 'L', footerCenter: 'C', footerRight: 'Right' },
      margin: 30,
    }, [a4], now);
    const [left, center, right] = marks.map(mark => mark.position as [number, number]);
    expect(left[0] - marks[0].textWidth! / 2).toBeCloseTo(30, 5);
    expect(left[1]).toBeGreaterThan(780);
    expect(center[0]).toBeCloseTo(297.5, 5);
    expect(right[0] + marks[2].textWidth! / 2).toBeCloseTo(565, 5);
    expect(right[1]).toBeLessThan(40);
    expect(marks[2].textWidth).toBeCloseTo(measureHelvetica('Right', 10), 5);
  });

  it('puts the footer at the visual bottom of a page rotated 90 degrees', () => {
    const rotated = { cropBox: { x: 0, y: 0, width: 595, height: 842 }, rotate: 90 };
    const [mark] = buildHeaderFooterWatermarks(DEFAULT_HEADER_FOOTER, [rotated], now);
    const [x, y] = mark.position as [number, number];
    // Visual bottom of a /Rotate 90 page is the user-space right edge; visual centre is half the height.
    expect(x).toBeGreaterThan(555);
    expect(y).toBeCloseTo(421, 5);
    expect(mark.rotation).toBe(90);
  });
});
