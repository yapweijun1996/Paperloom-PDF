import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parsePDF, getPageContentBytes } from '../parser/parser';
import { updatePageContent } from '../editor/stream-compiler';
import { PDFDict } from '../types';
import { serializeDocument } from '../writer/serializer';
import { saveQuick } from '../writer/save-pipeline';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { prepareIsolatedTextRedaction } from '../security/redaction/isolated-text-redaction';

const area = { x: 5, y: 75, width: 520, height: 50 };
const tools = ['pdftotext', 'pdftoppm'].every(name => spawnSync(name, ['-v'], { stdio: 'ignore' }).status === 0);

async function fixture(secret: string, visible: string, font = StandardFonts.Helvetica) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 500]);
  page.drawText('fixture', { font: await pdf.embedFont(font) });
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  doc.xref.trailerDict.delete('Info');
  const info = doc.pages[0], fonts = info.resources.getDict('Font')!;
  const resourceName = [...fonts.keys()][0];
  info.resources = new PDFDict([['Font', fonts]]);
  info.dict.set('Resources', info.resources);
  info.dict.set('Contents', info.contentRefs[0]);
  const content = `${secret}\n${visible}\n`.replaceAll('$FONT', `/${resourceName}`);
  await updatePageContent(info.contentRefs, new TextEncoder().encode(content), doc.objects, false);
  return parsePDF(await serializeDocument(doc));
}

describe('multiple text-show operators in an isolated text block', () => {
  it.skipIf(!tools).each([
    ['bare and mixed show types', 'BT $FONT 10 Tf 40 100 Td (SECRET) Tj [(ALPHA) -100 (BETA)] TJ (GAMMA) Tj ET',
      'BT $FONT 10 Tf 40 300 Td (VISIBLE) Tj (PUBLIC) Tj ET', StandardFonts.Helvetica],
    ['wrapped with negative movement', 'q BT 0 g $FONT 10 Tf 40 100 Td [(SECRET) 1200 (ALPHA)] TJ (TOKEN) Tj ET Q',
      'q BT 1 0 0 rg $FONT 10 Tf 40 300 Td (VISIBLE) Tj (PUBLIC) Tj ET Q', StandardFonts.Courier],
    ['italic and numeric spacing', 'BT $FONT 10 Tf 40 100 Td (SECRET) Tj [500 (ALPHA) -500 (TOKEN)] TJ ET',
      'BT $FONT 10 Tf 40 300 Td [(VISIBLE) 20 (PUBLIC)] TJ ET', StandardFonts.TimesRomanItalic],
  ])('removes %s with independent rendering checks', async (_name, secret, visible, font) => {
    const doc = await fixture(secret, visible, font);
    const before = await serializeDocument(doc);
    redactionEngine.markRegion(doc, 0, area);
    expect((await redactionEngine.applySecureRedactions(doc)).textOperatorsRemoved).toBe(secret.includes('GAMMA') ? 3 : 2);
    const after = await saveQuick(doc), reopened = await parsePDF(after);
    const content = new TextDecoder().decode(getPageContentBytes(reopened.pages[0], reopened.objects));
    expect(content).not.toContain('SECRET'); expect(content).not.toContain('ALPHA');
    expect(content).toContain('VISIBLE'); expect((await PDFDocument.load(after)).getPageCount()).toBe(1);
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-multishow-'));
    try {
      const original = join(dir, 'before.pdf'), output = join(dir, 'after.pdf');
      writeFileSync(original, before); writeFileSync(output, after);
      if (spawnSync('qpdf', ['--version'], { stdio: 'ignore' }).status === 0) {
        execFileSync('qpdf', ['--check', original]); execFileSync('qpdf', ['--check', output]);
      } else if (process.env.CI) throw new Error('qpdf is required for CI verification');
      const inputText = execFileSync('pdftotext', [original, '-'], { encoding: 'utf8' });
      const outputText = execFileSync('pdftotext', [output, '-'], { encoding: 'utf8' });
      expect(inputText).toContain('SECRET'); expect(outputText).not.toContain('SECRET'); expect(outputText).toContain('VISIBLE');
      for (const dpi of [12, 36, 72, 150, 300]) {
        const render = (file: string, name: string) => {
          const prefix = join(dir, `${name}-${dpi}`);
          execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', String(dpi), file, prefix]);
          const ppm = readFileSync(`${prefix}.ppm`), header = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(ppm.toString('latin1', 0, 64));
          if (!header) throw new Error('Invalid PPM');
          return { pixels: ppm.subarray(header[0].length), width: Number(header[1]), height: Number(header[2]) };
        };
        const a = render(original, 'before'), b = render(output, 'after');
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
    ['partial coverage', 'BT $FONT 10 Tf 40 100 Td (SECRET) Tj (TOKEN) Tj ET',
      'BT $FONT 10 Tf 40 300 Td (VISIBLE) Tj ET', { x: 40, y: 95, width: 20, height: 10 }],
    ['retained fragment', 'BT $FONT 10 Tf 40 100 Td (SECRET) Tj (ALPHA) Tj ET',
      'BT $FONT 10 Tf 40 300 Td (ALPHA) Tj (PUBLIC) Tj ET', area],
    ['retained fragment split across shows', 'BT $FONT 10 Tf 40 100 Td (SECRET) Tj (ALPHA) Tj ET',
      'BT $FONT 10 Tf 40 300 Td (AL) Tj (PHA) Tj (PUBLIC) Tj ET', area],
    ['intervening rendering mode', 'BT $FONT 10 Tf 40 100 Td (SECRET) Tj 7 Tr (TOKEN) Tj ET',
      'BT $FONT 10 Tf 40 300 Td (VISIBLE) Tj ET', area],
    ['intervening position change', 'BT $FONT 10 Tf 40 100 Td (SECRET) Tj 100 0 Td (TOKEN) Tj ET',
      'BT $FONT 10 Tf 40 300 Td (VISIBLE) Tj ET', area],
    ['intervening text leading', 'BT $FONT 10 Tf 40 100 Td (SECRET) Tj T* (TOKEN) Tj ET',
      'BT $FONT 10 Tf 40 300 Td (VISIBLE) Tj ET', area],
    ['mismatched show operator', 'BT $FONT 10 Tf 40 100 Td [(SECRET)] Tj (TOKEN) Tj ET',
      'BT $FONT 10 Tf 40 300 Td (VISIBLE) Tj ET', area],
  ])('rejects %s before mutation', async (_name, secret, visible, mark) => {
    const doc = await fixture(secret, visible);
    redactionEngine.markRegion(doc, 0, mark);
    const before = await serializeDocument(doc);
    expect(() => prepareIsolatedTextRedaction(doc)).toThrow();
    expect(await serializeDocument(doc)).toEqual(before);
  });
});
