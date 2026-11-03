import { describe, expect, it } from 'vitest';
import { parsePDF, getPageContentBytes } from '../parser/parser';
import { interpretPage, type GlyphPosition } from '../content/interpreter';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { prepareGlyphRedaction, GlyphRedactionUnsupportedError } from '../security/redaction/glyph-redaction';
import { rawPDF } from './audit-p1-fixtures';
import { PDFString } from '../types';

const HELVETICA = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
// A 2-byte Identity-H font: CID 1..6 are 500 units wide, CID 3 and 4 are 700.
const IDENTITY_H = [
  '<< /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /Identity-H /DescendantFonts [7 0 R] >>',
  '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Test /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 500 /W [3 [700 700]] >>',
];

async function documentWith(content: string, font = HELVETICA, extra: string[] = []) {
  return parsePDF(rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    font,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\x00\nendstream',
    ...extra,
  ]));
}

type Doc = Awaited<ReturnType<typeof documentWith>>;

function glyphs(doc: Doc): GlyphPosition[] {
  const page = doc.pages[0];
  const seen = new Set<GlyphPosition>();
  const result: GlyphPosition[] = [];
  for (const run of interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects).textRuns) {
    for (const glyph of run.glyphs) if (!seen.has(glyph) && glyph.source) { seen.add(glyph); result.push(glyph); }
  }
  return result;
}

function text(doc: Doc): string {
  return glyphs(doc).map(glyph => glyph.unicode).join('');
}

/** Mark glyphs [from, to) of the page's glyph sequence, slightly inset so neighbours stay outside. */
function mark(doc: Doc, from: number, to: number) {
  const list = glyphs(doc).slice(from, to);
  const xs = list.flatMap(glyph => [glyph.x, glyph.x + glyph.width]);
  const ys = list.map(glyph => glyph.y);
  const size = Math.max(...list.map(glyph => glyph.fontSize));
  const rect = { x: Math.min(...xs) + 0.2, y: Math.min(...ys) - 1, width: Math.max(...xs) - Math.min(...xs) - 0.4, height: size * 0.8 };
  redactionEngine.markRegion(doc, 0, rect);
}

function positions(list: GlyphPosition[]) {
  return list.map(glyph => [glyph.unicode, +glyph.tRm.e.toFixed(3), +glyph.tRm.f.toFixed(3)]);
}

function redact(doc: Doc) {
  return prepareGlyphRedaction(doc).commit();
}

