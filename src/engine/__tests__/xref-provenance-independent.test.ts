import { PDFDocument } from 'pdf-lib';
import { afterEach, expect, it, vi } from 'vitest';
import * as parser from '../parser/parser';
import { parsePDF } from '../parser/parser';
import { PDFName, PDFNumber, PDFRef, PDFString } from '../types';
import { saveQuick as saveDirect } from '../writer/save-pipeline';
import { appendIncrementalUpdate } from '../writer/incremental-writer';
import { saveQuick as saveWorker, resetPDFWorkerForTests } from '../worker/client';
import { handleWorkerCommand } from '../worker/handler';
import { PDFDict } from '../types';
import { SessionDocumentEditor } from '../session/document-edit';
import { dehydrateDocument, sameDocumentSnapshot } from '../worker/codec';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminate() {}
  postMessage(command: Parameters<typeof handleWorkerCommand>[0]) {
    void handleWorkerCommand(structuredClone(command)).then(response => this.onmessage?.({ data: structuredClone(response) } as MessageEvent));
  }
}
afterEach(() => { vi.restoreAllMocks(); resetPDFWorkerForTests(); delete (globalThis as { Worker?: unknown }).Worker; });

it.each(['direct', 'worker'] as const)('does not reuse an object added to an earlier incremental %s revision after it leaves the live map', async mode => {
  if (mode === 'worker') Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
  const pdf = await PDFDocument.create(); pdf.addPage([100, 100]);
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  const save = mode === 'worker' ? saveWorker : saveDirect;
  const root = doc.xref.trailerDict.getRef('Root')!;
  const ref = new PDFRef(900, 0);
  doc.catalog.set('Custom', ref);
  const first = await save(doc, new Set([root.toKey()]), new Map([[ref.toKey(), new PDFString('original')]]));
  expect((await parsePDF(first)).objects.get(ref.toKey())).toBeInstanceOf(PDFString);
  doc.objects.delete(ref.toKey());
  const baseline = new Uint8Array(doc.rawBytes);
  const identity = doc.rawBytes;
  await expect(save(doc, new Set([root.toKey()]), new Map([[ref.toKey(), new PDFString('replacement')]]))).rejects.toThrow(/conflicts/);
  expect(doc.rawBytes).toBe(identity);
  expect(new Uint8Array(doc.rawBytes)).toEqual(baseline);
  expect(doc.objects.has(ref.toKey())).toBe(false);
});

