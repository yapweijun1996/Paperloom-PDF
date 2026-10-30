import { expect, it } from 'vitest';
import { rawPDF } from './audit-p1-fixtures';
import { parsePDF } from '../parser/parser';
import { serializeDocument } from '../writer/serializer';
import * as engine from '../browser-core';
import { replaceSearchMatches } from '@/app/editor/search-index';
const stream = (value: string) => `<< /Length ${value.length} >>\nstream\n${value}\nendstream`;
const pdf = (a: string, b: string) => rawPDF([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 160 140] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents [4 0 R 5 0 R] >>',
  stream(a), stream(b),
]);
it('refuses a public replacement that would insert whitespace inside a cross-stream string', async () => {
  const doc = await parsePDF(pdf('BT /F1 10 Tf 10 110 Td (FIRST', 'SECOND) Tj ET'));
  const before = await serializeDocument(doc);
  await expect(replaceSearchMatches(doc, 'FIRST', 'CHANGED', true, engine)).rejects.toThrow(/stream|boundary/i);
  expect(await serializeDocument(doc)).toEqual(before);
});
it('retains ordinary stream-token boundaries, including adjacent q/Q', async () => {
  const doc = await parsePDF(pdf('q', 'Q BT /F1 10 Tf 10 110 Td (FIRST) Tj ET'));
  await expect(replaceSearchMatches(doc, 'FIRST', 'CHANGED', true, engine)).resolves.toBe(1);
});
it.each([
  ['nested text', 'BT /F1 10 Tf 10 110 Td (FIRST(', 'SECOND)) Tj ET'],
  ['escaped newline', 'BT /F1 10 Tf 10 110 Td (FIRST\\', '\nSECOND) Tj ET'],
  ['split octal', 'BT /F1 10 Tf 10 110 Td (FIRST\\1', '01SECOND) Tj ET'],
])('refuses %s before mutation', async (_name, a, b) => {
  const doc = await parsePDF(pdf(a,b)); const before = await serializeDocument(doc);
  await expect(engine.updatePageContent(doc.pages[0].contentRefs, engine.getPageContentBytes(doc.pages[0],doc.objects),doc.objects,false)).rejects.toThrow(/boundary/i);
  expect(await serializeDocument(doc)).toEqual(before);
});
it('permits a hex string split because PDF hex ignores whitespace', async () => {
  const doc = await parsePDF(pdf('BT /F1 10 Tf 10 110 Td <464952', '5354> Tj ET'));
  await expect(replaceSearchMatches(doc, 'FIRST', 'CHANGE', true, engine)).resolves.toBe(1);
});
it('refuses inserted whitespace within inline image samples', async () => {
  const doc = await parsePDF(pdf('q BI /W 2 /H 2 /BPC 8 /CS /G ID \x11\x22', '\x33\x44 EI Q'));
  const before = await serializeDocument(doc);
  await expect(engine.updatePageContent(doc.pages[0].contentRefs, engine.getPageContentBytes(doc.pages[0],doc.objects),doc.objects,false)).rejects.toThrow(/boundary/i);
  expect(await serializeDocument(doc)).toEqual(before);
});
it('permits an inline image wholly inside one stream', async () => {
  const doc = await parsePDF(pdf('q BI /W 2 /H 2 /BPC 8 /CS /G ID \x11\x22\x33\x44 EI Q ', 'BT /F1 10 Tf (FIRST) Tj ET'));
  await expect(replaceSearchMatches(doc, 'FIRST', 'CHANGE', true, engine)).resolves.toBe(1);
});
it('allows ordinary Flate-compressed multiple streams after saved reopen', async () => {
  const { deflateSync } = await import('node:zlib');
  const { PDFName, PDFNumber, PDFStream } = await import('../types');
  const doc = await parsePDF(pdf('q', 'Q BT /F1 10 Tf (FIRST) Tj ET'));
  const first = doc.objects.get(doc.pages[0].contentRefs[0].toKey());
  if (!(first instanceof PDFStream)) throw new Error('Expected stream');
  first.rawBytes = new Uint8Array(deflateSync(first.rawBytes));
  first.dict.set('Filter', new PDFName('FlateDecode'));
  first.dict.set('Length', new PDFNumber(first.rawBytes.length));
  const reopened = await parsePDF(await serializeDocument(doc));
  await expect(replaceSearchMatches(reopened,'FIRST','CHANGE',true,engine)).resolves.toBe(1);
});
it('refuses an unknown stream filter before changing the input', async () => {
  const { PDFName, PDFStream } = await import('../types');
  const doc = await parsePDF(pdf('q', 'Q BT /F1 10 Tf (FIRST) Tj ET'));
  const first = doc.objects.get(doc.pages[0].contentRefs[0].toKey());
  if (!(first instanceof PDFStream)) throw new Error('Expected stream');
  first.dict.set('Filter',new PDFName('Unknown'));
  const before = await serializeDocument(doc);
  await expect(engine.updatePageContent(doc.pages[0].contentRefs,engine.getPageContentBytes(doc.pages[0],doc.objects),doc.objects,false)).rejects.toThrow(/boundary/i);
  expect(await serializeDocument(doc)).toEqual(before);
});
it('opens a nonconforming multi-stream page without applying unsafe optional TJ normalization', async () => {
  const { normalizePageContent } = await import('@/app/editor/normalize-page-content');
  const doc = await parsePDF(pdf('BT /F1 12 Tf 10 110 Td [(FIRST', 'SECOND) -4000 (THIRD)] TJ ET'));
  const before = await serializeDocument(doc);
  const raw = engine.getPageContentBytes(doc.pages[0],doc.objects);
  const normalized = engine.explodeTJGaps(raw,doc.pages[0],doc.objects,new engine.OptionalContentVisibility(doc.catalog,doc.objects));
  expect(normalized).not.toBe(raw);
  const result = await normalizePageContent(doc,doc.pages[0],engine);
  expect(result.warning).toMatch(/boundary/i);
  expect(result.bytes).toEqual(raw);
  expect(await serializeDocument(doc)).toEqual(before);
});

