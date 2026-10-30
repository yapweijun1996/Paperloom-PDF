import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parsePDF, getPageContentBytes } from '../parser/parser';
import { updatePageContent } from '../editor/stream-compiler';
import { PDFArray, PDFDict, PDFNumber, PDFRef, PDFStream } from '../types';
import { serializeDocument } from '../writer/serializer';
import { saveQuick } from '../writer/save-pipeline';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { prepareIsolatedTextRedaction } from '../security/redaction/isolated-text-redaction';

const area = { x: 15, y: 75, width: 170, height: 50 };
const hasPoppler = ['pdftotext', 'pdftoppm'].every(tool => spawnSync(tool, ['-v'], { stdio: 'ignore' }).status === 0);

async function fixture(secret: string, visible: string, separateStreams = false, font = StandardFonts.Courier) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([500, 500]);
  page.drawText('fixture', { font: await pdf.embedFont(font) });
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  doc.xref.trailerDict.delete('Info');
  const pageInfo = doc.pages[0], fonts = pageInfo.resources.getDict('Font')!;
  const name = [...fonts.keys()][0], resources = new PDFDict([['Font', fonts]]);
  pageInfo.dict.set('Resources', resources); pageInfo.resources = resources;
  pageInfo.dict.set('Contents', pageInfo.contentRefs[0]);
  const encode = (input: string) => new TextEncoder().encode(input.replaceAll('$FONT', `/${name}`));
  if (!separateStreams) await updatePageContent(pageInfo.contentRefs, encode(`${secret}\n${visible}\n`), doc.objects, false);
  else {
    await updatePageContent(pageInfo.contentRefs, encode(`${secret}\n`), doc.objects, false);
    const ref = new PDFRef(Math.max(...[...doc.objects.keys()].map(key => Number(key.split('_')[0]))) + 1, 0);
    const bytes = encode(`${visible}\n`);
    doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(bytes.length)]]), bytes, bytes));
    pageInfo.contentRefs.push(ref);
    pageInfo.dict.set('Contents', new PDFArray([...pageInfo.contentRefs]));
  }
  return parsePDF(await serializeDocument(doc));
}