describe('glyph-level redaction', () => {
  it('removes a word from the middle of a Tj and keeps the rest of the line in place', async () => {
    const doc = await documentWith('BT /F1 12 Tf 50 700 Td (Mail a@b.com now) Tj ET');
    const before = glyphs(doc);
    mark(doc, 5, 12);
    const result = redact(doc);
    expect(result.textOperatorsRemoved).toBe(7);
    expect(text(doc)).toBe('Mail  now');
    expect(positions(glyphs(doc))).toEqual(positions([...before.slice(0, 5), ...before.slice(12)]));
    expect(doc.requiresFullRewrite).toBe(true);
    expect(doc.pages[0].dict.has('Annots')).toBe(false);
  });

  it('keeps kerning, character, word and horizontal spacing, and the next line', async () => {
    const doc = await documentWith('BT /F1 12 Tf 14 TL 2 Tc 3 Tw 80 Tz 50 700 Td [(Hello) -200 (big Secret) 50 (Tail)] TJ T* (Next line) Tj ET');
    const before = glyphs(doc);
    const start = text(doc).indexOf('Secret');
    mark(doc, start, start + 6);
    redact(doc);
    expect(text(doc)).toBe('Hellobig TailNext line');
    expect(positions(glyphs(doc))).toEqual(positions([...before.slice(0, start), ...before.slice(start + 6)]));
  });

  it('removes two-byte glyphs from an Identity-H font', async () => {
    const doc = await documentWith('BT /F1 10 Tf 100 600 Td <000100020003000400050006> Tj ET', IDENTITY_H[0], [IDENTITY_H[1]]);
    const before = glyphs(doc);
    expect(before.map(glyph => glyph.charCode)).toEqual([1, 2, 3, 4, 5, 6]);
    mark(doc, 2, 4);
    redact(doc);
    expect(glyphs(doc).map(glyph => glyph.charCode)).toEqual([1, 2, 5, 6]);
    expect(positions(glyphs(doc))).toEqual(positions([...before.slice(0, 2), ...before.slice(4)]));
  });

  it('removes invisible OCR text (Tr 3) under the mark', async () => {
    const doc = await documentWith('BT 3 Tr /F1 12 Tf 50 700 Td (ID S1234567D) Tj ET');
    mark(doc, 3, 12);
    redact(doc);
    expect(text(doc)).toBe('ID ');
  });

  it("rewrites ' and \" while keeping their line moves and spacing", async () => {
    const doc = await documentWith('BT /F1 12 Tf 14 TL 50 700 Td (First) Tj (Second secret) \' 4 1 (Third secret end) " ET');
    const before = glyphs(doc);
    const all = text(doc);
    const second = all.indexOf('secret');
    const third = all.indexOf('secret', second + 1);
    mark(doc, second, second + 6);
    mark(doc, third, third + 6);
    redact(doc);
    expect(text(doc)).toBe('FirstSecond Third  end');
    const keep = before.filter((_, i) => !(i >= second && i < second + 6) && !(i >= third && i < third + 6));
    expect(positions(glyphs(doc))).toEqual(positions(keep));
  });

  it('removes a drawing that lies fully inside the mark and keeps larger ones', async () => {
    const doc = await documentWith('0 0 1 rg 40 690 200 30 re f 1 0 0 rg 60 701 6 6 re f BT /F1 12 Tf 50 700 Td (Secret) Tj ET');
    mark(doc, 0, 6);
    const result = redact(doc);
    expect(result.pathOperatorsRemoved).toBe(1);
    const page = doc.pages[0];
    const paths = interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects).displayList.filter(item => item.type === 'path');
    expect(paths).toHaveLength(1);
    expect(text(doc)).toBe('');
  });

  it('refuses and leaves the document unchanged when an image is under the mark', async () => {
    const doc = await documentWith('q 100 0 0 20 50 698 cm /Im1 Do Q BT /F1 12 Tf 50 700 Td (Secret) Tj ET');
    mark(doc, 0, 6);
    const before = getPageContentBytes(doc.pages[0], doc.objects);
    expect(() => redact(doc)).toThrow(GlyphRedactionUnsupportedError);
    expect(getPageContentBytes(doc.pages[0], doc.objects)).toEqual(before);
    expect(text(doc)).toBe('Secret');
  });

  it('refuses text with ActualText under the mark', async () => {
    const doc = await documentWith('/Span << /ActualText (Secret) >> BDC BT /F1 12 Tf 50 700 Td (Secret) Tj ET EMC');
    mark(doc, 0, 6);
    expect(() => redact(doc)).toThrow(/ActualText/);
  });

  it('runs through the public engine when the strict strategies refuse the file', async () => {
    // A TJ array with a hex string, a scaled matrix and an image elsewhere: outside the strict subsets.
    const doc = await documentWith('q 50 0 0 50 400 100 cm /Im1 Do Q BT /F1 12 Tf 1.2 0 0 1.2 50 700 Tm [(Call 555) <2d> (1234 today)] TJ ET');
    const start = text(doc).indexOf('555');
    mark(doc, start, start + 8);
    const result = await redactionEngine.applySecureRedactions(doc);
    expect(result.pagesProcessed).toBe(1);
    expect(text(doc)).toBe('Call  today');
  });

  it('keeps the lines directly above and below at tight line spacing', async () => {
    // 12pt text on a 13.8pt pitch (1.15 em); the mark is one full line tall over one word.
    const doc = await documentWith('BT /F1 12 Tf 13.8 TL 50 700 Td (gggg Upper gggg) Tj T* (jjjj Hidden jjjj) Tj T* (Tttt Lower Tttt) Tj ET');
    const before = glyphs(doc);
    const start = text(doc).indexOf('Hidden');
    const word = before.slice(start, start + 6);
    const left = word[0].x + 0.2, right = word[5].x + word[5].width - 0.2;
    redactionEngine.markRegion(doc, 0, { x: left, y: word[0].y - 12 * 0.2, width: right - left, height: 13.8 });
    redact(doc);
    expect(text(doc)).toBe('gggg Upper ggggjjjj  jjjjTttt Lower Tttt');
  });

  it('refuses a drawing that is only partly under the mark', async () => {
    const doc = await documentWith('0 0 1 rg 80 702 30 30 re f BT /F1 12 Tf 50 700 Td (Secret) Tj ET');
    mark(doc, 0, 6);
    expect(() => redact(doc)).toThrow(/only partly under a mark/);
    expect(text(doc)).toBe('Secret');
  });

  it('refuses when the redacted text also appears elsewhere on the page or in the metadata', async () => {
    const page = await documentWith('BT /F1 12 Tf 50 700 Td (Secret) Tj 0 -40 Td (Secret again) Tj ET');
    mark(page, 0, 6);
    expect(() => redact(page)).toThrow(/also appears on page 1/);

    const metadata = await documentWith('BT /F1 12 Tf 50 700 Td (Secret) Tj ET');
    metadata.catalog.set('Note', new PDFString('the Secret plan'));
    mark(metadata, 0, 6);
    expect(() => redact(metadata)).toThrow(/also appears in the document data/);
    expect(text(metadata)).toBe('Secret');
  });

  it('does not search for removed text shorter than four characters', async () => {
    const doc = await documentWith('BT /F1 12 Tf 50 700 Td (ab) Tj 0 -40 Td (ab cd) Tj ET');
    mark(doc, 0, 2);
    redact(doc);
    expect(text(doc)).toBe('ab cd');
  });
});
