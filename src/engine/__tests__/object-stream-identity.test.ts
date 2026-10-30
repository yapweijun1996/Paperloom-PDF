import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { rawPDF } from './audit-p1-fixtures';
import { parsePDF } from '../parser/parser';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFString } from '../types';
import { serializeDocument } from '../writer/serializer';

function fixture(options: { index5?: number; index6?: number; header?: string; first?: number;
  count?: number; type?: string; container?: number; firstBody?: string; secondBody?: string } = {}): Uint8Array {
  let text = '%PDF-1.7\n';
  const offsets: number[] = [];
  const object = (num: number, body: string) => { offsets[num] = text.length; text += `${num} 0 obj\n${body}\nendobj\n`; };
  object(1, '<< /Type /Catalog /Pages 2 0 R /Custom 5 0 R >>');
  object(2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>');
  object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> >>');
  const first = options.firstBody ?? '(ALPHA) ', second = options.secondBody ?? '(BRAVO)';
  const header = options.header ?? `5 0 6 ${first.length} `, stream = header + first + second;
  object(4, `<< /Type /${options.type ?? 'ObjStm'} /N ${options.count ?? 2} /First ${options.first ?? header.length} /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  const xrefOffset = text.length;
  offsets[7] = xrefOffset;
  const data = new Uint8Array(8 * 7);
  const xref = (obj: number, type: number, value: number, extra: number) => {
    const p = obj * 7; data[p] = type; data[p + 1] = value >>> 24; data[p + 2] = value >>> 16;
    data[p + 3] = value >>> 8; data[p + 4] = value; data[p + 5] = extra >>> 8; data[p + 6] = extra;
  };
  xref(0, 0, 0, 65535);
  for (const i of [1, 2, 3, 4, 7]) xref(i, 1, offsets[i], 0);
  xref(5, 2, options.container ?? 4, options.index5 ?? 0);
  xref(6, 2, 4, options.index6 ?? 1);
  const prefix = Buffer.from(text + `7 0 obj\n<< /Type /XRef /Size 8 /Root 1 0 R /W [1 4 2] /Length ${data.length} >>\nstream\n`, 'latin1');
  const suffix = Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1');
  return new Uint8Array(Buffer.concat([prefix, data, suffix]));
}

describe('object stream identity and header validation', () => {
  it('loads the named compressed objects and produces a valid independently reopened PDF', async () => {
    const source = fixture();
    const doc = await parsePDF(source);
    expect((doc.objects.get('5_0') as PDFString).value).toBe('ALPHA');
    expect((doc.objects.get('6_0') as PDFString).value).toBe('BRAVO');
    const output = await serializeDocument(doc);
    expect((await PDFDocument.load(output, { updateMetadata: false })).getPageCount()).toBe(1);
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-objstm-'));
    try {
      const before = join(dir, 'source.pdf'), after = join(dir, 'saved.pdf');
      writeFileSync(before, source); writeFileSync(after, output);
      const qpdf = spawnSync('qpdf', ['--version'], { stdio: 'ignore' });
      if (qpdf.error) {
        if (process.env.CI) throw qpdf.error;
      } else {
        execFileSync('qpdf', ['--check', before], { stdio: 'ignore' });
        execFileSync('qpdf', ['--check', after], { stdio: 'ignore' });
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('accepts nested objects, escaped strings, references and trailing comments', async () => {
    const source = fixture({ firstBody: '<< /List [1 2 /N] /Ref 6 0 R /Text (nested (yes) \\) ok) /Hex <A B 0> >> % comment\n' });
    const doc = await parsePDF(source), value = doc.objects.get('5_0') as PDFDict;
    expect(value.getArray('List')?.length).toBe(3);
    expect(value.getRef('Ref')?.toKey()).toBe('6_0');
    expect(value.getString('Text')).toBe('nested (yes) ) ok');
    expect((doc.objects.get('6_0') as PDFString).value).toBe('BRAVO');
    expect((await PDFDocument.load(source, { updateMetadata: false })).getPageCount()).toBe(1);
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-objstm-nested-'));
    try {
      const file = join(dir, 'nested.pdf'); writeFileSync(file, source);
      const qpdf = spawnSync('qpdf', ['--version'], { stdio: 'ignore' });
      if (qpdf.error) { if (process.env.CI) throw qpdf.error; }
      else execFileSync('qpdf', ['--check', file], { stdio: 'ignore' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('accepts whitespace and comments after the object stream index', async () => {
    const doc = await parsePDF(fixture({ header: '5 0 6 8  % index comment\n\t' }));
    expect((doc.objects.get('5_0') as PDFString).value).toBe('ALPHA');
    expect((doc.objects.get('6_0') as PDFString).value).toBe('BRAVO');
  });

  it('distinguishes R strings and names from indirect references', async () => {
    const source = fixture({ firstBody: '[5 0 (R) 6 0 /R 6 0 R] ' });
    const doc = await parsePDF(source);
    const array = doc.objects.get('5_0') as PDFArray;
    expect(array.items).toHaveLength(7);
    expect(array.items[0]).toBeInstanceOf(PDFNumber);
    expect(array.items[2]).toBeInstanceOf(PDFString);
    expect(array.items[5]).toBeInstanceOf(PDFName);
    expect((array.items[6] as PDFRef).toKey()).toBe('6_0');
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-objstm-reference-'));
    try {
      const file = join(dir, 'source.pdf'); writeFileSync(file, source);
      const qpdf = spawnSync('qpdf', ['--version'], { stdio: 'ignore' });
      if (qpdf.error) { if (process.env.CI) throw qpdf.error; }
      else execFileSync('qpdf', ['--check', file], { stdio: 'ignore' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('does not interpret a string following a dictionary as a stream keyword', async () => {
    const source = rawPDF([
      '<< /Type /Catalog /Pages 2 0 R /Custom [<<>> (stream)] >>',
      '<< /Type /Pages /Count 0 /Kids [] >>',
    ]);
    const doc = await parsePDF(source);
    const values = doc.catalog.getArray('Custom')!;
    expect(values.items[0]).toBeInstanceOf(PDFDict);
    expect((values.items[1] as PDFString).value).toBe('stream');
  });

  it.each([
    ['swapped index', { index5: 1, index6: 0 }],
    ['out-of-range index', { index5: 2 }],
    ['missing container', { container: 99 }],
    ['wrong stream type', { type: 'Other' }],
    ['duplicate object number', { header: '5 0 5 8 ' }],
    ['unordered offsets', { header: '5 8 6 0 ' }],
    ['negative offset', { header: '5 -1 6 8 ' }],
    ['offset beyond data', { header: '5 0 6 999 ' }],
    ['header crosses First', { first: 2 }],
    ['truncated header', { count: 3 }],
    ['extra index pair before First', { header: '5 0 6 8 99 0 ' }],
    ['extra token after header comment', { header: '5 0 6 8 % comment\n/Extra ' }],
    ['excessive header count', { count: 250001 }],
    ['truncated dictionary', { firstBody: '<< /Key 12 ' }],
    ['truncated array', { firstBody: '[ 1 2 ' }],
    ['truncated literal string', { firstBody: '(unterminated ' }],
    ['unterminated escaped string', { firstBody: '(not-closed\\) ' }],
    ['truncated hex string', { firstBody: '<CAFE ' }],
    ['extra object after first', { firstBody: '(ALPHA) (EXTRA) ' }],
    ['keyword masquerading as object', { firstBody: 'not-an-object ' }],
    ['dictionary missing a value', { firstBody: '<< /Missing >> ' }],
    ['invalid hex character', { firstBody: '<CAZG> ' }],
  ] as const)('rejects %s rather than associating the wrong object', async (_name, options) => {
    await expect(parsePDF(fixture(options))).rejects.toThrow(/object stream/i);
  });
});
