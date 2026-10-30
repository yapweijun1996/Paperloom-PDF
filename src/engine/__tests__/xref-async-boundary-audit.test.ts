import { webcrypto } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { afterEach, expect, it, vi } from 'vitest';
import { PDFDict, PDFString } from '../types';
import { parsePDF } from '../parser/parser';
import { saveQuick } from '../writer/save-pipeline';

afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  const pdf = await PDFDocument.create();
  pdf.addPage([100, 100]);
  return parsePDF(await pdf.save({ useObjectStreams: false }));
}

it('does not publish when a microtask changes source after async proof completes', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const doc = await fixture();
  const raw = doc.rawBytes, before = new Uint8Array(raw);
  let reads = 0;
  Object.defineProperty(doc, 'rawBytes', {
    configurable: true,
    get() { if (++reads === 2) queueMicrotask(() => { raw[0] ^= 1; }); return raw; },
    set() { throw new Error('must not publish'); },
  });
  await expect(saveQuick(doc, undefined, new Map([['900_0', new PDFString('new object')]])))
    .rejects.toThrow(/changed|conflicts/i);
  expect(raw[0]).not.toBe(before[0]);
  expect(doc.objects.has('900_0')).toBe(false);
});

it.each(['raw', 'xref', 'entries', 'entry', 'trailer', 'proof'] as const)(
  'preserves a replacement %s identity while verification awaits', async replacement => {
    const doc = await fixture();
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const active = new Promise<void>(resolve => { started = resolve; });
    vi.stubGlobal('crypto', { subtle: { digest: async (_algorithm: AlgorithmIdentifier, data: BufferSource) => {
      started();
      await gate;
      return webcrypto.subtle.digest('SHA-256', data as globalThis.BufferSource);
    } } });
    const pending = saveQuick(doc, undefined, new Map([['900_0', new PDFString('new object')]]));
    await active;
    if (replacement === 'raw') doc.rawBytes = new Uint8Array(doc.rawBytes);
    if (replacement === 'xref') doc.xref = { ...doc.xref };
    if (replacement === 'entries') doc.xref.entries = new Map(doc.xref.entries);
    const entryKey = doc.xref.entries.keys().next().value!;
    if (replacement === 'entry') doc.xref.entries.set(entryKey, { ...doc.xref.entries.get(entryKey)! });
    if (replacement === 'trailer') doc.xref.trailerDict = new PDFDict([...doc.xref.trailerDict.entries()]);
    if (replacement === 'proof') doc.xref.provenance = { ...doc.xref.provenance! };
    const current = { raw: doc.rawBytes, xref: doc.xref, entries: doc.xref.entries,
      entry: doc.xref.entries.get(entryKey), trailer: doc.xref.trailerDict, proof: doc.xref.provenance };
    release();
    await expect(pending).rejects.toThrow(/changed|conflicts/i);
    expect(doc.rawBytes).toBe(current.raw);
    expect(doc.xref).toBe(current.xref);
    expect(doc.xref.entries).toBe(current.entries);
    expect(doc.xref.entries.get(entryKey)).toBe(current.entry);
    expect(doc.xref.trailerDict).toBe(current.trailer);
    expect(doc.xref.provenance).toBe(current.proof);
    expect(doc.objects.has('900_0')).toBe(false);
  },
);
