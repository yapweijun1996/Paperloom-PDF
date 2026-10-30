import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { parsePDF, getPageContentBytes } from '../parser/parser';
import { updatePageContent } from '../editor/stream-compiler';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, PDFString } from '../types';
import { serializeDocument } from '../writer/serializer';
import { saveQuick } from '../writer/save-pipeline';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { prepareIsolatedTextRedaction } from '../security/redaction/isolated-text-redaction';

const pdfText = (text: string) => Buffer.from(text, 'ascii').toString('hex').toUpperCase();
const marked = { x: 15, y: 75, width: 170, height: 50 };
const multiMarked = { x: 15, y: 75, width: 210, height: 50 };
const latinBaseFonts = [
  StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique,
  StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique,
  StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic,
];

async function fixture(duplicate = false) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([500, 500]);
  const font = await pdf.embedFont(StandardFonts.Courier);
  page.drawText('SECRET', { x: 40, y: 100, size: 10, font });
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  doc.xref.trailerDict.delete('Info');
  const fonts = doc.pages[0].resources.getDict('Font')!;
  const name = [...fonts.keys()][0];
  const resources = new PDFDict([['Font', fonts]]);
  doc.pages[0].dict.set('Resources', resources);
  doc.pages[0].resources = resources;
  doc.pages[0].dict.set('Contents', doc.pages[0].contentRefs[0]);
  doc.pages[0].dict.delete('Annots');
  const survivor = duplicate ? 'SECRET' : 'VISIBLE';
  const content = `q\nBT\n0 0 0 rg\n/${name} 10 Tf\n1 0 0 1 40 100 Tm\n<${pdfText('SECRET')}> Tj\nET\nQ\n` +
    `q\nBT\n0 0 0 rg\n/${name} 10 Tf\n1 0 0 1 280 300 Tm\n<${pdfText(survivor)}> Tj\nET\nQ\n`;
  await updatePageContent(doc.pages[0].contentRefs, new TextEncoder().encode(content), doc.objects, false);
  return parsePDF(await serializeDocument(doc));
}
function mark(doc: Awaited<ReturnType<typeof fixture>>, rect = marked) {
  redactionEngine.markRegion(doc, 0, rect);
}

async function multiPageFixture(lastText = 'SURVIVOR', pageCount = 3) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Courier);
  for (let index = 0; index < pageCount; index++) pdf.addPage([500, 500]).drawText('fixture', { font });
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  doc.xref.trailerDict.delete('Info');
  for (let index = 0; index < doc.pages.length; index++) {
    const page = doc.pages[index], fonts = page.resources.getDict('Font')!;
    const name = [...fonts.keys()][0];
    const resources = new PDFDict([['Font', fonts]]);
    page.dict.set('Resources', resources); page.resources = resources;
    page.dict.set('Contents', page.contentRefs[0]);
    const secret = index === 0 ? 'SECRET' : index === 1 ? 'PRIVATE' : lastText;
    const content = `q BT 0 g /${name} 10 Tf 1 0 0 1 40 100 Tm <${pdfText(secret)}> Tj ET Q\n` +
      `q BT 0 g /${name} 10 Tf 1 0 0 1 280 300 Tm (Visible${index}) Tj ET Q`;
    await updatePageContent(page.contentRefs, new TextEncoder().encode(content), doc.objects, false);
  }
  return parsePDF(await serializeDocument(doc));
}

async function nestedPageFixture() {
  const doc = await multiPageFixture();
  const rootRef = doc.catalog.getRef('Pages')!;
  const root = doc.objects.get(rootRef.toKey()) as PDFDict;
  const next = Math.max(...[...doc.objects.keys()].map(key => Number(key.split('_')[0]))) + 1;
  const leftRef = new PDFRef(next, 0), rightRef = new PDFRef(next + 1, 0), nestedRef = new PDFRef(next + 2, 0);
  const branch = (parent: PDFRef, kids: PDFRef[], count: number) => new PDFDict([
    ['Type', new PDFName('Pages')], ['Parent', parent], ['Kids', new PDFArray(kids)], ['Count', new PDFNumber(count)],
  ]);
  doc.objects.set(leftRef.toKey(), branch(rootRef, [doc.pages[0].ref], 1));
  doc.objects.set(rightRef.toKey(), branch(rootRef, [nestedRef, doc.pages[2].ref], 2));
  doc.objects.set(nestedRef.toKey(), branch(rightRef, [doc.pages[1].ref], 1));
  doc.pages[0].dict.set('Parent', leftRef);
  doc.pages[1].dict.set('Parent', nestedRef);
  doc.pages[2].dict.set('Parent', rightRef);
  root.set('Kids', new PDFArray([leftRef, rightRef]));
  return parsePDF(await serializeDocument(doc));
}

async function multiStreamFixture() {
  const doc = await fixture(), page = doc.pages[0];
  const name = [...page.resources.getDict('Font')!.keys()][0];
  const block = (text: string, x: number, y: number) =>
    `q BT 0 g /${name} 10 Tf 1 0 0 1 ${x} ${y} Tm (${text}) Tj ET Q\n`;
  const start = Math.max(...[...doc.objects.keys()].map(key => Number(key.split('_')[0]))) + 1;
  const refs = [page.contentRefs[0], new PDFRef(start, 0), new PDFRef(start + 1, 0)];
  [block('SECRET', 40, 100), block('PRIVATE', 40, 100), block('VISIBLE', 280, 300)].forEach((text, i) => {
    const bytes = new TextEncoder().encode(text);
    doc.objects.set(refs[i].toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(bytes.length)]]), bytes, bytes));
  });
  page.dict.set('Contents', new PDFArray(refs));
  page.contentRefs.splice(0, page.contentRefs.length, ...refs);
  return parsePDF(await serializeDocument(doc));
}

function indirectContentArray(doc: Awaited<ReturnType<typeof fixture>>, alias = false): PDFRef {
  const page = doc.pages[0];
  const array = page.dict.getArray('Contents')!;
  const next = Math.max(...[...doc.objects.keys()].map(key => Number(key.split('_')[0]))) + 1;
  const arrayRef = new PDFRef(next, 0);
  doc.objects.set(arrayRef.toKey(), array);
  if (alias) {
    const aliasRef = new PDFRef(next + 1, 0);
    doc.objects.set(aliasRef.toKey(), arrayRef);
    page.dict.set('Contents', aliasRef);
    return aliasRef;
  }
  page.dict.set('Contents', arrayRef);
  return arrayRef;
}

function replaceStream(doc: Awaited<ReturnType<typeof fixture>>, ref: PDFRef, text: string) {
  const bytes = new TextEncoder().encode(text);
  doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(bytes.length)]]), bytes, bytes));
}

