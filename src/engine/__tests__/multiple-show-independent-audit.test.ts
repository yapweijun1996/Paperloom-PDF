import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { expect, it } from 'vitest';
import { getPageContentBytes, parsePDF } from '../parser/parser';
import { updatePageContent } from '../editor/stream-compiler';
import { PDFArray, PDFDict, PDFNumber, PDFRef, PDFStream } from '../types';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { prepareIsolatedTextRedaction } from '../security/redaction/isolated-text-redaction';
import { serializeDocument } from '../writer/serializer';
import { saveQuick } from '../writer/save-pipeline';

async function fixture(secret: string, kept: string) {
  const pdf = await PDFDocument.create();
  pdf.addPage([800, 400]).drawText('fixture', { font: await pdf.embedFont(StandardFonts.Courier) });
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  doc.xref.trailerDict.delete('Info');
  const page = doc.pages[0], fonts = page.resources.getDict('Font')!;
  const name = [...fonts.keys()][0];
  page.resources = new PDFDict([['Font', fonts]]); page.dict.set('Resources', page.resources);
  await updatePageContent(page.contentRefs, new TextEncoder().encode(secret.replaceAll('$FONT', `/${name}`) + '\n'), doc.objects, false);
  const content = new TextEncoder().encode(kept.replaceAll('$FONT', `/${name}`) + '\n');
  const ref = new PDFRef(900, 0);
  doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(content.length)]]), content, content));
  page.dict.set('Contents', new PDFArray([page.contentRefs[0], ref]));
  page.contentRefs.push(ref);
  return parsePDF(await serializeDocument(doc));
}
const toolsAvailable = ['qpdf', 'pdftotext', 'pdftoppm'].every(name => !spawnSync(name, ['-v'], { stdio: 'ignore' }).error);
const marked = { x: 90, y: 70, width: 650, height: 60 };
const multi = 'BT $FONT 10 Tf 200 100 Td [(SECRET) 8000 (TOKEN)] TJ [(TAIL) -16000 (FINISH)] TJ ET';
const visible = 'BT $FONT 10 Tf 40 300 Td (VISIBLE) Tj (PUBLIC) Tj ET';

it.skipIf(!toolsAvailable && !process.env.CI)('removes consecutive TJ operations with opposing movement and retains outside pixels', async () => {
  const doc = await fixture(multi, visible), before = await serializeDocument(doc);
  redactionEngine.markRegion(doc, 0, marked);
  expect(prepareIsolatedTextRedaction(doc).commit().textOperatorsRemoved).toBe(2);
  const after = await saveQuick(doc), reopened = await parsePDF(after);
  const content = new TextDecoder().decode(getPageContentBytes(reopened.pages[0], reopened.objects));
  for (const removed of ['SECRET', 'TOKEN', 'TAIL', 'FINISH']) expect(content).not.toContain(removed);
  expect(content).toContain('VISIBLE'); expect(content).toContain('PUBLIC');
  const directory = mkdtempSync(join(tmpdir(), 'paperloom-tj-audit-'));
  try {
    const old = join(directory, 'before.pdf'), output = join(directory, 'after.pdf');
    writeFileSync(old, before); writeFileSync(output, after);
    execFileSync('qpdf', ['--check', old], { stdio: 'ignore' }); execFileSync('qpdf', ['--check', output], { stdio: 'ignore' });
    expect(execFileSync('pdftotext', [output, '-'], { encoding: 'utf8' })).toContain('VISIBLE');
    for (const dpi of [12, 36, 72, 150, 300]) {
      const render = (file: string, suffix: string) => {
        const prefix = join(directory, `${suffix}-${dpi}`);
        execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', String(dpi), file, prefix]);
        const ppm = readFileSync(`${prefix}.ppm`), header = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(ppm.toString('latin1', 0, 64));
        if (!header) throw new Error('Invalid PPM');
        return { data: ppm.subarray(header[0].length), width: Number(header[1]), height: Number(header[2]) };
      };
      const a = render(old, 'a'), b = render(output, 'b');
      expect([a.width, a.height]).toEqual([b.width, b.height]);
      let inside = 0, outside = 0;
      for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
        const i = (y * a.width + x) * 3;
        if (a.data[i] === b.data[i] && a.data[i + 1] === b.data[i + 1] && a.data[i + 2] === b.data[i + 2]) continue;
        const left = x * 72 / dpi, right = (x + 1) * 72 / dpi, bottom = 400 - (y + 1) * 72 / dpi, top = 400 - y * 72 / dpi;
        if (right <= marked.x || left >= marked.x + marked.width || top <= marked.y || bottom >= marked.y + marked.height) outside++; else inside++;
      }
      expect(inside).toBeGreaterThan(0); expect(outside).toBe(0);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 30_000);

it('rejects a split secret duplicated by separate Tj operators in another stream', async () => {
  const secret = 'BT $FONT 10 Tf 200 100 Td (SECRET) Tj (NEEDLE) Tj ET';
  const retained = 'BT $FONT 10 Tf 40 300 Td (NEE) Tj (DLE) Tj (PUBLIC) Tj ET';
  const doc = await fixture(secret, retained);
  redactionEngine.markRegion(doc, 0, marked);
  const before = await serializeDocument(doc);
  expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/retained data contains redacted text/);
  expect(await serializeDocument(doc)).toEqual(before);
});

it('rejects a mark which misses part of text displaced by consecutive TJ adjustments', async () => {
  const doc = await fixture(multi, visible);
  redactionEngine.markRegion(doc, 0, { x: 180, y: 80, width: 120, height: 40 });
  const before = await serializeDocument(doc);
  expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/partially intersects/);
  expect(await serializeDocument(doc)).toEqual(before);
});
