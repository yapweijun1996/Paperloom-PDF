import { PDFDocument } from 'pdf-lib';
import { afterEach, expect, it, vi } from 'vitest';
import { parsePDF } from '../parser/parser';
import { PDFRef, PDFString } from '../types';
import { coordinateQuickSave } from '../writer/save-coordinator';
import { saveQuick } from '../writer/save-pipeline';
import { saveQuick as saveWorker, resetPDFWorkerForTests } from '../worker/client';
import { handleWorkerCommand } from '../worker/handler';
import type { WorkerCommand, WorkerResponse } from '../worker/protocol';

class ControlledWorker {
  static instance: ControlledWorker | undefined;
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  requests: WorkerCommand[] = [];
  constructor() { ControlledWorker.instance = this; }
  terminate() {}
  postMessage(command: WorkerCommand) { this.requests.push(structuredClone(command)); }
  async reply(index: number) {
    const response = await handleWorkerCommand(this.requests[index]);
    this.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
  }
}

afterEach(() => {
  resetPDFWorkerForTests();
  ControlledWorker.instance = undefined;
  delete (globalThis as { Worker?: unknown }).Worker;
});

function freeGenerationPdf(): Uint8Array {
  let text = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const [number, body] of [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>'],
  ] as const) { offsets[number] = text.length; text += `${number} 0 obj\n${body}\nendobj\n`; }
  const xref = text.length;
  text += 'xref\n0 6\n0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) text += `${String(offset).padStart(10, '0')} 00000 n \n`;
  text += '0000000000 00000 f \n0000000000 00001 f \n';
  text += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(text);
}

function historyGenerationPdf(reuse: boolean): Uint8Array {
  let text = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const [number, body] of [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>'],
    [5, '(old generation)'],
  ] as const) { offsets[number] = text.length; text += `${number} 0 obj\n${body}\nendobj\n`; }
  const xref = text.length;
  text += 'xref\n0 6\n0000000000 65535 f \n';
  for (let number = 1; number <= 5; number++) {
    text += offsets[number] ? `${String(offsets[number]).padStart(10, '0')} 00000 n \n` : '0000000000 00000 f \n';
  }
  text += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const secondXref = text.length;
  text += `xref\n5 1\n0000000000 00001 f \ntrailer\n<< /Size 6 /Root 1 0 R /Prev ${xref} >>\nstartxref\n${secondXref}\n%%EOF\n`;
  if (reuse) {
    const position = text.length; text += '5 1 obj\n(current generation)\nendobj\n';
    const thirdXref = text.length;
    text += `xref\n5 1\n${String(position).padStart(10, '0')} 00001 n \ntrailer\n<< /Size 6 /Root 1 0 R /Prev ${secondXref} >>\nstartxref\n${thirdXref}\n%%EOF\n`;
  }
  return new TextEncoder().encode(text);
}

it.each([false, true])('uses the current xref generation in a validated revision chain; reused=%s', async reuse => {
  const doc = await parsePDF(historyGenerationPdf(reuse));
  expect([...doc.xref.entries.values()].filter(entry => entry.objNum === 5).map(entry => `${entry.genNum}${entry.type}`)).toEqual(
    reuse ? ['1n'] : ['1f']);
  expect(doc.objects.has('5_0')).toBe(false);
  doc.objects.delete('5_0');
  const value = reuse ? doc.objects.get('5_1')! : new PDFString('current generation');
  doc.objects.set('5_1', value);
  doc.catalog.set('Custom', new PDFRef(5, 1));
  const reopened = await parsePDF(await saveQuick(doc, new Set(['1_0']), new Map([['5_1', value]])));
  expect((reopened.objects.get('5_1') as PDFString).value).toBe('current generation');
  expect(reopened.objects.has('5_0')).toBe(false);
});