function historicalFreeFixture(danglingReference = false): Uint8Array {
  let text = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const [num, body] of [
    [1, `<< /Type /Catalog /Pages 2 0 R${danglingReference ? ' /Old 5 0 R' : ''} >>`],
    [2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> >>'],
    [5, '(old generation)'],
  ] as const) { offsets[num] = text.length; text += `${num} 0 obj\n${body}\nendobj\n`; }
  const first = text.length;
  text += 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) text += offsets[i] ? `${String(offsets[i]).padStart(10, '0')} 00000 n \n` : '0000000000 00000 f \n';
  text += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${first}\n%%EOF\n`;
  const second = text.length;
  text += `xref\n5 1\n0000000000 00001 f \ntrailer\n<< /Size 6 /Root 1 0 R /Prev ${first} >>\nstartxref\n${second}\n%%EOF\n`;
  return new TextEncoder().encode(text);
}

it.each(['direct', 'worker'] as const)('allows proven free generation reuse after a previous in-use revision through %s', async mode => {
  if (mode === 'worker') Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
  const doc = await parsePDF(historicalFreeFixture());
  expect(doc.objects.has('5_0')).toBe(false);
  const ref = new PDFRef(5, 1), value = new PDFString('current generation');
  doc.catalog.set('Current', ref);
  const root = doc.xref.trailerDict.getRef('Root')!;
  const output = await (mode === 'worker' ? saveWorker : saveDirect)(doc, new Set([root.toKey()]), new Map([[ref.toKey(), value]]));
  const reopened = await parsePDF(output);
  expect((reopened.objects.get('5_1') as PDFString).value).toBe('current generation');
  expect(reopened.objects.has('5_0')).toBe(false);
});

it('does not resolve a stale reference through an earlier freed generation', async () => {
  const doc = await parsePDF(historicalFreeFixture(true));
  expect(doc.catalog.get('Old')).toBeInstanceOf(PDFRef);
  expect(doc.objects.has('5_0')).toBe(false);
});

it('refuses a conflicting generation added to the live graph after parsing', async () => {
  const doc = await parsePDF(historicalFreeFixture());
  doc.objects.set('5_0', new PDFDict());
  const before = new Uint8Array(doc.rawBytes);
  await expect(saveDirect(doc, undefined, new Map([['5_1', new PDFString('new')]]))).rejects.toThrow(/conflicts/);
  expect(new Uint8Array(doc.rawBytes)).toEqual(before);
});

it.each(['direct', 'worker', 'low-level'] as const)(
  'refuses a stale generation written only as modifiedKeys via %s', async mode => {
    if (mode === 'worker') Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
    const doc = await parsePDF(historicalFreeFixture());
    const candidate = new PDFString('stale generation');
    doc.objects.set('5_0', candidate);
    const raw = doc.rawBytes, before = new Uint8Array(raw);
    if (mode === 'low-level') expect(() => appendIncrementalUpdate(doc, new Set(['5_0']))).toThrow(/conflicts|generation|xref/i);
    else await expect((mode === 'worker' ? saveWorker : saveDirect)(doc, new Set(['5_0']))).rejects.toThrow(/conflicts|generation|xref/i);
    expect(doc.rawBytes).toBe(raw);
    expect(new Uint8Array(doc.rawBytes)).toEqual(before);
    expect(doc.objects.get('5_0')).toBe(candidate);
  },
);

it('permits a genuinely unoccupied object written only as a modified key', async () => {
  const doc = await parsePDF(historicalFreeFixture());
  doc.objects.set('900_0', new PDFString('new object'));
  const reopened = await parsePDF(await saveDirect(doc, new Set(['900_0'])));
  expect((reopened.objects.get('900_0') as PDFString).value).toBe('new object');
});

it('refuses reuse when the parsed xref is changed after its provenance was established', async () => {
  const doc = await parsePDF(historicalFreeFixture());
  doc.xref.entries.set('5_0', { objNum: 5, genNum: 0, offset: 0, type: 'n' });
  const identity = doc.rawBytes;
  await expect(saveDirect(doc, undefined, new Map([['5_1', new PDFString('new')]]))).rejects.toThrow(/conflicts|changed|xref/i);
  expect(doc.rawBytes).toBe(identity);
});

it('refuses reuse when original bytes have changed in place after parsing', async () => {
  const doc = await parsePDF(historicalFreeFixture());
  const text = new TextDecoder('latin1').decode(doc.rawBytes);
  const offset = text.indexOf('old generation');
  expect(offset).toBeGreaterThan(0);
  doc.rawBytes[offset] ^= 1;
  const identity = doc.rawBytes, before = new Uint8Array(doc.rawBytes);
  await expect(saveDirect(doc, undefined, new Map([['5_1', new PDFString('new')]]))).rejects.toThrow(/conflicts|changed|xref/i);
  expect(doc.rawBytes).toBe(identity);
  expect(new Uint8Array(doc.rawBytes)).toEqual(before);
});

it.each(['Size', 'Prev', 'XRefStm'] as const)(
  'refuses to trust a parsed xref after trailer /%s is changed', async key => {
    const doc = await parsePDF(historicalFreeFixture());
    doc.xref.trailerDict.set(key, new PDFNumber(123));
    const raw = doc.rawBytes, before = new Uint8Array(raw);
    await expect(saveDirect(doc, undefined, new Map([['5_1', new PDFString('new')]]))).rejects.toThrow(/conflicts|changed|xref/i);
    expect(doc.rawBytes).toBe(raw);
    expect(new Uint8Array(doc.rawBytes)).toEqual(before);
  },
);

it('does not alter the supplied document when a prepared undo is canceled', async () => {
  const doc = await parsePDF(historicalFreeFixture());
  const editor = new SessionDocumentEditor();
  await editor.edit(doc, 'fixture', async draft => { draft.pages[0].dict.set('Rotate', new PDFNumber(90)); });
  const before = dehydrateDocument(doc);
  const prepared = await editor.prepareRestore(doc, 'undo');
  expect(prepared).not.toBeNull();
  prepared!.cancel();
  expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
  expect(doc.pages[0].dict.getNumber('Rotate')).toBe(90);
  expect(editor.canUndo).toBe(true);
});

it('does not commit a prepared undo after its document owner becomes stale', async () => {
  const doc = await parsePDF(historicalFreeFixture());
  const editor = new SessionDocumentEditor();
  await editor.edit(doc, 'fixture', async draft => { draft.pages[0].dict.set('Rotate', new PDFNumber(90)); });
  let current = true;
  const before = dehydrateDocument(doc);
  const prepared = await editor.prepareRestore(doc, 'undo', () => current);
  expect(prepared).not.toBeNull();
  current = false;
  expect(() => prepared!.commit()).toThrow(/changed/i);
  prepared!.cancel();
  expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
  expect(editor.canUndo).toBe(true);
});

it('preserves concurrent work and the original state when a prepared undo is canceled', async () => {
  const doc = await parsePDF(historicalFreeFixture());
  const editor = new SessionDocumentEditor();
  await editor.edit(doc, 'fixture', async draft => { draft.pages[0].dict.set('Rotate', new PDFNumber(90)); });
  const prepared = await editor.prepareRestore(doc, 'undo');
  expect(prepared).not.toBeNull();
  doc.catalog.set('ConcurrentEdit', new PDFString('keep'));
  expect(() => prepared!.cancel()).not.toThrow();
  expect((doc.catalog.get('ConcurrentEdit') as PDFString).value).toBe('keep');
  expect(doc.pages[0].dict.getNumber('Rotate')).toBe(90);
  expect(editor.canUndo).toBe(true);
});

it('preserves concurrent work and original state when a prepared undo becomes stale', async () => {
  const doc = await parsePDF(historicalFreeFixture());
  const editor = new SessionDocumentEditor();
  await editor.edit(doc, 'fixture', async draft => { draft.pages[0].dict.set('Rotate', new PDFNumber(90)); });
  let current = true;
  const prepared = await editor.prepareRestore(doc, 'undo', () => current);
  expect(prepared).not.toBeNull();
  doc.catalog.set('ConcurrentEdit', new PDFString('keep'));
  current = false;
  expect(() => prepared!.commit()).toThrow(/changed/i);
  prepared!.cancel();
  expect((doc.catalog.get('ConcurrentEdit') as PDFString).value).toBe('keep');
  expect(doc.pages[0].dict.getNumber('Rotate')).toBe(90);
  expect(editor.canUndo).toBe(true);
});

it.each(['Size', 'Prev', 'XRefStm'] as const)(
  'does not overwrite a concurrently changed trailer /%s during undo', async key => {
    const doc = await parsePDF(historicalFreeFixture());
    const editor = new SessionDocumentEditor();
    await editor.edit(doc, 'fixture', async draft => { draft.pages[0].dict.set('Rotate', new PDFNumber(90)); });
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const active = new Promise<void>(resolve => { started = resolve; });
    const original = parser.parsePDF;
    vi.spyOn(parser, 'parsePDF').mockImplementation(async (...args) => { started(); await gate; return original(...args); });
    const pending = editor.undo(doc);
    await active;
    doc.xref.trailerDict.set(key, new PDFNumber(999));
    release();
    await expect(pending).rejects.toThrow(/changed|xref/i);
    expect(doc.xref.trailerDict.getNumber(key)).toBe(999);
    expect(doc.pages[0].dict.getNumber('Rotate')).toBe(90);
  },
);

it('refuses reuse if a trailer field changes from invalid to a different invalid value', async () => {
  const bytes = new TextEncoder().encode(new TextDecoder().decode(historicalFreeFixture()).replace(/\/Prev \d+/, '/Prev /BadA'));
  const doc = await parsePDF(bytes);
  expect(doc.xref.trailerDict.getName('Prev')).toBe('BadA');
  doc.xref.trailerDict.set('Prev', new PDFName('BadB'));
  // A malformed xref must not become trusted merely because its invalid
  // value was replaced by another value of the same PDF object class.
  await expect(saveDirect(doc, undefined, new Map([['5_1', new PDFString('new')]]))).rejects.toThrow(/conflicts|changed|xref/i);
});

it('refuses reuse if xref source classification is changed after parsing', async () => {
  const doc = await parsePDF(historicalFreeFixture());
  expect(doc.xref.provenance).toBeDefined();
  doc.xref.provenance!.source = doc.xref.provenance!.source === 'strict' ? 'conservative' : 'strict';
  await expect(saveDirect(doc, undefined, new Map([['5_1', new PDFString('new')]]))).rejects.toThrow(/conflicts|changed|xref/i);
});

it.each(['Size', 'Prev', 'XRefStm'] as const)(
  'does not overwrite a concurrently changed trailer /%s during an editor transaction', async key => {
    const doc = await parsePDF(historicalFreeFixture());
    const editor = new SessionDocumentEditor();
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const active = new Promise<void>(resolve => { started = resolve; });
    const pending = editor.edit(doc, 'fixture', async draft => {
      started(); await gate;
      draft.pages[0].dict.set('Rotate', new PDFNumber(90));
    });
    await active;
    doc.xref.trailerDict.set(key, new PDFNumber(999));
    release();
    await expect(pending).rejects.toThrow(/changed|xref/i);
    expect(doc.xref.trailerDict.getNumber(key)).toBe(999);
    expect(doc.pages[0].dict.getNumber('Rotate') ?? 0).toBe(0);
  },
);

function hybridFixture(includeFreeEntry = false): Uint8Array {
  const chunks: Buffer[] = [], offsets = new Map<number, number>();
  let position = 0;
  const add = (value: string | Buffer) => { const bytes = typeof value === 'string' ? Buffer.from(value, 'latin1') : value; chunks.push(bytes); position += bytes.length; };
  const object = (number: number, body: string) => { offsets.set(number, position); add(`${number} 0 obj\n${body}\nendobj\n`); };
  add('%PDF-1.5\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R /Custom 5 0 R >>');
  object(2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>');
  object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> >>');
  const objectStream = Buffer.from('5 0 (compressed value)');
  offsets.set(10, position); add(`10 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Length ${objectStream.length} >>\nstream\n`);
  add(objectStream); add('\nendstream\nendobj\n');
  offsets.set(11, position); const entry = Buffer.from([2, 0, 0, 0, 10, 0, 0]);
  add(`11 0 obj\n<< /Type /XRef /Size 12 /W [1 4 2] /Index [5 1] /Length ${entry.length} >>\nstream\n`);
  add(entry); add('\nendstream\nendobj\n');
  const xref = position; add('xref\n0 4\n0000000000 65535 f \n');
  for (let i = 1; i <= 3; i++) add(`${String(offsets.get(i)).padStart(10, '0')} 00000 n \n`);
  if (includeFreeEntry) add('5 1\n0000000000 00000 f \n');
  add('10 2\n');
  for (let i = 10; i <= 11; i++) add(`${String(offsets.get(i)).padStart(10, '0')} 00000 n \n`);
  add(`trailer\n<< /Size 12 /Root 1 0 R /XRefStm ${offsets.get(11)} >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

