import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePDF, getPageContentBytes } from '../parser/parser';
import { updatePageContent } from '../editor/stream-compiler';
import { PDFDict, PDFNumber, PDFRef } from '../types';
import { serializeDocument } from '../writer/serializer';
import { saveQuick } from '../writer/save-pipeline';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { prepareIsolatedTextRedaction } from '../security/redaction/isolated-text-redaction';

const area = { x: 15, y: 75, width: 170, height: 50 };
const hasPoppler = ['pdftotext', 'pdftoppm'].every(name => spawnSync(name, ['-v'], { stdio: 'ignore' }).status === 0);

async function fixture(position: string, visiblePosition: string, secretColor = '') {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([500, 500]);
  const font = await pdf.embedFont(StandardFonts.Courier);
  page.drawText('fixture', { font });
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  doc.xref.trailerDict.delete('Info');
  const pageInfo = doc.pages[0], fonts = pageInfo.resources.getDict('Font')!;
  const name = [...fonts.keys()][0], resources = new PDFDict([['Font', fonts]]);
  pageInfo.dict.set('Resources', resources);
  pageInfo.resources = resources;
  pageInfo.dict.set('Contents', pageInfo.contentRefs[0]);
  const text = `q BT ${secretColor}/${name} 10 Tf ${position} (SECRET) Tj ET Q\n` +
    `q BT /${name} 10 Tf ${visiblePosition} (VISIBLE) Tj ET Q\n`;
  await updatePageContent(pageInfo.contentRefs, new TextEncoder().encode(text), doc.objects, false);
  return parsePDF(await serializeDocument(doc));
}

describe('isolated text positioning redaction', () => {
  it.skipIf(!hasPoppler).each([
    ['Td with default color', '40 100 Td', '280 300 Td', ''],
    ['TD with restored graphics state', '40 100 TD', '280 300 TD', '1 0 0 rg '],
    ['exact decimal identity matrix', '+01.00 -.0 0.000 1. 40 100 Tm', '1.0 0.0 0 1 280 300 Tm', ''],
  ])('removes text using %s and preserves outside pixels', async (_name, position, visiblePosition, color) => {
    const doc = await fixture(position, visiblePosition, color);
    const before = await serializeDocument(doc);
    redactionEngine.markRegion(doc, 0, area);
    expect((await redactionEngine.applySecureRedactions(doc)).textOperatorsRemoved).toBe(1);
    const after = await saveQuick(doc);
    const reopened = await parsePDF(after);
    const content = new TextDecoder().decode(getPageContentBytes(reopened.pages[0], reopened.objects));
    expect(content).toContain('VISIBLE');
    expect(content).not.toContain('SECRET');
    expect((await PDFDocument.load(after)).getPageCount()).toBe(1);
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-position-redaction-'));
    try {
      const beforePath = join(dir, 'before.pdf'), afterPath = join(dir, 'after.pdf');
      writeFileSync(beforePath, before); writeFileSync(afterPath, after);
      if (spawnSync('qpdf', ['--version'], { stdio: 'ignore' }).status === 0) {
        execFileSync('qpdf', ['--check', beforePath]);
        execFileSync('qpdf', ['--check', afterPath]);
      }
      const extract = (path: string) => execFileSync('pdftotext', [path, '-'], { encoding: 'utf8' });
      expect(extract(beforePath)).toContain('SECRET');
      expect(extract(beforePath)).toContain('VISIBLE');
      expect(extract(afterPath)).not.toContain('SECRET');
      expect(extract(afterPath)).toContain('VISIBLE');
      for (const dpi of [36, 72, 150, 300]) {
        const render = (path: string, label: string) => {
          const prefix = join(dir, `${label}-${dpi}`);
          execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', String(dpi), path, prefix]);
          const data = readFileSync(`${prefix}.ppm`);
          const header = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(data.toString('latin1', 0, 64));
          if (!header) throw new Error('Unexpected PPM output');
          return { pixels: data.subarray(header[0].length), width: Number(header[1]), height: Number(header[2]) };
        };
        const original = render(beforePath, 'before'), cleaned = render(afterPath, 'after');
        expect([original.width, original.height]).toEqual([cleaned.width, cleaned.height]);
        let inside = 0, outside = 0;
        for (let y = 0; y < original.height; y++) for (let x = 0; x < original.width; x++) {
          const i = (y * original.width + x) * 3;
          if (original.pixels[i] === cleaned.pixels[i] && original.pixels[i + 1] === cleaned.pixels[i + 1] && original.pixels[i + 2] === cleaned.pixels[i + 2]) continue;
          const left = x * 72 / dpi, right = (x + 1) * 72 / dpi;
          const bottom = 500 - (y + 1) * 72 / dpi, top = 500 - y * 72 / dpi;
          if (right <= area.x || left >= area.x + area.width || top <= area.y || bottom >= area.y + area.height) outside++;
          else inside++;
        }
        expect(inside).toBeGreaterThan(0);
        expect(outside).toBe(0);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  it.each([
    '1.00000000000000001 0 0 1 40 100 Tm',
    '1 0.0000000000000000000001 0 1 40 100 Tm',
    '1 0 0 1 40 100 Tm 0 0 Td',
    '1 0 0 1 40 100 Tm 0 Tc',
  ])('rejects unsupported positioning or state without mutation: %s', async position => {
    const doc = await fixture(position, '280 300 Td');
    redactionEngine.markRegion(doc, 0, area);
    const before = await serializeDocument(doc);
    expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/unsupported|cannot be inspected/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('rejects a shared content stream before modifying either page', async () => {
    const doc = await fixture('40 100 Td', '280 300 Td');
    const page = doc.pages[0], root = doc.objects.get(doc.catalog.getRef('Pages')!.toKey()) as PDFDict;
    const next = Math.max(...[...doc.objects.keys()].map(key => Number(key.split('_')[0]))) + 1;
    const newRef = new PDFRef(next, 0), copy = new PDFDict([...page.dict.entries()]);
    doc.objects.set(newRef.toKey(), copy);
    root.getArray('Kids')!.items.push(newRef);
    root.set('Count', new PDFNumber(2));
    const reopened = await parsePDF(await serializeDocument(doc));
    redactionEngine.markRegion(reopened, 0, area);
    const before = await serializeDocument(reopened);
    expect(() => prepareIsolatedTextRedaction(reopened)).toThrow(/shared|duplicated/);
    expect(await serializeDocument(reopened)).toEqual(before);
  });
});