it('reuses a single unambiguous free xref entry at the correct generation', async () => {
  const doc = await parsePDF(freeGenerationPdf());
  const value = new PDFString('correct generation');
  doc.objects.set('5_1', value);
  doc.catalog.set('Custom', new PDFRef(5, 1));
  const reopened = await parsePDF(await saveQuick(doc, new Set(['1_0']), new Map([['5_1', value]])));
  expect((reopened.objects.get('5_1') as PDFString).value).toBe('correct generation');
});

it('rejects a previously freed object with a stale generation even if preinserted into the live object map', async () => {
  const doc = await parsePDF(freeGenerationPdf());
  expect(doc.xref.entries.get('5_1')).toMatchObject({ type: 'f', genNum: 1 });
  const value = new PDFString('bad generation');
  doc.objects.set('5_0', value);
  doc.catalog.set('Custom', new PDFRef(5, 0));
  const original = doc.rawBytes;
  await expect(saveQuick(doc, new Set(['1_0']), new Map([['5_0', value]]))).rejects.toThrow(/conflicts/);
  expect(doc.rawBytes).toBe(original);
  expect(doc.objects.get('5_0')).toBe(value);
});

it('preserves a live same-valued object replacement during a save', async () => {
  const source = await PDFDocument.create(); source.addPage([200, 200]);
  const doc = await parsePDF(await source.save({ useObjectStreams: false }));
  const original = new PDFString('same');
  const replacement = new PDFString('same');
  const key = '500_0';
  doc.objects.set(key, original);
  const pending = coordinateQuickSave(doc, undefined, new Map([[key, original]]), async () => {
    doc.objects.set(key, replacement);
    return { bytes: new Uint8Array([1, 2]), rawBytesAdvanced: false };
  });
  await expect(pending).rejects.toThrow(/changed during save/);
  expect(doc.objects.get(key)).toBe(replacement);
});

it.each(['direct', 'worker'] as const)(
  'preserves a live same-valued object replacement during a %s save', async mode => {
    if (mode === 'worker') Object.defineProperty(globalThis, 'Worker', { configurable: true, value: ControlledWorker });
    const source = await PDFDocument.create(); source.addPage([200, 200]);
    const doc = await parsePDF(await source.save({ useObjectStreams: false }));
    const original = new PDFString('same'), replacement = new PDFString('same');
    const key = '900_0', raw = doc.rawBytes;
    doc.objects.set(key, original);
    const pending = (mode === 'worker' ? saveWorker : saveQuick)(doc, undefined, new Map([[key, original]]));
    const outcome = pending.then(() => null, error => error as Error);
    if (mode === 'worker') await vi.waitFor(() => expect(ControlledWorker.instance?.requests).toHaveLength(1));
    doc.objects.set(key, replacement);
    if (mode === 'worker') await ControlledWorker.instance!.reply(0);
    expect((await outcome)?.message).toMatch(/changed during save/);
    expect(doc.objects.get(key)).toBe(replacement);
    expect(doc.rawBytes).toBe(raw);
  },
);

it('does not overwrite a same-valued replacement when a save waits in the queue', async () => {
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: ControlledWorker });
  const source = await PDFDocument.create(); source.addPage([200, 200]);
  const doc = await parsePDF(await source.save({ useObjectStreams: false }));
  const original = new PDFString('same'), replacement = new PDFString('same');
  doc.objects.set('500_0', original);
  const first = saveWorker(doc, undefined, new Map([['900_0', new PDFString('first')]]));
  const second = saveWorker(doc, undefined, new Map([['500_0', original]]));
  const secondResult = second.then(() => null, error => error as Error);
  await vi.waitFor(() => expect(ControlledWorker.instance?.requests).toHaveLength(1));
  doc.objects.set('500_0', replacement);
  await ControlledWorker.instance!.reply(0);
  await first;
  expect((await secondResult)?.message).toMatch(/conflicts/);
  expect(doc.objects.get('500_0')).toBe(replacement);
  expect(ControlledWorker.instance!.requests).toHaveLength(1);
});