it.each(['direct', 'worker'] as const)('does not overwrite a compressed object hidden in a hybrid xref via %s save', async mode => {
  if (mode === 'worker') Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
  const bytes = hybridFixture();
  if (!spawnSync('qpdf', ['--version'], { stdio: 'ignore' }).error) {
    const folder = mkdtempSync(join(tmpdir(), 'paperloom-hybrid-audit-'));
    try {
      const file = join(folder, 'hybrid.pdf'); writeFileSync(file, bytes);
      execFileSync('qpdf', ['--check', file], { stdio: 'ignore' });
      expect(execFileSync('qpdf', ['--show-object=5', file], { encoding: 'utf8' })).toContain('compressed value');
    } finally { rmSync(folder, { recursive: true, force: true }); }
  } else if (process.env.CI) throw new Error('qpdf is required for the hybrid xref audit');
  const doc = await parsePDF(bytes);
  expect((doc.objects.get('5_0') as PDFString).value).toBe('compressed value');
  const raw = doc.rawBytes, before = new Uint8Array(raw);
  await expect((mode === 'worker' ? saveWorker : saveDirect)(doc, undefined, new Map([['5_0', new PDFString('overwrite')]]))).rejects.toThrow(/conflicts|xref|unavailable/i);
  expect(doc.rawBytes).toBe(raw);
  expect(new Uint8Array(doc.rawBytes)).toEqual(before);
});

