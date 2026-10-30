import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parsePDF, getPageContentBytes } from '../parser/parser';
import { updatePageContent } from '../editor/stream-compiler';
import { PDFDict, PDFHexString } from '../types';
import { serializeDocument } from '../writer/serializer';
import { saveQuick } from '../writer/save-pipeline';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { prepareIsolatedTextRedaction } from '../security/redaction/isolated-text-redaction';
import { decodeStrictHexString } from '../security/strict-hex-string';

const area = { x: 5, y: 75, width: 520, height: 50 };
const hasPoppler = ['pdftotext', 'pdftoppm'].every(name => spawnSync(name, ['-v'], { stdio: 'ignore' }).status === 0);

async function fixture(first: string, second = 'BT $FONT 10 Tf 40 300 Td (VISIBLE) Tj ET', twoPages = false) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < (twoPages ? 2 : 1); i++) pdf.addPage([600, 500]).drawText('fixture', { font });
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  doc.xref.trailerDict.delete('Info');
  for (let i = 0; i < doc.pages.length; i++) {
    const page = doc.pages[i], fonts = page.resources.getDict('Font')!;
    const resourceName = [...fonts.keys()][0];
    page.resources = new PDFDict([['Font', fonts]]);
    page.dict.set('Resources', page.resources);
    page.dict.set('Contents', page.contentRefs[0]);
    const content = (i === 0 ? `${first}\n${twoPages ? '' : second}` : second).replaceAll('$FONT', `/${resourceName}`);
    await updatePageContent(page.contentRefs, new TextEncoder().encode(`${content}\n`), doc.objects, false);
  }
  return parsePDF(await serializeDocument(doc));
}

describe('isolated redaction of hex strings containing PDF whitespace', () => {
  it('uses PDF whitespace and odd-nibble padding when decoding retained values', () => {
    const raw = '5\x003\t4\n5\f4\r3 5';
    expect(decodeStrictHexString(raw)).toEqual(Uint8Array.from([0x53, 0x45, 0x43, 0x50]));
    expect(new PDFHexString(raw).toBytes()).toEqual(Uint8Array.from([0x53, 0x45, 0x43, 0x50]));
    expect(decodeStrictHexString('53\v45')).toBeUndefined();
    expect(decodeStrictHexString('0'.repeat(262_145))).toBeUndefined();
  });
  it.skipIf(!hasPoppler).each([
    ['Tj with all PDF whitespace characters', 'BT $FONT 10 Tf 40 100 Td <53\x00 45\t43\n52\f45\r54> Tj ET'],
    ['TJ with spaced fragments', 'q BT 0 g $FONT 10 Tf 40 100 Td [<53 45 43> -100 <52\n45\t54>] TJ ET Q'],
  ])('removes %s and preserves rendered pixels outside the mark', async (_name, secret) => {
    const doc = await fixture(secret);
    const before = await serializeDocument(doc);
    redactionEngine.markRegion(doc, 0, area);
    expect((await redactionEngine.applySecureRedactions(doc)).textOperatorsRemoved).toBe(1);
    const after = await saveQuick(doc), reopened = await parsePDF(after);
    const content = new TextDecoder().decode(getPageContentBytes(reopened.pages[0], reopened.objects));
    expect(content).toContain('VISIBLE');
    expect(content).not.toContain('<53');
    expect((await PDFDocument.load(after)).getPageCount()).toBe(1);
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-hex-redaction-'));
    try {
      const input = join(dir, 'before.pdf'), output = join(dir, 'after.pdf');
      writeFileSync(input, before); writeFileSync(output, after);
      if (spawnSync('qpdf', ['--version'], { stdio: 'ignore' }).status === 0) {
        execFileSync('qpdf', ['--check', input]); execFileSync('qpdf', ['--check', output]);
      } else if (process.env.CI) throw new Error('qpdf is required for CI verification');
      expect(execFileSync('pdftotext', [input, '-'], { encoding: 'utf8' })).toContain('SECRET');
      const extracted = execFileSync('pdftotext', [output, '-'], { encoding: 'utf8' });
      expect(extracted).not.toContain('SECRET'); expect(extracted).toContain('VISIBLE');
      for (const dpi of [36, 72, 150, 300]) {
        const render = (file: string, label: string) => {
          const prefix = join(dir, `${label}-${dpi}`);
          execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', String(dpi), file, prefix]);
          const ppm = readFileSync(`${prefix}.ppm`), header = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(ppm.toString('latin1', 0, 64));
          if (!header) throw new Error('Invalid PPM');
          return { pixels: ppm.subarray(header[0].length), width: Number(header[1]), height: Number(header[2]) };
        };
        const a = render(input, 'before'), b = render(output, 'after');
        expect([a.width, a.height]).toEqual([b.width, b.height]);
        let inside = 0, outside = 0;
        for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
          const index = (y * a.width + x) * 3;
          if (a.pixels[index] === b.pixels[index] && a.pixels[index + 1] === b.pixels[index + 1] && a.pixels[index + 2] === b.pixels[index + 2]) continue;
          const left = x * 72 / dpi, right = (x + 1) * 72 / dpi, bottom = 500 - (y + 1) * 72 / dpi, top = 500 - y * 72 / dpi;
          if (right <= area.x || left >= area.x + area.width || top <= area.y || bottom >= area.y + area.height) outside++; else inside++;
        }
        expect(inside).toBeGreaterThan(0); expect(outside).toBe(0);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  it.each([
    ['literal', 'BT $FONT 10 Tf 40 300 Td (SECRET) Tj ET'],
    ['spaced hex', 'BT $FONT 10 Tf 40 300 Td <53 45 43 52 45 54> Tj ET'],
    ['fragments split across operations', 'BT $FONT 10 Tf 40 300 Td <53 45 43> Tj <52 45 54> Tj ET'],
  ])('rejects a retained %s copy on another page without mutation', async (_name, retained) => {
    const doc = await fixture('BT $FONT 10 Tf 40 100 Td <53 45 43 52 45 54> Tj ET', retained, true);
    redactionEngine.markRegion(doc, 0, area);
    const before = await serializeDocument(doc);
    expect(() => prepareIsolatedTextRedaction(doc)).toThrow('retained data contains redacted text');
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it.each([
    ['odd nibble', '<53 45 43 52 45 7>'],
    ['invalid hex character', '<53 45 43 52 45 7G>'],
    ['comment in hex string', '<53 45 % comment\n43 52 45 54>'],
  ])('rejects %s without mutation', async (_name, operand) => {
    const doc = await fixture(`BT $FONT 10 Tf 40 100 Td ${operand} Tj ET`);
    redactionEngine.markRegion(doc, 0, area);
    const before = await serializeDocument(doc);
    expect(() => prepareIsolatedTextRedaction(doc)).toThrow();
    expect(await serializeDocument(doc)).toEqual(before);
  });
});
