import { PDFDocument, PDFName } from 'pdf-lib';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { getPageContentBytes, parsePDF } from '../parser/parser';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { preparePartialGraphicsRedaction } from '../security/redaction/partial-graphics-redaction';
import { serializeDocument } from '../writer/serializer';
import { saveQuick } from '../writer/save-pipeline';

const region = { x: 10, y: 10, width: 20, height: 20 };
async function fixture(content: string) {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const page = pdf.addPage([200, 200]);
  page.node.set(PDFName.of('Contents'), pdf.context.register(pdf.context.stream(content)));
  return parsePDF(await pdf.save({ useObjectStreams: false }));
}
function mark(doc: Awaited<ReturnType<typeof parsePDF>>, area = region) {
  redactionEngine.markRegion(doc, 0, area);
}

describe('multi-rectangle paths', () => {
  it.each(['f', 'F', 'f*', 'S', 's', 'B', 'B*', 'b', 'b*'])('removes a completely covered multi-rectangle path with %s', async operator => {
    const doc = await fixture(`2 w 1 0 0 rg 1 0 0 RG 15 15 10 8 re 17 17 6 4 re ${operator} 0 0 1 rg 100 100 15 13 re f`);
    mark(doc);
    expect((await redactionEngine.applySecureRedactions(doc)).pathOperatorsRemoved).toBe(2);
    const bytes = await saveQuick(doc);
    const reopened = await parsePDF(bytes);
    const content = new TextDecoder().decode(getPageContentBytes(reopened.pages[0], reopened.objects));
    expect(content).not.toContain('15 15 10 8 re');
    expect(content).not.toContain('17 17 6 4 re');
    expect(content).toContain('100 100 15 13 re\nf');
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });

  it.each(['f', 'f*', 'B', 'B*'])('allows removing the whole overlapping path with %s', async operator => {
    const doc = await fixture(`1 w 15 15 10 8 re 18 18 6 4 re ${operator}`);
    mark(doc);
    expect((await redactionEngine.applySecureRedactions(doc)).pathOperatorsRemoved).toBe(2);
    const bytes = await saveQuick(doc);
    const reopened = await parsePDF(bytes);
    const content = new TextDecoder().decode(getPageContentBytes(reopened.pages[0], reopened.objects));
    expect(content).not.toContain('15 15 10 8 re');
    expect(content).not.toContain('18 18 6 4 re');
  });

  it.each(['f', 'F', 'f*', 'S', 's', 'B', 'B*', 'b', 'b*'])('rejects partial removal from a path with %s', async operator => {
    const doc = await fixture(`2 w 15 15 10 8 re 100 100 15 13 re ${operator}`);
    mark(doc);
    const before = await serializeDocument(doc);
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/partially removed rectangle paths/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('rejects fractional mixed fills that changed retained editor pixels in experiments', async () => {
    const doc = await fixture('.5 .3 .2 rg 14 15 8.1 6.7 re 95 101 17.1 14.8 re f');
    mark(doc, { x: 8, y: 8, width: 35, height: 35 });
    const before = await serializeDocument(doc);
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/partially removed rectangle paths/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it.each([
    ['overlap', '15 15 10 8 re 24 19 10 5 re f'],
    ['touching', '15 15 10 8 re 25 16 12 5 re f*'],
    ['partial stroke', '4 w 15 15 10 8 re 31 18 12 5 re S'],
    ['incomplete', '15 15 10 8 re 100 100 15 13 re'],
    ['interleaved transform', '15 15 10 8 re 1 0 0 1 1 1 cm 100 100 15 13 re f'],
  ])('rejects %s before mutation', async (_name, content) => {
    const doc = await fixture(content);
    mark(doc);
    const before = await serializeDocument(doc);
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow();
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('rejects a matching retained rectangle rather than leaving a copy', async () => {
    const doc = await fixture('15 15 10 8 re 17 17 6 4 re f 100 100 10 8 re f');
    mark(doc);
    const before = await serializeDocument(doc);
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/duplicates removed vector/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('bounds subpaths before modifying the document', async () => {
    const doc = await fixture(`${Array.from({ length: 129 }, (_, i) => `${i} 40 1 1 re`).join(' ')} f`);
    mark(doc);
    const before = await serializeDocument(doc);
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/inspection limit/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('can redact another independent path after saving and reopening', async () => {
    const doc = await fixture('15 15 10 8 re 17 17 6 4 re f* 100 100 15 13 re f*');
    mark(doc);
    await redactionEngine.applySecureRedactions(doc);
    const first = await saveQuick(doc);
    const reopened = await parsePDF(first);
    mark(reopened, { x: 95, y: 95, width: 25, height: 25 });
    await redactionEngine.applySecureRedactions(reopened);
    const second = await saveQuick(reopened);
    const final = await parsePDF(second);
    expect(new TextDecoder().decode(getPageContentBytes(final.pages[0], final.objects))).not.toContain(' re');
    expect((await PDFDocument.load(second)).getPageCount()).toBe(1);
  });
});

const poppler = spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status === 0;
it.skipIf(!poppler).each(['f', 'F', 'f*', 'S', 'B*'])('preserves every fully unmarked pixel for multiple rectangles with %s', async operator => {
  const doc = await fixture(`2 w 1 0 0 rg 1 0 0 RG 15 15 10 8 re 17 17 6 4 re ${operator} 0 0 1 rg 100 100 15 13 re f`);
  const before = await serializeDocument(doc);
  mark(doc);
  await redactionEngine.applySecureRedactions(doc);
  const after = await saveQuick(doc);
  const dir = mkdtempSync(join(tmpdir(), 'paperloom-multirect-'));
  try {
    const render = (bytes: Uint8Array, label: string, dpi: number) => {
      const path = join(dir, `${label}.pdf`), prefix = join(dir, label);
      writeFileSync(path, bytes);
      execFileSync('pdftoppm', ['-f', '1', '-l', '1', '-singlefile', '-r', String(dpi), path, prefix]);
      const ppm = readFileSync(`${prefix}.ppm`);
      const header = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(ppm.toString('latin1', 0, 100));
      if (!header) throw new Error('Unexpected Poppler PPM output');
      return { width: Number(header[1]), height: Number(header[2]), pixels: ppm.subarray(header[0].length) };
    };
    for (const dpi of [12, 18, 36, 72, 150, 300]) {
      const original = render(before, 'original', dpi), result = render(after, 'result', dpi);
      expect(result.width).toBe(original.width);
      expect(result.height).toBe(original.height);
      let differences = 0, insideDifferences = 0;
      const examples: string[] = [];
      for (let row = 0; row < original.height; row++) for (let x = 0; x < original.width; x++) {
        const i = (row * original.width + x) * 3;
        const differs = original.pixels[i] !== result.pixels[i] || original.pixels[i + 1] !== result.pixels[i + 1] || original.pixels[i + 2] !== result.pixels[i + 2];
        if (!differs) continue;
        const left = x * 72 / dpi, right = (x + 1) * 72 / dpi;
        const top = 200 - row * 72 / dpi, bottom = 200 - (row + 1) * 72 / dpi;
        if (right <= region.x || left >= region.x + region.width || top <= region.y || bottom >= region.y + region.height) {
          differences++;
          if (examples.length < 5) examples.push(`${x},${row}`);
        }
        else insideDifferences++;
      }
      expect(insideDifferences).toBeGreaterThan(0);
      expect(differences, `dpi ${dpi}; outside examples ${examples.join('; ')}`).toBe(0);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 20_000);