it.each(['direct', 'worker'] as const)('refuses an unknown object when the hybrid xref supplement is damaged via %s save', async mode => {
  if (mode === 'worker') Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
  const text = Buffer.from(hybridFixture()).toString('latin1');
  const match = /\/XRefStm (\d+)/.exec(text)!;
  const bad = String(Number(match[1]) + 1);
  expect(bad.length).toBe(match[1].length);
  const bytes = Buffer.from(text.replace(match[0], `/XRefStm ${bad}`), 'latin1');
  const doc = await parsePDF(bytes), raw = doc.rawBytes, before = new Uint8Array(raw);
  await expect((mode === 'worker' ? saveWorker : saveDirect)(doc, undefined, new Map([['5_0', new PDFString('overwrite')]]))).rejects.toThrow(/conflicts|xref|unavailable/i);
  expect(doc.rawBytes).toBe(raw);
  expect(new Uint8Array(doc.rawBytes)).toEqual(before);
});

it('does not treat a preinserted object as proven occupied on a damaged hybrid xref', async () => {
  const text = Buffer.from(hybridFixture()).toString('latin1');
  const match = /\/XRefStm (\d+)/.exec(text)!;
  const bad = String(Number(match[1]) + 1);
  expect(bad.length).toBe(match[1].length);
  const doc = await parsePDF(Buffer.from(text.replace(match[0], `/XRefStm ${bad}`), 'latin1'));
  const candidate = new PDFString('preinserted overwrite');
  doc.objects.set('5_0', candidate);
  const raw = doc.rawBytes, before = new Uint8Array(raw);
  await expect(saveDirect(doc, undefined, new Map([['5_0', candidate]]))).rejects.toThrow(/conflicts|xref|unavailable/i);
  expect(doc.rawBytes).toBe(raw);
  expect(new Uint8Array(doc.rawBytes)).toEqual(before);
  expect(doc.objects.get('5_0')).toBe(candidate);
});

