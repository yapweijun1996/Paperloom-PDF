import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';
import { updatePageContent } from '../editor/stream-compiler';
import { PDFArray, PDFDict, PDFNumber, PDFRef, PDFStream } from '../types';
import { serializeDocument } from '../writer/serializer';
import { saveQuick } from '../writer/save-pipeline';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { prepareIsolatedTextRedaction } from '../security/redaction/isolated-text-redaction';

const mark = { x: 15, y: 75, width: 170, height: 50 };
const poppler = ['pdftotext', 'pdftoppm'].every(tool => !spawnSync(tool, ['-v'], { stdio: 'ignore' }).error);

async function fixture(make: (first: string, second: string) => string[]) {
  const source = await PDFDocument.create(), page = source.addPage([500, 500]);
  page.drawText('fixture-a', { font: await source.embedFont(StandardFonts.Courier) });
  page.drawText('fixture-b', { font: await source.embedFont(StandardFonts.Helvetica) });
  const doc = await parsePDF(await source.save({ useObjectStreams: false }));
  doc.xref.trailerDict.delete('Info');
  const target = doc.pages[0], fonts = target.resources.getDict('Font')!;
  const names = [...fonts.keys()];
  const streams = make(`/${names[0]}`, `/${names[1]}`), bytes = streams.map(s => new TextEncoder().encode(`${s}\n`));
  const resources = new PDFDict([['Font', fonts]]);
  target.dict.set('Resources', resources); target.resources = resources;
  target.dict.set('Contents', target.contentRefs[0]);
  await updatePageContent(target.contentRefs, bytes[0], doc.objects, false);
  for (const data of bytes.slice(1)) {
    const ref = new PDFRef(Math.max(...[...doc.objects.keys()].map(key => Number(key.split('_')[0]))) + 1, 0);
    doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(data.length)]]), data, data));
    target.contentRefs.push(ref);
  }
  target.dict.set('Contents', new PDFArray([...target.contentRefs]));
  return parsePDF(await serializeDocument(doc));
}

function pixels(file: string, folder: string, label: string, dpi: number) {
  const prefix = join(folder, `${label}-${dpi}`);
  execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', String(dpi), file, prefix]);
  const ppm = readFileSync(`${prefix}.ppm`), header = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(ppm.toString('latin1', 0, 64));
  if (!header) throw new Error('Invalid PPM');
  return { bytes: ppm.subarray(header[0].length), width: Number(header[1]), height: Number(header[2]) };
}

describe('bare text state isolation', () => {
  it.skipIf(!poppler)('preserves differently styled adjacent blocks across three streams', async () => {
    const doc = await fixture((a, b) => [
      `BT ${a} 11 Tf 27 TL 240 260 Td (BEFORE) Tj T* ET\nBT ${b} 10 Tf 40 100 TD (SECRET) Tj T* ET`,
      `q BT 0 0 1 rg ${a} 13 Tf 1 0 0 1 300 320 Tm (AFTER) Tj ET Q`,
      `BT ${b} 11 Tf 260 190 Td (TAIL) Tj T* ET`,
    ]);
    const original = await serializeDocument(doc);
    redactionEngine.markRegion(doc, 0, mark);
    expect((await redactionEngine.applySecureRedactions(doc)).textOperatorsRemoved).toBe(1);
    const result = await saveQuick(doc);
    const folder = mkdtempSync(join(tmpdir(), 'paperloom-bare-state-'));
    try {
      const before = join(folder, 'before.pdf'), after = join(folder, 'after.pdf');
      writeFileSync(before, original); writeFileSync(after, result);
      if (!spawnSync('qpdf', ['--version'], { stdio: 'ignore' }).error) {
        execFileSync('qpdf', ['--check', before]); execFileSync('qpdf', ['--check', after]);
      }
      const extractedBefore = execFileSync('pdftotext', [before, '-'], { encoding: 'utf8' });
      const extractedAfter = execFileSync('pdftotext', [after, '-'], { encoding: 'utf8' });
      expect(extractedBefore).toContain('SECRET'); expect(extractedAfter).not.toContain('SECRET');
      for (const visible of ['BEFORE', 'AFTER', 'TAIL']) expect(extractedAfter).toContain(visible);
      for (const dpi of [12, 36, 72, 150, 300]) {
        const a = pixels(before, folder, 'before', dpi), b = pixels(after, folder, 'after', dpi);
        expect([a.width, a.height]).toEqual([b.width, b.height]);
        let outside = 0;
        for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
          const i = (y * a.width + x) * 3;
          if (a.bytes[i] === b.bytes[i] && a.bytes[i + 1] === b.bytes[i + 1] && a.bytes[i + 2] === b.bytes[i + 2]) continue;
          const left = x * 72 / dpi, right = (x + 1) * 72 / dpi, bottom = 500 - (y + 1) * 72 / dpi, top = 500 - y * 72 / dpi;
          if (right <= mark.x || left >= mark.x + mark.width || top <= mark.y || bottom >= mark.y + mark.height) outside++;
        }
        expect(outside).toBe(0);
      }
    } finally { rmSync(folder, { recursive: true, force: true }); }
  }, 30_000);

  it.each([
    (a: string, b: string) => [`BT ${a} 10 Tf 7 Tr 40 100 Td (SECRET) Tj ET`, `BT ${b} 10 Tf 280 300 Td (VISIBLE) Tj ET`],
    (a: string, b: string) => [`BT ${a} 10 Tf 40 100 TD (SECRET) Tj ET`, `BT ${b} 10 Tf T* (VISIBLE) Tj ET`],
    (a: string, b: string) => [`q BT 1 0 0 rg ${a} 10 Tf 40 100 Td (SECRET) Tj ET`, `BT ${b} 10 Tf 280 300 Td (VISIBLE) Tj ET Q`],
    (a: string, b: string) => [`BT ${a} 10 Tf 40 100 Td (SECRET) Tj ET`, `BT ${b} 10 Tf 1 Tc 280 300 Td (VISIBLE) Tj ET`],
  ])('rejects leaking or inherited state before mutation', async make => {
    const doc = await fixture(make); redactionEngine.markRegion(doc, 0, mark);
    const before = await serializeDocument(doc);
    expect(() => prepareIsolatedTextRedaction(doc)).toThrow();
    expect(await serializeDocument(doc)).toEqual(before);
  });
});
