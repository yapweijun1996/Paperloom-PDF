import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PDFLexer } from '../parser/lexer';
import { parseObject } from '../parser/xref';
import { parsePDF } from '../parser/parser';
import { serializeDocument } from '../writer/serializer';
import { PDFArray, PDFDict, PDFNull, PDFNumber, PDFRef, PDFStream, PDFString } from '../types';

function parseText(text: string) {
  const lexer = new PDFLexer(new TextEncoder().encode(text));
  const value = parseObject(lexer);
  return { value, position: lexer.position };
}

describe('iterative PDF object parsing', () => {
  it('preserves nested dictionaries, arrays, reference lookahead, and cursor position', () => {
    const source = '<< /A [1 0 R 2 0 3 (hello) [4 << /B <4142> >>]] /C 7 >> tail';
    const { value, position } = parseText(source);
    const dict = value as PDFDict, array = dict.getArray('A')!;
    expect(array.items[0]).toEqual(new PDFRef(1, 0));
    expect(array.items.slice(1, 4)).toEqual([new PDFNumber(2), new PDFNumber(0), new PDFNumber(3)]);
    expect((array.items[4] as PDFString).value).toBe('hello');
    expect((array.items[5] as PDFArray).items[1]).toBeInstanceOf(PDFDict);
    expect(dict.getNumber('C')).toBe(7);
    expect(source.slice(position)).toBe(' tail');
  });

  it('retains permissive handling of malformed keys, missing values and EOF', () => {
    const dict = parseText('<< 4 /A 9 /B').value as PDFDict;
    expect(dict.getNumber('A')).toBe(9);
    expect(dict.get('B')).toBe(PDFNull.instance);
    const unclosed = parseText('[ 1 [2 3').value as PDFArray;
    expect((unclosed.items[1] as PDFArray).items).toEqual([new PDFNumber(2), new PDFNumber(3)]);
    expect(parseText('] trailing').value).toBe(PDFNull.instance);
    expect(parseText('').value).toBe(PDFNull.instance);
  });

  it('parses fourteen thousand mixed nested direct containers without recursion', () => {
    let source = '17';
    for (let i = 0; i < 14_000; i++) source = i % 2 ? `<< /Next ${source} >>` : `[${source}]`;
    let node = parseText(source).value;
    for (let i = 13_999; i >= 0; i--) node = i % 2 ? (node as PDFDict).get('Next')! : (node as PDFArray).items[0];
    expect((node as PDFNumber).value).toBe(17);
  });

  it('saves and reopens a PDF with fourteen thousand nested dictionaries', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    const root = new PDFDict(); let current = root;
    for (let i = 0; i < 14_000; i++) { const next = new PDFDict(); current.set('Next', next); current = next; }
    current.set('Value', new PDFNumber(17));
    doc.catalog.set('Deep', root);
    const reopened = await parsePDF(await serializeDocument(doc));
    let result = reopened.catalog.getDict('Deep')!;
    for (let i = 0; i < 14_000; i++) result = result.getDict('Next')!;
    expect(result.getNumber('Value')).toBe(17);
  }, 30000);

  it.skipIf(spawnSync('qpdf', ['--version'], { stdio: 'ignore' }).status !== 0).each([32, 100])(
    'writes %i nested dictionaries accepted by qpdf', async depth => {
      const pdf = await PDFDocument.create();
      pdf.addPage([200, 200]);
      const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
      const root = new PDFDict(); let current = root;
      for (let i = 0; i < depth; i++) { const next = new PDFDict(); current.set('Next', next); current = next; }
      current.set('Value', new PDFNumber(17));
      doc.catalog.set('Deep', root);
      const dir = mkdtempSync(join(tmpdir(), 'paperloom-deep-qpdf-'));
      try {
        const path = join(dir, 'output.pdf');
        writeFileSync(path, await serializeDocument(doc));
        const check = spawnSync('qpdf', ['--check', path], { encoding: 'utf8' });
        expect(check.status, `${check.stdout}\n${check.stderr}`).toBe(0);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 30000,
  );

  it('retains the full parser\'s permissive nested stream detection', async () => {
    const header = '%PDF-1.4\n';
    const bodies = [
      '<< /Type /Catalog /Pages 2 0 R /Nested [<< /Length 3 >>\nstream\nabc\nendstream] >>',
      '<< /Type /Pages /Kids [] /Count 0 >>',
    ];
    let source = header;
    const offsets = [0];
    bodies.forEach((body, index) => { offsets.push(source.length); source += `${index + 1} 0 obj\n${body}\nendobj\n`; });
    const xref = source.length;
    source += `xref\n0 3\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const parsed = await parsePDF(new TextEncoder().encode(source));
    const nested = parsed.catalog.getArray('Nested')!.items[0];
    expect(nested).toBeInstanceOf(PDFStream);
    expect(new TextDecoder().decode((nested as PDFStream).rawBytes)).toBe('abc');
  });

  it('retains the xref array limit without applying it to ordinary document objects', async () => {
    const array = `[${'0 '.repeat(32_769)}]`;
    expect(() => parseText(array)).toThrow(/xref array exceeds/i);
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    doc.catalog.set('LongArray', new PDFArray(Array.from({ length: 32_769 }, () => new PDFNumber(0))));
    const reopened = await parsePDF(await serializeDocument(doc));
    expect(reopened.catalog.getArray('LongArray')?.length).toBe(32_769);
  }, 30000);
});