it('refuses an unknown object written as a modified key on a damaged hybrid xref', async () => {
  const text = Buffer.from(hybridFixture()).toString('latin1');
  const match = /\/XRefStm (\d+)/.exec(text)!;
  const bad = String(Number(match[1]) + 1);
  const doc = await parsePDF(Buffer.from(text.replace(match[0], `/XRefStm ${bad}`), 'latin1'));
  const candidate = new PDFString('overwrite');
  doc.objects.set('5_0', candidate);
  const raw = doc.rawBytes, before = new Uint8Array(raw);
  await expect(saveDirect(doc, new Set(['5_0']))).rejects.toThrow(/conflicts|generation|xref|incomplete/i);
  expect(doc.rawBytes).toBe(raw);
  expect(new Uint8Array(doc.rawBytes)).toEqual(before);
  expect(doc.objects.get('5_0')).toBe(candidate);
});

it('does not silently authorize reuse when hybrid xref table and supplement conflict', async () => {
  const bytes = hybridFixture(true);
  if (!spawnSync('qpdf', ['--version'], { stdio: 'ignore' }).error) {
    const folder = mkdtempSync(join(tmpdir(), 'paperloom-hybrid-conflict-'));
    try {
      const file = join(folder, 'hybrid.pdf'); writeFileSync(file, bytes);
      execFileSync('qpdf', ['--check', file], { stdio: 'ignore' });
      expect(execFileSync('qpdf', ['--show-object=5', file], { encoding: 'utf8' }).trim()).toBe('null');
    } finally { rmSync(folder, { recursive: true, force: true }); }
  } else if (process.env.CI) throw new Error('qpdf is required for the hybrid xref audit');
  const doc = await parsePDF(bytes), raw = doc.rawBytes, before = new Uint8Array(raw);
  await expect(saveDirect(doc, undefined, new Map([['5_0', new PDFString('overwrite')]]))).rejects.toThrow(/conflicts|xref|unavailable/i);
  expect(doc.rawBytes).toBe(raw);
  expect(new Uint8Array(doc.rawBytes)).toEqual(before);
});