describe('isolated bare text redaction', () => {
  it.skipIf(!hasPoppler).each([
    ['two bare blocks', 'BT $FONT 10 Tf 40 100 Td (SECRET) Tj ET', 'BT $FONT 10 Tf 280 300 Td (VISIBLE) Tj ET', false, StandardFonts.Courier],
    ['TJ spacing and inherited leading', 'BT $FONT 10 Tf 40 100 TD [(SEC) -50 (RET)] TJ T* ET', 'BT $FONT 10 Tf 280 300 Td (VISIBLE) Tj T* ET', false, StandardFonts.Courier],
    ['mixed wrapped and bare across streams', 'BT $FONT 10 Tf 1 0 0 1 40 100 Tm (SECRET) Tj ET', 'q BT 1 0 0 rg $FONT 10 Tf 280 300 Td (VISIBLE) Tj ET Q', true, StandardFonts.Courier],
    ['wrapped red before bare black', 'q BT 1 0 0 rg $FONT 10 Tf 40 100 Td (SECRET) Tj ET Q', 'BT $FONT 10 Tf 280 300 Td (VISIBLE) Tj ET', false, StandardFonts.Courier],
    ['Helvetica bare text', 'BT $FONT 10 Tf 40 100 Td (SECRET) Tj ET', 'BT $FONT 10 Tf 280 300 Td (VISIBLE) Tj ET', false, StandardFonts.Helvetica],
    ['Times italic bare text', 'BT $FONT 10 Tf 40 100 Td (SECRET) Tj ET', 'BT $FONT 10 Tf 280 300 Td (VISIBLE) Tj ET', false, StandardFonts.TimesRomanItalic],
  ])('removes %s and preserves visible pixels', async (_description, secret, visible, multiple, font) => {
    const doc = await fixture(secret, visible, multiple, font);
    const before = await serializeDocument(doc);
    redactionEngine.markRegion(doc, 0, area);
    expect((await redactionEngine.applySecureRedactions(doc)).textOperatorsRemoved).toBe(1);
    const after = await saveQuick(doc), reopened = await parsePDF(after);
    const content = new TextDecoder().decode(getPageContentBytes(reopened.pages[0], reopened.objects));
    expect(content).not.toContain('SECRET'); expect(content).toContain('VISIBLE');
    expect((await PDFDocument.load(after)).getPageCount()).toBe(1);
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-bare-text-'));
    try {
      const input = join(dir, 'before.pdf'), output = join(dir, 'after.pdf');
      writeFileSync(input, before); writeFileSync(output, after);
      if (spawnSync('qpdf', ['--version'], { stdio: 'ignore' }).status === 0) {
        execFileSync('qpdf', ['--check', input]); execFileSync('qpdf', ['--check', output]);
      }
      expect(execFileSync('pdftotext', [input, '-'], { encoding: 'utf8' })).toContain('SECRET');
      const extracted = execFileSync('pdftotext', [output, '-'], { encoding: 'utf8' });
      expect(extracted).not.toContain('SECRET'); expect(extracted).toContain('VISIBLE');
      for (const dpi of [36, 72, 150, 300]) {
        const render = (file: string, name: string) => {
          const prefix = join(dir, `${name}-${dpi}`);
          execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', String(dpi), file, prefix]);
          const ppm = readFileSync(`${prefix}.ppm`), header = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(ppm.toString('latin1', 0, 64));
          if (!header) throw new Error('Invalid PPM');
          return { pixels: ppm.subarray(header[0].length), width: Number(header[1]), height: Number(header[2]) };
        };
        const a = render(input, 'a'), b = render(output, 'b');
        expect([a.width, a.height]).toEqual([b.width, b.height]);
        let inside = 0, outside = 0;
        for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
          const i = (y * a.width + x) * 3;
          if (a.pixels[i] === b.pixels[i] && a.pixels[i + 1] === b.pixels[i + 1] && a.pixels[i + 2] === b.pixels[i + 2]) continue;
          const left = x * 72 / dpi, right = (x + 1) * 72 / dpi, bottom = 500 - (y + 1) * 72 / dpi, top = 500 - y * 72 / dpi;
          if (right <= area.x || left >= area.x + area.width || top <= area.y || bottom >= area.y + area.height) outside++; else inside++;
        }
        expect(inside).toBeGreaterThan(0); expect(outside).toBe(0);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  it.each([
    ['BT 1 0 0 rg $FONT 10 Tf 40 100 Td (SECRET) Tj ET', 'BT $FONT 10 Tf 280 300 Td (VISIBLE) Tj ET'],
    ['1 0 0 rg BT $FONT 10 Tf 40 100 Td (SECRET) Tj ET', 'BT $FONT 10 Tf 280 300 Td (VISIBLE) Tj ET'],
    ['BT $FONT 10 Tf 1 Tc 40 100 Td (SECRET) Tj ET', 'BT $FONT 10 Tf 280 300 Td (VISIBLE) Tj ET'],
    ['BT $FONT 10 Tf 7 Tr 40 100 Td (SECRET) Tj ET', 'BT $FONT 10 Tf 280 300 Td (VISIBLE) Tj ET'],
    ['BT $FONT 10 Tf 40 100 Td (SECRET) Tj ET', 'BT 280 300 Td (VISIBLE) Tj ET'],
    ['BT $FONT 10 Tf 40 100 Td (SECRET) Tj ET Q', 'BT $FONT 10 Tf 280 300 Td (VISIBLE) Tj ET'],
  ])('rejects potentially inherited or malformed state without modification', async (secret, visible) => {
    const doc = await fixture(secret, visible); redactionEngine.markRegion(doc, 0, area);
    const before = await serializeDocument(doc);
    expect(() => prepareIsolatedTextRedaction(doc)).toThrow();
    expect(await serializeDocument(doc)).toEqual(before);
  });
});