it('bounds filter chains and aggregate indirect resolution before decoding', async () => {
  const { assertMultiStreamMergeSafe } = await import('../editor/multistream-edit-safety');
  const { PDFArray, PDFDict, PDFName, PDFRef, PDFStream } = await import('../types');
  const tooMany = new PDFDict([['Filter', new PDFArray(Array.from({ length: 200_000 }, () => new PDFName('ASCIIHexDecode')))]]);
  await expect(assertMultiStreamMergeSafe([new PDFStream(tooMany, new Uint8Array()), new PDFStream(new PDFDict(), new Uint8Array())], new Map())).rejects.toThrow(/boundary/i);
  const objects = new Map<string, import('../types').PDFObject>();
  const streams: import('../types').PDFStream[] = [];
  let id = 100;
  for (let index = 0; index < 513; index++) {
    const first = new PDFRef(id, 0);
    for (let depth = 0; depth < 128; depth++) {
      const ref = new PDFRef(id++, 0);
      objects.set(ref.toKey(), depth === 127 ? new PDFName('ASCIIHexDecode') : new PDFRef(id, 0));
    }
    streams.push(new PDFStream(new PDFDict([['Filter', first]]), new Uint8Array(), new Uint8Array()));
  }
  await expect(assertMultiStreamMergeSafe(streams, objects)).rejects.toThrow(/boundary/i);
});

it('scans large PDF tokens under a constrained heap without constructing their text', async () => {
  const { buildSync } = await import('esbuild');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'paperloom-multistream-memory-'));
  try {
    const file = join(root, 'probe.cjs');
    const types = join(process.cwd(), 'src/engine/types.ts');
    const safety = join(process.cwd(), 'src/engine/editor/multistream-edit-safety.ts');
    const entry = `import { PDFDict, PDFStream } from ${JSON.stringify(types)};
import { assertMultiStreamMergeSafe } from ${JSON.stringify(safety)};
const size = 12_000_000, encoder = new TextEncoder(), kind = process.argv[2];
const prefix = kind === 'literal' || kind === 'split' ? 'BT (' : kind === 'hex' ? '<' : kind === 'name' ? '/' : kind === 'inline' ? 'BI /Unused (' : kind === 'inlinewidth' ? 'BI /W ' : '';
const suffix = kind === 'literal' || kind === 'split' ? ') Tj ET' : kind === 'hex' ? '>' : kind === 'inline' ? ') /W 1 /H 1 /BPC 8 /CS /G ID \\x00 EI' : kind === 'inlinewidth' ? '1 /H 1 /BPC 8 /CS /G ID \\x00 EI' : '';
const character = kind === 'number' ? 49 : kind === 'hex' || kind === 'inlinewidth' ? 48 : 65;
const start = encoder.encode(prefix), end = encoder.encode(suffix);
const bytes = new Uint8Array(start.length + size + end.length);
bytes.set(start); bytes.fill(character, start.length, start.length + size); bytes.set(end, start.length + size);
const streams = kind === 'split' ? [new PDFStream(new PDFDict(), bytes.subarray(0, start.length + size / 2)), new PDFStream(new PDFDict(), bytes.subarray(start.length + size / 2))] : [new PDFStream(new PDFDict(), bytes), new PDFStream(new PDFDict(), encoder.encode(' q Q'))];
assertMultiStreamMergeSafe(streams, new Map()).then(() => { if (kind === 'split') process.exit(2); }).catch(() => { if (kind !== 'split') process.exit(3); });`;
    buildSync({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, outfile: file, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    for (const kind of ['literal', 'hex', 'name', 'number', 'keyword', 'inline', 'inlinewidth', 'split']) {
      const result = spawnSync(process.execPath, ['--max-old-space-size=256', file, kind], { timeout: 30_000, encoding: 'utf8' });
      expect(result.status, `${kind}: ${result.stderr}`).toBe(0);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
