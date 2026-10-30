import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFStream, PDFString } from '../types';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { prepareWholePageRedaction } from '../security/redaction/whole-page-redaction';
import { serializeDocument } from '../writer/serializer';
import { saveQuick } from '../writer/save-pipeline';

async function fixture(retained: string, fragments: string[] = [], secret = 'confidential') {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  pdf.addPage([200, 200]);
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  const info = doc.objects.get(doc.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;
  for (const key of [...info.keys()]) info.delete(key);

  const page = doc.pages[0], other = doc.pages[1];
  const note = new PDFRef(900, 0), stream = new PDFRef(901, 0);
  doc.objects.set(note.toKey(), new PDFDict([
    ['Subtype', new PDFName('Text')],
    ['Rect', new PDFArray([10, 10, 20, 20].map(n => new PDFNumber(n)))],
    ['Contents', new PDFString(secret)],
  ]));
  page.dict.set('Annots', new PDFArray([note]));
  other.resources.set('Font', new PDFDict([['F1', new PDFDict([
    ['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')],
    ['BaseFont', new PDFName('Helvetica')],
  ])]]));
  other.dict.set('Resources', other.resources);
  const bytes = new TextEncoder().encode(`BT /F1 12 Tf 10 50 Td (${retained}) Tj ET`);
  doc.objects.set(stream.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(bytes.length)]]), bytes));
  other.dict.set('Contents', stream);
  other.contentRefs.push(stream);
  for (let i = 0; i < fragments.length; i++) info.set(i === 0 ? 'Title' : 'Subject', new PDFString(fragments[i]));

  const original = await serializeDocument(doc);
  const reopened = await parsePDF(original);
  redactionEngine.markRegion(reopened, 0, { x: 0, y: 0, width: 200, height: 200 });
  return reopened;
}

describe('fragment union safety', () => {
  it('allows harmless overlap with insufficient distinct secret bytes', async () => {
    const doc = await fixture('public');
    const before = await serializeDocument(doc);
    expect(prepareWholePageRedaction(doc).commit().annotationsRemoved).toBe(2);
    const saved = await saveQuick(doc), reopened = await PDFDocument.load(saved);
    expect(reopened.getPageCount()).toBe(2);
    expect(reopened.getPage(0).node.Annots()).toBeUndefined();
    expect(new TextDecoder().decode(saved)).not.toContain('confidential');
    const hasPoppler = ['pdftotext', 'pdftoppm'].every(tool =>
      spawnSync(tool, ['-v'], { stdio: 'ignore' }).status === 0);
    if (hasPoppler) {
      const dir = mkdtempSync(join(tmpdir(), 'paperloom-union14-'));
      try {
        const input = join(dir, 'before.pdf'), output = join(dir, 'after.pdf');
        writeFileSync(input, before);
        writeFileSync(output, saved);
        expect(execFileSync('pdftotext', [output, '-'], { encoding: 'utf8' })).toContain('public');
        for (const dpi of [36, 72, 150]) {
          execFileSync('pdftoppm', ['-f', '2', '-l', '2', '-singlefile', '-r', String(dpi), input, join(dir, `a-${dpi}`)]);
          execFileSync('pdftoppm', ['-f', '2', '-l', '2', '-singlefile', '-r', String(dpi), output, join(dir, `b-${dpi}`)]);
          expect(readFileSync(join(dir, `a-${dpi}.ppm`))).toEqual(readFileSync(join(dir, `b-${dpi}.ppm`)));
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 20_000);

  it.each([
    ['confid', 'ential'],
    ['prefix confid suffix', 'prefix ential suffix'],
    ['confidential', ''],
  ])('rejects recoverable fragments %s %s', async (a, b) => {
    const doc = await fixture('xyz', [a, b]);
    const before = await serializeDocument(doc);
    expect(() => prepareWholePageRedaction(doc)).toThrow(/retained data contains removed annotation text/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('rejects a secret split into UTF-16 values on unrelated fields', async () => {
    const doc = await fixture('xyz');
    const info = doc.objects.get(doc.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;
    const encode = (text: string) => [...text].map(char => char.charCodeAt(0).toString(16).padStart(4, '0')).join('');
    info.set('Title', new PDFHexString('feff' + encode('prefix confid suffix')));
    info.set('Subject', new PDFHexString('feff' + encode('prefix ential suffix')));
    const before = await serializeDocument(doc);
    expect(() => prepareWholePageRedaction(doc)).toThrow(/retained data contains removed annotation text/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it.each(['name', 'key', 'literal', 'hex', 'shown-hex'] as const)(
    'rejects encoded fragments in a retained %s', async kind => {
      const secret = kind === 'literal' ? '351QZ' : 'e9QZ';
      const doc = await fixture('xyz', ['QZ'], secret);
      const info = doc.objects.get(doc.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;
      if (kind === 'name') doc.catalog.set('Custom', new PDFName('\u00e9'));
      if (kind === 'key') doc.catalog.set('\u00e9', new PDFNumber(0));
      if (kind === 'literal') info.set('Subject', new PDFString('\u00e9'));
      if (kind === 'hex') info.set('Subject', new PDFHexString('e9'));
      if (kind === 'shown-hex') {
        const page = doc.pages[1];
        const stream = doc.objects.get(page.contentRefs[0].toKey()) as PDFStream;
        const bytes = new TextEncoder().encode('BT /F1 12 Tf 10 50 Td <e9> Tj ET');
        stream.rawBytes = bytes;
        stream.decodedBytes = null;
        stream.dict.set('Length', new PDFNumber(bytes.length));
      }
      const before = await serializeDocument(doc);
      expect(() => prepareWholePageRedaction(doc)).toThrow(/retained data contains removed annotation text/i);
      expect(await serializeDocument(doc)).toEqual(before);
    },
  );

  it('rejects another note whose bytes are fully represented in retained values', async () => {
    const doc = await fixture('xyz', ['priv', 'ate']);
    const page = doc.pages[0], note = new PDFRef(1000, 0);
    doc.objects.set(note.toKey(), new PDFDict([
      ['Subtype', new PDFName('Text')],
      ['Rect', new PDFArray([20, 20, 30, 30].map(n => new PDFNumber(n)))],
      ['Contents', new PDFString('private')],
    ]));
    (page.dict.get('Annots') as PDFArray).items.push(note);
    const before = await serializeDocument(doc);
    expect(() => prepareWholePageRedaction(doc)).toThrow(/retained data contains removed annotation text/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });
});
