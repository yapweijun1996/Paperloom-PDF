import { PDFDocument } from 'pdf-lib';
import { expect, it, vi } from 'vitest';
import * as engine from '@/engine/browser-core';
import { parsePDF } from '@/engine/parser/parser';
import { PDFDict, PDFStream } from '@/engine/types';
import { DocumentSearchIndex, searchDocument } from './search-index';

async function fixture() {
  const source = await PDFDocument.create();
  source.addPage();
  return parsePDF(await source.save({ useObjectStreams: false }));
}

it('checks cancellation while validating a large, legal xref', async () => {
  const doc = await fixture();
  let visits = 0, checks = 0;
  const entry = new Proxy({}, { ownKeys(target) { visits++; return Reflect.ownKeys(target); } });
  doc.xref.entries.clear();
  for (let i = 0; i < 250_000; i++) doc.xref.entries.set(String(i), entry as never);
  const publish = vi.fn();
  const result = await searchDocument(doc, 'test', false, 'same', new DocumentSearchIndex(), engine,
    () => ++checks < 2, async () => {}, Infinity, publish);
  expect(result).toBeNull();
  expect(visits).toBeLessThan(2_048);
  expect(publish).not.toHaveBeenCalled();
}, 30_000);

it('accepts the xref boundary and rejects an excessive xref before inspecting entries', async () => {
  const doc = await fixture();
  let visits = 0;
  const entry = new Proxy({}, { ownKeys(target) { visits++; return Reflect.ownKeys(target); } });
  doc.xref.entries.clear();
  for (let i = 0; i < 250_000; i++) doc.xref.entries.set(String(i), entry as never);
  const index = new DocumentSearchIndex();
  expect(await searchDocument(doc, 'test', false, 'same', index, engine, () => true)).toEqual([]);
  expect(visits).toBe(500_000); // Initial and final safety passes, with no extra snapshot passes.
  expect(index.getCachedBytes()).toBe(0);
  doc.xref.entries.set('250000', entry as never);
  visits = 0;
  await expect(searchDocument(doc, 'test', false, 'same', index, engine, () => true))
    .rejects.toThrow(/inspection limit/i);
  expect(visits).toBe(0);
}, 30_000);

it('still rejects custom xref records and shared stream buffers', async () => {
  const doc = await fixture();
  doc.xref.entries.set('999', { get hidden() { return 1; } } as never);
  await expect(searchDocument(doc, 'test', false, 'same', new DocumentSearchIndex(), engine, () => true))
    .rejects.toThrow(/custom document containers/i);
  doc.xref.entries.delete('999');
  doc.objects.set('999_0', new PDFStream(new PDFDict(), new Uint8Array(new SharedArrayBuffer(4))));
  await expect(searchDocument(doc, 'test', false, 'same', new DocumentSearchIndex(), engine, () => true))
    .rejects.toThrow(/shared stream buffers/i);
});

it('limits the total content references inspected across pages', async () => {
  const doc = await fixture();
  const page = doc.pages[0];
  const refs = Array(100_000).fill(page.ref);
  doc.pages = Array.from({ length: 6 }, () => ({ ...page, contentRefs: refs }));
  await expect(searchDocument(doc, 'test', false, 'same', new DocumentSearchIndex(), engine, () => true))
    .rejects.toThrow(/inspection limit/i);
}, 30_000);

it('does not let a changing xref evade the inspection limit', async () => {
  const doc = await fixture();
  const entry = {} as never;
  doc.xref.entries.clear();
  for (let i = 0; i < 2_048; i++) doc.xref.entries.set(String(i), entry);
  let checks = 0;
  await expect(searchDocument(doc, 'test', false, 'same', new DocumentSearchIndex(), engine, () => {
    if (++checks === 2) for (let i = 2_048; i <= 250_000; i++) doc.xref.entries.set(String(i), entry);
    return true;
  })).rejects.toThrow(/inspection limit/i);
}, 30_000);