describe('isolated text redaction', () => {
  it('redacts an indirect content array and preserves other text after save and reopen', async () => {
    const original = await multiStreamFixture();
    indirectContentArray(original);
    const before = await serializeDocument(original);
    const doc = await parsePDF(before);
    expect(doc.pages[0].contentRefs).toHaveLength(3);
    mark(doc, multiMarked);
    expect((await redactionEngine.applySecureRedactions(doc)).textOperatorsRemoved).toBe(2);
    const output = await saveQuick(doc), reopened = await parsePDF(output);
    const contents = new TextDecoder().decode(getPageContentBytes(reopened.pages[0], reopened.objects));
    expect(contents).toContain('VISIBLE');
    expect(contents).not.toMatch(/SECRET|PRIVATE/);
    expect((await PDFDocument.load(output)).getPageCount()).toBe(1);
    expect(Buffer.from(output).toString('latin1')).not.toMatch(/SECRET|PRIVATE/);
    if (spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status === 0 &&
        spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status === 0) {
      const dir = mkdtempSync(join(tmpdir(), 'paperloom-indirect-redaction-'));
      try {
        const beforePath = join(dir, 'before.pdf'), afterPath = join(dir, 'after.pdf');
        writeFileSync(beforePath, before); writeFileSync(afterPath, output);
        if (spawnSync('qpdf', ['--version'], { stdio: 'ignore' }).status === 0) {
          execFileSync('qpdf', ['--check', beforePath]);
          execFileSync('qpdf', ['--check', afterPath]);
        }
        const originalText = execFileSync('pdftotext', [beforePath, '-'], { encoding: 'utf8' });
        expect(originalText).toContain('SECRET'); expect(originalText).toContain('PRIVATE'); expect(originalText).toContain('VISIBLE');
        const extracted = execFileSync('pdftotext', [afterPath, '-'], { encoding: 'utf8' });
        expect(extracted).toContain('VISIBLE'); expect(extracted).not.toMatch(/SECRET|PRIVATE/);
        for (const dpi of [36, 72, 150, 300]) {
          const render = (pdf: string, label: string) => {
            const prefix = join(dir, `${label}-${dpi}`);
            execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', String(dpi), pdf, prefix]);
            const data = readFileSync(`${prefix}.ppm`);
            const header = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(data.toString('latin1', 0, 64));
            if (!header) throw new Error('Unexpected PPM output');
            return { pixels: data.subarray(header[0].length), width: Number(header[1]), height: Number(header[2]) };
          };
          const first = render(beforePath, 'before'), second = render(afterPath, 'after');
          expect([first.width, first.height]).toEqual([second.width, second.height]);
          let inside = 0, outside = 0;
          for (let y = 0; y < first.height; y++) for (let x = 0; x < first.width; x++) {
            const i = (y * first.width + x) * 3;
            if (first.pixels[i] === second.pixels[i] && first.pixels[i + 1] === second.pixels[i + 1] && first.pixels[i + 2] === second.pixels[i + 2]) continue;
            const left = x * 72 / dpi, right = (x + 1) * 72 / dpi;
            const bottom = 500 - (y + 1) * 72 / dpi, top = 500 - y * 72 / dpi;
            if (right <= 15 || left >= 225 || top <= 75 || bottom >= 125) outside++; else inside++;
          }
          expect(inside).toBeGreaterThan(0); expect(outside).toBe(0);
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it.each(['array alias', 'stream alias'] as const)(
    'rejects a %s before changing a saved and reopened PDF', async kind => {
      const original = await multiStreamFixture(), page = original.pages[0];
      if (kind === 'stream alias') {
        const next = Math.max(...[...original.objects.keys()].map(key => Number(key.split('_')[0]))) + 1;
        const alias = new PDFRef(next, 0);
        original.objects.set(alias.toKey(), page.contentRefs[0]);
        page.dict.getArray('Contents')!.items[0] = alias;
      }
      indirectContentArray(original, kind === 'array alias');
      const before = await serializeDocument(original);
      const doc = await parsePDF(before);
      mark(doc, multiMarked);
      const marked = await serializeDocument(doc);
      expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/indirect reference aliases in page content are unsupported/);
      expect(await serializeDocument(doc)).toEqual(marked);
      expect(doc.requiresFullRewrite).toBeUndefined();
    },
  );

  it.each(['cache order', 'unresolved array', 'cyclic array'] as const)(
    'rejects %s in an indirect content path before mutation', async kind => {
      const doc = await multiStreamFixture(), page = doc.pages[0];
      const pathRef = indirectContentArray(doc);
      if (kind === 'cache order') [page.contentRefs[0], page.contentRefs[1]] = [page.contentRefs[1], page.contentRefs[0]];
      if (kind === 'unresolved array') doc.objects.delete(pathRef.toKey());
      if (kind === 'cyclic array') doc.objects.set(pathRef.toKey(), pathRef);
      mark(doc, multiMarked);
      const before = await serializeDocument(doc);
      expect(() => prepareIsolatedTextRedaction(doc)).toThrow();
      expect(await serializeDocument(doc)).toEqual(before);
      expect(doc.requiresFullRewrite).toBeUndefined();
    },
  );

  it('rejects an annotation sharing an indirect array in the content path without mutation', async () => {
      const doc = await multiStreamFixture();
      const pathRef = indirectContentArray(doc);
      const annotation = redactionEngine.markRegion(doc, 0, multiMarked);
      (doc.objects.get(annotation.toKey()) as PDFDict).set('Shared', pathRef);
      const before = await serializeDocument(doc);
      expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/shared with a page content path/);
      expect(await serializeDocument(doc)).toEqual(before);
      expect(doc.objects.has(pathRef.toKey())).toBe(true);
      expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('rejects an indirect content array reachable from retained page data', async () => {
    const doc = await multiStreamFixture();
    doc.pages[0].contentRefs.pop();
    doc.pages[0].dict.getArray('Contents')!.items.pop();
    const pathRef = indirectContentArray(doc);
    doc.pages[0].dict.set('Tabs', pathRef);
    mark(doc, multiMarked);
    const before = await serializeDocument(doc);
    expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/shared with retained data/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('rejects an indirect content array shared by two pages without mutation', async () => {
    const doc = await multiPageFixture();
    const page = doc.pages[0], next = Math.max(...[...doc.objects.keys()].map(key => Number(key.split('_')[0]))) + 1;
    const arrayRef = new PDFRef(next, 0);
    doc.objects.set(arrayRef.toKey(), new PDFArray([...page.contentRefs]));
    page.dict.set('Contents', arrayRef);
    doc.pages[1].dict.set('Contents', arrayRef);
    doc.pages[1].contentRefs = [...page.contentRefs];
    redactionEngine.markRegion(doc, 0, multiMarked);
    const before = await serializeDocument(doc);
    expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/shared or duplicated/);
    expect(await serializeDocument(doc)).toEqual(before);
  });
  it.each([
    '[(SEC) -20 <524554>] TJ',
    '[(S\\105C)-20<524554>] TJ',
    '[<534543> 10 (RET)] TJ',
    '[(SEC)-20<524554>]TJ',
  ])('removes a complete TJ block and preserves other text: %s', async showing => {
    const doc = await fixture(), page = doc.pages[0];
    const font = [...page.resources.getDict('Font')!.keys()][0];
    const content = `q BT 0 g /${font} 10 Tf 1 0 0 1 40 100 Tm ${showing} ET Q\n` +
      `q BT 0 g /${font} 10 Tf 1 0 0 1 280 300 Tm (VISIBLE) Tj ET Q\n`;
    replaceStream(doc, page.contentRefs[0], content);
    const before = await serializeDocument(doc);
    mark(doc);
    expect((await redactionEngine.applySecureRedactions(doc)).textOperatorsRemoved).toBe(1);
    const bytes = await saveQuick(doc), reopened = await parsePDF(bytes);
    const retained = new TextDecoder().decode(getPageContentBytes(reopened.pages[0], reopened.objects));
    expect(retained).toContain('VISIBLE');
    expect(retained).not.toContain('SECRET');
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    if (spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status === 0 &&
        spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status === 0) {
      const dir = mkdtempSync(join(tmpdir(), 'paperloom-tj-redaction-'));
      try {
        const render = (pdf: Uint8Array, name: string) => {
          const path = join(dir, `${name}.pdf`), prefix = join(dir, name);
          writeFileSync(path, pdf);
          execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', path, prefix]);
          const ppm = readFileSync(`${prefix}.ppm`);
          const header = /^P6\s+500\s+500\s+255\s/.exec(ppm.toString('latin1', 0, 64));
          if (!header) throw new Error('Unexpected PPM output');
          return ppm.subarray(header[0].length);
        };
        const original = render(before, 'before'), after = render(bytes, 'after');
        let inside = 0, outside = 0;
        for (let y = 0; y < 500; y++) for (let x = 0; x < 500; x++) {
          const offset = ((499 - y) * 500 + x) * 3;
          if (original[offset] === after[offset] && original[offset + 1] === after[offset + 1] && original[offset + 2] === after[offset + 2]) continue;
          if (x >= 15 && x <= 185 && y >= 75 && y <= 125) inside++; else outside++;
        }
        expect(inside).toBeGreaterThan(0); expect(outside).toBe(0);
        const extracted = execFileSync('pdftotext', [join(dir, 'after.pdf'), '-'], { encoding: 'utf8' });
        expect(extracted).toContain('VISIBLE'); expect(extracted).not.toContain('SECRET');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it('rejects retained text split across TJ fragments on another page', async () => {
    const doc = await multiPageFixture();
    const page = doc.pages[2], font = [...page.resources.getDict('Font')!.keys()][0];
    replaceStream(doc, page.contentRefs[0], `q BT 0 g /${font} 10 Tf 1 0 0 1 280 300 Tm [(SEC) 0 (RET)] TJ ET Q\n`);
    redactionEngine.markRegion(doc, 0, multiMarked);
    const before = await serializeDocument(doc);
    expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/contains redacted text/);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('rejects an independent copy of a removed TJ fragment', async () => {
    const doc = await multiPageFixture();
    const first = doc.pages[0], retained = doc.pages[2];
    const firstFont = [...first.resources.getDict('Font')!.keys()][0];
    const retainedFont = [...retained.resources.getDict('Font')!.keys()][0];
    replaceStream(doc, first.contentRefs[0], `q BT 0 g /${firstFont} 10 Tf 1 0 0 1 40 100 Tm [(SECRET) 0 (PRIVATE)] TJ ET Q\n`);
    replaceStream(doc, retained.contentRefs[0], `q BT 0 g /${retainedFont} 10 Tf 1 0 0 1 280 300 Tm (PRIVATE) Tj ET Q\n`);
    redactionEngine.markRegion(doc, 0, { x: 15, y: 75, width: 350, height: 50 });
    const before = await serializeDocument(doc);
    expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/contains redacted text/);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('rejects a redacted numeric string retained as a TJ adjustment', async () => {
    const doc = await multiPageFixture();
    const first = doc.pages[0], retained = doc.pages[2];
    const firstFont = [...first.resources.getDict('Font')!.keys()][0];
    const retainedFont = [...retained.resources.getDict('Font')!.keys()][0];
    replaceStream(doc, first.contentRefs[0], `q BT 0 g /${firstFont} 10 Tf 1 0 0 1 40 100 Tm (12345) Tj ET Q\n`);
    replaceStream(doc, retained.contentRefs[0], `q BT 0 g /${retainedFont} 10 Tf 1 0 0 1 280 300 Tm [(VISIBLE) 12345] TJ ET Q\n`);
    redactionEngine.markRegion(doc, 0, multiMarked);
    const before = await serializeDocument(doc);
    expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/contains redacted text/);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('rejects a partially covered block displaced by TJ spacing', async () => {
    const doc = await fixture(), page = doc.pages[0];
    const font = [...page.resources.getDict('Font')!.keys()][0];
    replaceStream(doc, page.contentRefs[0], `q BT 0 g /${font} 10 Tf 1 0 0 1 40 100 Tm [(SECRET) 3000 (PRIVATE)] TJ ET Q\n`);
    mark(doc);
    const before = await serializeDocument(doc);
    expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/partially intersects/);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it.each([
    '[(SECRET) 1-2 (PRIVATE)] TJ',
    '[(SECRET) /Unknown (PRIVATE)] TJ',
    '[(SECRET) % hidden\n (PRIVATE)] TJ',
    '[(SECRET) <5>] TJ',
    '[(SECRET) [(PRIVATE)]] TJ',
    '[(SECRET) (PRIVATE)] Tj',
  ])('rejects unsupported or malformed TJ syntax without mutation: %s', async showing => {
    const doc = await fixture(), page = doc.pages[0];
    const font = [...page.resources.getDict('Font')!.keys()][0];
    replaceStream(doc, page.contentRefs[0], `q BT 0 g /${font} 10 Tf 1 0 0 1 40 100 Tm ${showing} ET Q\n`);
    mark(doc);
    const before = await serializeDocument(doc);
    expect(() => prepareIsolatedTextRedaction(doc)).toThrow();
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('redacts independently framed streams on the same page and preserves untouched compressed streams', async () => {
    const doc = await multiStreamFixture(), page = doc.pages[0];
    const retained = doc.objects.get(page.contentRefs[2].toKey()) as PDFStream;
    const raw = new Uint8Array(deflateSync(retained.rawBytes));
    retained.rawBytes = raw; retained.decodedBytes = null;
    retained.dict.set('Length', new PDFNumber(raw.length)); retained.dict.set('Filter', new PDFName('FlateDecode'));
    const before = await serializeDocument(doc);
    mark(doc, multiMarked);
    const result = await redactionEngine.applySecureRedactions(doc);
    expect(result).toMatchObject({ pagesProcessed: 1, textOperatorsRemoved: 2, annotationsRemoved: 1 });
    const output = await saveQuick(doc), reopened = await parsePDF(output);
    const stream = reopened.objects.get(reopened.pages[0].contentRefs[2].toKey()) as PDFStream;
    expect(stream.rawBytes).toEqual(raw);
    const text = new TextDecoder().decode(getPageContentBytes(reopened.pages[0], reopened.objects));
    expect(text).not.toMatch(/SECRET|PRIVATE/);
    expect(text).toContain('VISIBLE');
    expect((await PDFDocument.load(output)).getPageCount()).toBe(1);
    if (spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status === 0 &&
        spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status === 0) {
      const dir = mkdtempSync(join(tmpdir(), 'paperloom-stream-redaction-'));
      try {
        const render = (bytes: Uint8Array, name: string) => {
          const pdf = join(dir, `${name}.pdf`), prefix = join(dir, name);
          writeFileSync(pdf, bytes);
          execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', pdf, prefix]);
          const data = readFileSync(`${prefix}.ppm`);
          const header = /^P6\s+500\s+500\s+255\s/.exec(data.toString('latin1', 0, 64));
          if (!header) throw new Error('Unexpected PPM output');
          return data.subarray(header[0].length);
        };
        const original = render(before, 'before'), after = render(output, 'after');
        let inside = 0, outside = 0;
        for (let y = 0; y < 500; y++) for (let x = 0; x < 500; x++) {
          const offset = ((499 - y) * 500 + x) * 3;
          if (original[offset] === after[offset] && original[offset + 1] === after[offset + 1] && original[offset + 2] === after[offset + 2]) continue;
          if (x >= 15 && x <= 225 && y >= 75 && y <= 125) inside++; else outside++;
        }
        expect(inside).toBeGreaterThan(0); expect(outside).toBe(0);
        const extracted = execFileSync('pdftotext', [join(dir, 'after.pdf'), '-'], { encoding: 'utf8' });
        expect(extracted).toContain('VISIBLE'); expect(extracted).not.toMatch(/SECRET|PRIVATE/);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it('redacts a verified compressed stream while preserving an unmarked stream', async () => {
    const doc = await multiStreamFixture(), page = doc.pages[0];
    const secret = doc.objects.get(page.contentRefs[0].toKey()) as PDFStream;
    const raw = new Uint8Array(deflateSync(secret.rawBytes));
    secret.rawBytes = raw; secret.decodedBytes = null;
    secret.dict.set('Length', new PDFNumber(raw.length)); secret.dict.set('Filter', new PDFName('Fl'));
    mark(doc, multiMarked);
    expect((await redactionEngine.applySecureRedactions(doc)).textOperatorsRemoved).toBe(2);
    const reopened = await parsePDF(await saveQuick(doc));
    expect(new TextDecoder().decode(getPageContentBytes(reopened.pages[0], reopened.objects))).toContain('VISIBLE');
    expect((reopened.objects.get(reopened.pages[0].contentRefs[0].toKey()) as PDFStream).dict.has('Filter')).toBe(false);
  });

  it('rejects a duplicate split across retained content streams without mutation', async () => {
    const doc = await multiStreamFixture(), page = doc.pages[0];
    const font = [...page.resources.getDict('Font')!.keys()][0];
    replaceStream(doc, page.contentRefs[1], `q BT 0 g /${font} 10 Tf 1 0 0 1 280 300 Tm (SEC) Tj ET Q\n`);
    replaceStream(doc, page.contentRefs[2], `q BT 0 g /${font} 10 Tf 1 0 0 1 350 300 Tm (RET) Tj ET Q\n`);
    mark(doc, multiMarked);
    const before = await serializeDocument(doc);
    expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/contains redacted text/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it.each(['duplicate', 'cached order', 'missing cached stream', 'direct stream', 'unsupported filter', 'split state', 'missing separator'] as const)(
    'rejects %s in a content array before mutation', async kind => {
      const doc = await multiStreamFixture(), page = doc.pages[0], refs = page.contentRefs;
      const contents = page.dict.getArray('Contents')!;
      if (kind === 'duplicate') { contents.push(refs[0]); refs.push(refs[0]); }
      if (kind === 'cached order') [refs[0], refs[1]] = [refs[1], refs[0]];
      if (kind === 'missing cached stream') refs.pop();
      if (kind === 'direct stream') contents.items[0] = doc.objects.get(refs[0].toKey())!;
      if (kind === 'unsupported filter') (doc.objects.get(refs[0].toKey()) as PDFStream).dict.set('Filter', new PDFName('Unknown'));
      if (kind === 'split state') replaceStream(doc, refs[0], 'q BT\n');
      if (kind === 'missing separator') {
        const stream = doc.objects.get(refs[0].toKey()) as PDFStream;
        replaceStream(doc, refs[0], new TextDecoder().decode(stream.rawBytes).trimEnd());
      }
      mark(doc, multiMarked);
      const before = await serializeDocument(doc);
      expect(() => prepareIsolatedTextRedaction(doc)).toThrow();
      expect(await serializeDocument(doc)).toEqual(before);
      expect(doc.requiresFullRewrite).toBeUndefined();
    },
  );

  it('rejects a marked annotation referencing unmodified page content', async () => {
    const doc = await multiStreamFixture(), page = doc.pages[0];
    const markRef = redactionEngine.markRegion(doc, 0, multiMarked);
    (doc.objects.get(markRef.toKey()) as PDFDict).set('Shared', page.contentRefs[2]);
    const before = await serializeDocument(doc);
    expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/shared with retained content/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('rejects a content stream shared across different pages without mutation', async () => {
    const doc = await multiPageFixture(), page = doc.pages[2];
    const refs = [...page.contentRefs, doc.pages[0].contentRefs[0]];
    page.dict.set('Contents', new PDFArray(refs));
    page.contentRefs.splice(0, page.contentRefs.length, ...refs);
    redactionEngine.markRegion(doc, 0, multiMarked);
    const before = await serializeDocument(doc);
    expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/shared or duplicated/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('refuses a changed retained stream when committing a prepared multi-stream redaction', async () => {
    const doc = await multiStreamFixture(), page = doc.pages[0];
    mark(doc, multiMarked);
    const prepared = prepareIsolatedTextRedaction(doc);
    const retained = doc.objects.get(page.contentRefs[2].toKey()) as PDFStream;
    replaceStream(doc, page.contentRefs[2], new TextDecoder().decode(retained.rawBytes) + ' ');
    const before = await serializeDocument(doc);
    expect(() => prepared.commit()).toThrow(/changed after/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it.each([{ outputLength: 1234, rejected: true }, { outputLength: 1233, rejected: false }])(
    'checks redacted text against replacement stream length $outputLength', async ({ outputLength, rejected }) => {
      const doc = await multiStreamFixture(), page = doc.pages[0];
      const font = [...page.resources.getDict('Font')!.keys()][0];
      const secret = `q BT 0 g /${font} 10 Tf 1 0 0 1 40 100 Tm (1234) Tj ET Q\n`;
      const visible = `q BT 0 g /${font} 10 Tf 1 0 0 1 280 300 Tm (SAFE) Tj ET Q`;
      replaceStream(doc, page.contentRefs[0], secret + visible.padStart(outputLength - 2) + '\n');
      mark(doc, multiMarked);
      const before = await serializeDocument(doc);
      if (rejected) {
        expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/contains redacted text/);
        expect(await serializeDocument(doc)).toEqual(before);
      } else {
        expect(prepareIsolatedTextRedaction(doc).commit().textOperatorsRemoved).toBe(2);
        expect((doc.objects.get(page.contentRefs[0].toKey()) as PDFStream).rawBytes).toHaveLength(outputLength);
      }
    },
  );

  it('redacts across a three-level page tree and preserves an unmarked page after reopen', async () => {
    const doc = await nestedPageFixture();
    const retained = getPageContentBytes(doc.pages[2], doc.objects).slice();
    redactionEngine.markRegion(doc, 0, multiMarked);
    redactionEngine.markRegion(doc, 1, multiMarked);
    const result = await redactionEngine.applySecureRedactions(doc);
    expect(result).toMatchObject({ pagesProcessed: 2, textOperatorsRemoved: 2, annotationsRemoved: 2 });
    const bytes = await saveQuick(doc);
    const reopened = await parsePDF(bytes);
    expect(reopened.pages).toHaveLength(3);
    expect(getPageContentBytes(reopened.pages[2], reopened.objects)).toEqual(retained);
    expect(new TextDecoder().decode(getPageContentBytes(reopened.pages[0], reopened.objects))).not.toContain(pdfText('SECRET'));
    expect(new TextDecoder().decode(getPageContentBytes(reopened.pages[1], reopened.objects))).not.toContain(pdfText('PRIVATE'));
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(3);
    if (spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status === 0) {
      const dir = mkdtempSync(join(tmpdir(), 'paperloom-nested-text-'));
      try {
        const path = join(dir, 'output.pdf');
        writeFileSync(path, bytes);
        const extracted = execFileSync('pdftotext', [path, '-'], { encoding: 'utf8' });
        expect(extracted).not.toMatch(/SECRET|PRIVATE/);
        expect(extracted).toContain('SURVIVOR');
        expect(extracted).toContain('Visible0');
        expect(extracted).toContain('Visible1');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it.each(['bad nested count', 'bad root count', 'bad parent', 'duplicate branch', 'cycle', 'missing cached page', 'unsupported node feature'] as const)(
    'rejects %s in a nested page tree before mutation', async kind => {
      const doc = await nestedPageFixture();
      const rootRef = doc.catalog.getRef('Pages')!, root = doc.objects.get(rootRef.toKey()) as PDFDict;
      const kids = root.getArray('Kids')!, right = doc.objects.get((kids.get(1) as PDFRef).toKey()) as PDFDict;
      const nestedRef = right.getArray('Kids')!.get(0) as PDFRef;
      const nested = doc.objects.get(nestedRef.toKey()) as PDFDict;
      if (kind === 'bad nested count') nested.set('Count', new PDFNumber(2));
      else if (kind === 'bad root count') root.set('Count', new PDFNumber(4));
      else if (kind === 'bad parent') doc.pages[1].dict.set('Parent', rootRef);
      else if (kind === 'duplicate branch') kids.push(kids.get(0)!);
      else if (kind === 'cycle') nested.getArray('Kids')!.push(rootRef);
      else if (kind === 'missing cached page') doc.pages.pop();
      else nested.set('Metadata', new PDFString('unsupported'));
      redactionEngine.markRegion(doc, 0, multiMarked);
      const before = await serializeDocument(doc);
      expect(() => prepareIsolatedTextRedaction(doc)).toThrow();
      expect(await serializeDocument(doc)).toEqual(before);
      expect(doc.requiresFullRewrite).toBeUndefined();
    },
  );

  it('rejects an unmarked nested page retaining a copy of the redacted text', async () => {
    const doc = await nestedPageFixture(), page = doc.pages[2];
    const name = [...page.resources.getDict('Font')!.keys()][0];
    await updatePageContent(page.contentRefs, new TextEncoder().encode(
      `q BT 0 g /${name} 10 Tf 1 0 0 1 40 100 Tm (SECRET) Tj ET Q`), doc.objects, false);
    redactionEngine.markRegion(doc, 0, multiMarked);
    const before = await serializeDocument(doc);
    expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/contains redacted text/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('rejects a nested tree changed after preparing redaction', async () => {
    const doc = await nestedPageFixture();
    redactionEngine.markRegion(doc, 0, multiMarked);
    const prepared = prepareIsolatedTextRedaction(doc);
    const root = doc.objects.get(doc.catalog.getRef('Pages')!.toKey()) as PDFDict;
    root.set('Count', new PDFNumber(4));
    const before = await serializeDocument(doc);
    expect(() => prepared.commit()).toThrow(/changed after/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it.each(['marked', 'unmarked'] as const)(
    'rejects %s page content reachable from a retained annotation', async which => {
      const doc = await multiPageFixture();
      const ref = doc.pages[which === 'marked' ? 0 : 2].contentRefs[0];
      doc.pages[2].dict.set('Annots', new PDFArray([new PDFDict([
        ['Type', new PDFName('Annot')], ['Subtype', new PDFName('Text')],
        ['Rect', new PDFArray([1, 1, 20, 20].map(n => new PDFNumber(n)))],
        ['AlternateContent', ref],
      ])]));
      redactionEngine.markRegion(doc, 0, multiMarked);
      const before = await serializeDocument(doc);
      expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/shared|retained streams/);
      expect(await serializeDocument(doc)).toEqual(before);
    },
  );

  it.each([
    { secret: '314159265', numeric: 314159265 },
    { secret: '0.12346', numeric: 0.123456 },
    { secret: '0.0000001', numeric: 1e-7 },
    { secret: '-0.0000001', numeric: -1e-7 },
    { secret: '1000000000000000000000', numeric: 1e21 },
  ])('rejects a retained independent numeric copy of $secret before mutation', async ({ secret, numeric }) => {
    const doc = await multiPageFixture();
    const page = doc.pages[0];
    const name = [...page.resources.getDict('Font')!.keys()][0];
    const content = `q BT 0 g /${name} 10 Tf 1 0 0 1 40 100 Tm (${secret}) Tj ET Q`;
    await updatePageContent(page.contentRefs, new TextEncoder().encode(content), doc.objects, false);
    // A separate annotation may carry a numeric copy without displaying it.
    doc.pages[2].dict.set('Annots', new PDFArray([new PDFDict([
      ['Type', new PDFName('Annot')], ['Subtype', new PDFName('Text')],
      ['Rect', new PDFArray([1, 1, 20, 20].map(n => new PDFNumber(n)))],
      ['PrivateNumericValue', new PDFNumber(numeric)],
    ])]));
    redactionEngine.markRegion(doc, 0, { x: 15, y: 75, width: 490, height: 50 });
    const before = await serializeDocument(doc);
    expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/retained data contains redacted text/);
    await expect(redactionEngine.applySecureRedactions(doc)).rejects.toThrow();
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it.each(['SECRET', '975318642'])('allows unrelated retained numbers for %s', async secret => {
    const doc = await multiPageFixture();
    const page = doc.pages[0];
    const name = [...page.resources.getDict('Font')!.keys()][0];
    const content = `q BT 0 g /${name} 10 Tf 1 0 0 1 40 100 Tm (${secret}) Tj ET Q`;
    await updatePageContent(page.contentRefs, new TextEncoder().encode(content), doc.objects, false);
    doc.pages[2].dict.set('Annots', new PDFArray([new PDFDict([
      ['Type', new PDFName('Annot')], ['Subtype', new PDFName('Text')],
      ['Rect', new PDFArray([1, 1, 20, 20].map(n => new PDFNumber(n)))],
      ['PublicNumericValue', new PDFNumber(314159265)],
    ])]));
    redactionEngine.markRegion(doc, 0, { x: 15, y: 75, width: 250, height: 50 });
    await redactionEngine.applySecureRedactions(doc);
    const reopened = await parsePDF(await saveQuick(doc));
    const annotation = reopened.pages[2].dict.getArray('Annots')!.get(0) as PDFDict;
    expect(annotation.getNumber('PublicNumericValue')).toBe(314159265);
    expect(new TextDecoder().decode(getPageContentBytes(reopened.pages[0], reopened.objects))).not.toContain(secret);
  });

  it('conservatively rejects numeric text that coincides with retained page geometry', async () => {
    const doc = await multiPageFixture();
    const page = doc.pages[0];
    const name = [...page.resources.getDict('Font')!.keys()][0];
    await updatePageContent(page.contentRefs, new TextEncoder().encode(
      `q BT 0 g /${name} 10 Tf 1 0 0 1 40 100 Tm (500) Tj ET Q`), doc.objects, false);
    redactionEngine.markRegion(doc, 0, multiMarked);
    const before = await serializeDocument(doc);
    expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/retained data contains redacted text/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it.each(['314159265', '000314159265'])('rejects a retained content-stream numeric operand %s', async operand => {
    const doc = await multiPageFixture();
    const markedPage = doc.pages[0], retainedPage = doc.pages[2];
    const markedFont = [...markedPage.resources.getDict('Font')!.keys()][0];
    const retainedFont = [...retainedPage.resources.getDict('Font')!.keys()][0];
    await updatePageContent(markedPage.contentRefs, new TextEncoder().encode(
      `q BT 0 g /${markedFont} 10 Tf 1 0 0 1 40 100 Tm (314159265) Tj ET Q`), doc.objects, false);
    await updatePageContent(retainedPage.contentRefs, new TextEncoder().encode(
      `q BT 0 g /${retainedFont} 10 Tf ${operand} TL 1 0 0 1 280 300 Tm (SURVIVOR) Tj ET Q`), doc.objects, false);
    redactionEngine.markRegion(doc, 0, { x: 15, y: 75, width: 250, height: 50 });
    const before = await serializeDocument(doc);
    expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/retained data contains redacted text/);
    await expect(redactionEngine.applySecureRedactions(doc)).rejects.toThrow();
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('rejects a retained stream dictionary length matching redacted text', async () => {
    const doc = await multiPageFixture();
    const markedPage = doc.pages[0], retainedPage = doc.pages[2];
    const markedFont = [...markedPage.resources.getDict('Font')!.keys()][0];
    const retainedFont = [...retainedPage.resources.getDict('Font')!.keys()][0];
    await updatePageContent(markedPage.contentRefs, new TextEncoder().encode(
      `q BT 0 g /${markedFont} 10 Tf 1 0 0 1 40 100 Tm (1234) Tj ET Q`), doc.objects, false);
    const retained = `q BT 0 g /${retainedFont} 10 Tf 1 0 0 1 280 300 Tm (SURVIVOR) Tj ET Q`;
    await updatePageContent(retainedPage.contentRefs, new TextEncoder().encode(retained.padEnd(1234)), doc.objects, false);
    redactionEngine.markRegion(doc, 0, multiMarked);
    const before = await serializeDocument(doc);
    expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/retained data contains redacted text/);
    await expect(redactionEngine.applySecureRedactions(doc)).rejects.toThrow();
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('redacts marked pages atomically while preserving an unmarked page after reopen', async () => {
    const doc = await multiPageFixture();
    const retained = getPageContentBytes(doc.pages[2], doc.objects).slice();
    redactionEngine.markRegion(doc, 0, multiMarked);
    redactionEngine.markRegion(doc, 1, multiMarked);
    const result = await redactionEngine.applySecureRedactions(doc);
    expect(result).toMatchObject({ pagesProcessed: 2, textOperatorsRemoved: 2, annotationsRemoved: 2 });
    const bytes = await saveQuick(doc);
    const reopened = await parsePDF(bytes);
    expect(reopened.pages).toHaveLength(3);
    expect(getPageContentBytes(reopened.pages[2], reopened.objects)).toEqual(retained);
    expect(new TextDecoder().decode(getPageContentBytes(reopened.pages[0], reopened.objects))).not.toContain(pdfText('SECRET'));
    expect(new TextDecoder().decode(getPageContentBytes(reopened.pages[1], reopened.objects))).not.toContain(pdfText('PRIVATE'));
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(3);
    if (spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status === 0) {
      const dir = mkdtempSync(join(tmpdir(), 'paperloom-multipage-text-'));
      try {
        const path = join(dir, 'output.pdf');
        writeFileSync(path, bytes);
        const extracted = execFileSync('pdftotext', [path, '-'], { encoding: 'utf8' });
        expect(extracted).not.toMatch(/SECRET|PRIVATE/);
        expect(extracted).toContain('SURVIVOR');
        expect(extracted).toContain('Visible0');
        expect(extracted).toContain('Visible1');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it('rejects a duplicate on an unmarked page before changing either page', async () => {
    const doc = await multiPageFixture('SECRET');
    redactionEngine.markRegion(doc, 0, marked);
    const before = await serializeDocument(doc);
    expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/contains redacted text/);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('rejects a duplicate split across adjacent text blocks on an unmarked page', async () => {
    const doc = await multiPageFixture();
    const page = doc.pages[2], fonts = page.resources.getDict('Font')!;
    const name = [...fonts.keys()][0];
    const content = `q BT 0 g /${name} 10 Tf 1 0 0 1 40 100 Tm (SEC) Tj ET Q\n` +
      `q BT 0 g /${name} 10 Tf 1 0 0 1 100 100 Tm (RET) Tj ET Q`;
    await updatePageContent(page.contentRefs, new TextEncoder().encode(content), doc.objects, false);
    redactionEngine.markRegion(doc, 0, marked);
    const before = await serializeDocument(doc);
    expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/contains redacted text/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('preserves a verified compressed stream on an unmarked page', async () => {
    const doc = await multiPageFixture();
    const stream = doc.objects.get(doc.pages[2].contentRefs[0].toKey()) as PDFStream;
    const raw = new Uint8Array(deflateSync(stream.rawBytes));
    stream.rawBytes = raw; stream.decodedBytes = null;
    stream.dict.set('Length', new PDFNumber(raw.length));
    stream.dict.set('Filter', new PDFName('FlateDecode'));
    redactionEngine.markRegion(doc, 0, marked);
    expect((await redactionEngine.applySecureRedactions(doc)).pagesProcessed).toBe(1);
    const reopened = await parsePDF(await saveQuick(doc));
    const retained = reopened.objects.get(reopened.pages[2].contentRefs[0].toKey()) as PDFStream;
    expect(retained.rawBytes).toEqual(raw);
    expect(new TextDecoder().decode(getPageContentBytes(reopened.pages[2], reopened.objects))).toContain(pdfText('SURVIVOR'));
  });

  it('rejects documents over the page budget without modifying the source', async () => {
    const doc = await multiPageFixture('SURVIVOR', 65);
    redactionEngine.markRegion(doc, 0, marked);
    const before = await serializeDocument(doc);
    expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/at most 64 pages/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('bounds aggregate decoded work across individually valid pages', async () => {
    const doc = await multiPageFixture('SURVIVOR', 17);
    for (const page of doc.pages) {
      const content = new TextDecoder().decode(getPageContentBytes(page, doc.objects)).padEnd(65_000, ' ');
      await updatePageContent(page.contentRefs, new TextEncoder().encode(content), doc.objects, false);
    }
    redactionEngine.markRegion(doc, 0, marked);
    const before = await serializeDocument(doc);
    expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/inspection limit/);
    expect(await serializeDocument(doc)).toEqual(before);
  }, 30_000);

  it('rechecks changes to an unmarked page before committing any redaction', async () => {
    const doc = await multiPageFixture();
    redactionEngine.markRegion(doc, 0, marked);
    const prepared = prepareIsolatedTextRedaction(doc);
    const page = doc.pages[2], fonts = page.resources.getDict('Font')!;
    const name = [...fonts.keys()][0];
    await updatePageContent(page.contentRefs, new TextEncoder().encode(
      `q BT 0 g /${name} 10 Tf 1 0 0 1 40 100 Tm (SECRET) Tj ET Q`,
    ), doc.objects, false);
    const before = await serializeDocument(doc);
    expect(() => prepared.commit()).toThrow(/changed after/);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it.skipIf(spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status !== 0).each(['flat', 'nested'] as const)(
    'preserves every pixel outside marked areas across all pages in a %s tree', async kind => {
      const doc = kind === 'flat' ? await multiPageFixture() : await nestedPageFixture();
      const original = await serializeDocument(doc);
      redactionEngine.markRegion(doc, 0, multiMarked);
      redactionEngine.markRegion(doc, 1, multiMarked);
      await redactionEngine.applySecureRedactions(doc);
      const output = await saveQuick(doc);
      const dir = mkdtempSync(join(tmpdir(), 'paperloom-multipage-pixels-'));
      try {
        const render = (bytes: Uint8Array, label: string, page: number) => {
          const pdf = join(dir, `${label}.pdf`), prefix = join(dir, `${label}-${page}`);
          writeFileSync(pdf, bytes);
          execFileSync('pdftoppm', ['-f', String(page), '-l', String(page), '-singlefile', '-r', '72', pdf, prefix]);
          const data = readFileSync(`${prefix}.ppm`);
          const header = /^P6\s+500\s+500\s+255\s/.exec(data.toString('latin1', 0, 64));
          if (!header) throw new Error('Unexpected PPM output');
          return data.subarray(header[0].length);
        };
        for (let page = 1; page <= 3; page++) {
          const before = render(original, 'before', page), after = render(output, 'after', page);
          let changedInside = 0, changedOutside = 0;
          for (let y = 0; y < 500; y++) for (let x = 0; x < 500; x++) {
            const offset = ((499 - y) * 500 + x) * 3;
            if (before[offset] === after[offset] && before[offset + 1] === after[offset + 1] && before[offset + 2] === after[offset + 2]) continue;
            if (page < 3 && x >= 15 && x <= 225 && y >= 75 && y <= 125) changedInside++;
            else changedOutside++;
          }
          if (page < 3) expect(changedInside).toBeGreaterThan(0);
          expect(changedOutside).toBe(0);
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 30_000,
  );

  it.each(['shared stream', 'unsupported unmarked page', 'malformed annotation', 'partially marked page'] as const)(
    'rejects %s before changing any page', async kind => {
      const doc = await multiPageFixture();
      redactionEngine.markRegion(doc, 0, marked);
      if (kind === 'shared stream') {
        doc.pages[2].dict.set('Contents', doc.pages[0].contentRefs[0]);
        doc.pages[2].contentRefs = [doc.pages[0].contentRefs[0]];
      } else if (kind === 'unsupported unmarked page') {
        await updatePageContent(doc.pages[2].contentRefs, new TextEncoder().encode('0 0 20 20 re f'), doc.objects, false);
      } else if (kind === 'malformed annotation') {
        doc.pages[2].dict.set('Annots', new PDFArray([new PDFDict()]));
      } else redactionEngine.markRegion(doc, 1, { x: 30, y: 80, width: 50, height: 40 });
      const before = await serializeDocument(doc);
      expect(() => prepareIsolatedTextRedaction(doc)).toThrow();
      expect(await serializeDocument(doc)).toEqual(before);
      expect(doc.requiresFullRewrite).toBeUndefined();
    },
  );
  it('removes covered text and preserves unrelated text after a full rewrite', async () => {
    const doc = await fixture();
    mark(doc);
    const result = await redactionEngine.applySecureRedactions(doc);
    expect(result).toMatchObject({ pagesProcessed: 1, textOperatorsRemoved: 1, annotationsRemoved: 1 });
    expect(doc.requiresFullRewrite).toBe(true);
    const bytes = await saveQuick(doc);
    const reopened = await parsePDF(bytes);
    const content = new TextDecoder().decode(getPageContentBytes(reopened.pages[0], reopened.objects));
    expect(content).not.toContain(pdfText('SECRET'));
    expect(content).toContain(pdfText('VISIBLE'));
    expect(reopened.pages[0].dict.has('Annots')).toBe(false);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });

  it.skipIf(spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status !== 0)('removes readable text independently checked by Poppler', async () => {
    const doc = await fixture();
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-text-redaction-'));
    try {
      const before = join(dir, 'before.pdf'), after = join(dir, 'after.pdf');
      writeFileSync(before, await serializeDocument(doc));
      expect(execFileSync('pdftotext', [before, '-'], { encoding: 'utf8' })).toContain('SECRET');
      mark(doc);
      await redactionEngine.applySecureRedactions(doc);
      writeFileSync(after, await saveQuick(doc));
      const text = execFileSync('pdftotext', [after, '-'], { encoding: 'utf8' });
      expect(text).not.toContain('SECRET');
      expect(text).toContain('VISIBLE');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.skipIf(spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status !== 0)('preserves every pixel outside the marked area in Poppler', async () => {
    const doc = await fixture();
    const original = await serializeDocument(doc);
    mark(doc);
    await redactionEngine.applySecureRedactions(doc);
    const output = await saveQuick(doc);
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-text-pixels-'));
    try {
      const render = (bytes: Uint8Array, label: string) => {
        const pdf = join(dir, `${label}.pdf`), prefix = join(dir, label);
        writeFileSync(pdf, bytes);
        execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', pdf, prefix]);
        const data = readFileSync(`${prefix}.ppm`);
        const header = /^P6\s+500\s+500\s+255\s/.exec(data.toString('latin1', 0, 64));
        if (!header) throw new Error('Unexpected PPM output');
        return data.subarray(header[0].length);
      };
      const before = render(original, 'before'), after = render(output, 'after');
      let changedInside = 0, changedOutside = 0;
      for (let y = 0; y < 500; y++) for (let x = 0; x < 500; x++) {
        const offset = ((499 - y) * 500 + x) * 3;
        if (before[offset] === after[offset] && before[offset + 1] === after[offset + 1] && before[offset + 2] === after[offset + 2]) continue;
        if (x >= 15 && x <= 185 && y >= 75 && y <= 125) changedInside++;
        else changedOutside++;
      }
      expect(changedInside).toBeGreaterThan(0);
      expect(changedOutside).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.skipIf(spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status !== 0).each(latinBaseFonts)(
    'keeps outside pixels unchanged for every supported %s ASCII character', async fontName => {
      const pdf = await PDFDocument.create();
      const page = pdf.addPage([2500, 500]);
      const font = await pdf.embedFont(fontName);
      page.drawText('fixture', { font });
      const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
      doc.xref.trailerDict.delete('Info');
      const fonts = doc.pages[0].resources.getDict('Font')!;
      const name = [...fonts.keys()][0];
      const resources = new PDFDict([['Font', fonts]]);
      doc.pages[0].dict.set('Resources', resources);
      doc.pages[0].resources = resources;
      doc.pages[0].dict.set('Contents', doc.pages[0].contentRefs[0]);
      // The supported ASCII domain excludes apostrophe and grave accent,
      // whose glyphs differ between StandardEncoding and WinAnsiEncoding.
      const supported = Array.from({ length: 95 }, (_, i) => i + 32).filter(byte => byte !== 39 && byte !== 96);
      const encoded = Buffer.from(supported).toString('hex');
      const content = `q BT 0 g /${name} 10 Tf 1 0 0 1 40 100 Tm <${encoded}> Tj ET Q\n` +
        `q BT 0 g /${name} 10 Tf 1 0 0 1 2200 300 Tm (Visible) Tj ET Q`;
      await updatePageContent(doc.pages[0].contentRefs, new TextEncoder().encode(content), doc.objects, false);
      const before = await serializeDocument(doc);
      redactionEngine.markRegion(doc, 0, { x: 0, y: 70, width: 2000, height: 60 });
      expect((await redactionEngine.applySecureRedactions(doc)).textOperatorsRemoved).toBe(1);
      const after = await saveQuick(doc);
      const dir = mkdtempSync(join(tmpdir(), 'paperloom-base-font-pixels-'));
      try {
        const render = (bytes: Uint8Array, label: string) => {
          const input = join(dir, `${label}.pdf`), prefix = join(dir, label);
          writeFileSync(input, bytes);
          execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', input, prefix]);
          const data = readFileSync(`${prefix}.ppm`);
          const header = /^P6\s+2500\s+500\s+255\s/.exec(data.toString('latin1', 0, 64));
          if (!header) throw new Error('Unexpected PPM output');
          return data.subarray(header[0].length);
        };
        const original = render(before, 'before'), redacted = render(after, 'after');
        if (spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status === 0) {
          const extract = (label: string) => execFileSync('pdftotext', [join(dir, `${label}.pdf`), '-'], { encoding: 'utf8' });
          expect(extract('before')).toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
          const text = extract('after');
          expect(text).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
          expect(text).toContain('Visible');
        }
        let inside = 0, outside = 0;
        for (let y = 0; y < 500; y++) for (let x = 0; x < 2500; x++) {
          const offset = ((499 - y) * 2500 + x) * 3;
          if (original[offset] === redacted[offset] && original[offset + 1] === redacted[offset + 1] && original[offset + 2] === redacted[offset + 2]) continue;
          if (x < 2000 && y >= 70 && y <= 130) inside++;
          else outside++;
        }
        expect(inside).toBeGreaterThan(0);
        expect(outside).toBe(0);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
  );

  it('supports a strictly verified Flate-compressed text stream', async () => {
    const doc = await fixture();
    const stream = doc.objects.get(doc.pages[0].contentRefs[0].toKey()) as PDFStream;
    stream.rawBytes = new Uint8Array(deflateSync(stream.rawBytes));
    stream.decodedBytes = null;
    stream.dict.set('Length', new PDFNumber(stream.rawBytes.length));
    stream.dict.set('Filter', new PDFName('FlateDecode'));
    mark(doc);
    const result = await redactionEngine.applySecureRedactions(doc);
    expect(result.textOperatorsRemoved).toBe(1);
    const reopened = await parsePDF(await saveQuick(doc));
    expect(new TextDecoder().decode(getPageContentBytes(reopened.pages[0], reopened.objects))).toContain(pdfText('VISIBLE'));
  });

  it('rejects partially intersecting text and preserves all bytes', async () => {
    const doc = await fixture();
    mark(doc, { x: 30, y: 80, width: 50, height: 40 });
    const before = await serializeDocument(doc);
    expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/partially intersects/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('accepts adjacent marks that jointly cover text, but rejects a small gap', async () => {
    for (const gap of [0, 0.001]) {
      const doc = await fixture();
      mark(doc, { x: 15, y: 75, width: 85 - gap, height: 50 });
      mark(doc, { x: 100, y: 75, width: 85, height: 50 });
      const before = await serializeDocument(doc);
      if (gap) {
        expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/partially intersects/);
        expect(await serializeDocument(doc)).toEqual(before);
      } else {
        expect((await redactionEngine.applySecureRedactions(doc)).textOperatorsRemoved).toBe(1);
        const reopened = await parsePDF(await saveQuick(doc));
        expect(new TextDecoder().decode(getPageContentBytes(reopened.pages[0], reopened.objects))).not.toContain(pdfText('SECRET'));
      }
    }
  });

  it('rejects an independent duplicate in the surviving text', async () => {
    const doc = await fixture(true);
    mark(doc);
    const before = await serializeDocument(doc);
    expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/contains redacted text/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it.each(['metadata', 'shared content', 'modified font', 'symbol font', 'unsupported operation', 'signed'] as const)(
    'rejects %s without changing the document', async scenario => {
      const doc = await fixture();
      if (scenario === 'metadata') doc.xref.trailerDict.set('Info', new PDFDict([['Title', new PDFString('PRIVATE')]]));
      if (scenario === 'shared content') doc.catalog.set('Other', doc.pages[0].contentRefs[0]);
      if (scenario === 'modified font') {
        const fonts = doc.pages[0].resources.getDict('Font')!;
        const font = doc.objects.get((fonts.values().next().value as PDFRef).toKey()) as PDFDict;
        font.set('Widths', new PDFArray([new PDFNumber(99999)]));
      }
      if (scenario === 'symbol font') {
        const fonts = doc.pages[0].resources.getDict('Font')!;
        const font = doc.objects.get((fonts.values().next().value as PDFRef).toKey()) as PDFDict;
        font.set('BaseFont', new PDFName('Symbol'));
      }
      if (scenario === 'unsupported operation') {
        const stream = doc.objects.get(doc.pages[0].contentRefs[0].toKey()) as PDFStream;
        const next = new TextEncoder().encode(new TextDecoder().decode(stream.rawBytes).replace(' Tj', ' Tj 1 Tc'));
        stream.rawBytes = next; stream.decodedBytes = next; stream.dict.set('Length', new PDFNumber(next.length));
      }
      if (scenario === 'signed') doc.rawBytes = new TextEncoder().encode('%PDF-1.7\n/ByteRange [0 10 20 10] /Contents <01020304>');
      mark(doc);
      const before = await serializeDocument(doc);
      expect(() => prepareIsolatedTextRedaction(doc)).toThrow();
      expect(await serializeDocument(doc)).toEqual(before);
    },
  );

  it('refuses stale prepared operations before changing the document', async () => {
    const doc = await fixture();
    mark(doc);
    const prepared = prepareIsolatedTextRedaction(doc);
    doc.catalog.set('Changed', new PDFString('keep'));
    const before = await serializeDocument(doc);
    expect(() => prepared.commit()).toThrow(/changed after/);
    expect(await serializeDocument(doc)).toEqual(before);
  });
});
