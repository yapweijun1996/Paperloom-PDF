import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePDF as parseDirect } from '../parser/parser';
import { PDFDict, PDFRef, PDFString } from '../types';
import { saveDocument, saveOptimized, saveQuick, resetPDFWorkerForTests } from '../worker/client';
import { handleWorkerCommand } from '../worker/handler';
import { saveQuick as directSaveQuick, saveOptimized as directSaveOptimized, saveDocument as directSaveDocument } from '../index';
import type { WorkerCommand, WorkerResponse } from '../worker/protocol';

class ControlledWorker {
  static instances: ControlledWorker[] = [];
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  requests: WorkerCommand[] = [];
  terminated = false;
  constructor() { ControlledWorker.instances.push(this); }
  terminate() { this.terminated = true; }
  postMessage(command: WorkerCommand) { this.requests.push(command); }
  async reply(index: number) {
    const response = await handleWorkerCommand(this.requests[index]);
    this.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
  }
  fail(index: number) {
    this.onmessage?.({ data: { type: 'ERROR', requestId: this.requests[index].requestId,
      error: { name: 'Error', message: 'Simulated failure' } } } as MessageEvent<WorkerResponse>);
  }
}

async function fixture() {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  return parseDirect(await pdf.save({ useObjectStreams: false }));
}

async function waitForRequests(worker: ControlledWorker, count: number) {
  await vi.waitFor(() => expect(worker.requests).toHaveLength(count));
}

async function waitForWorker(index = 0): Promise<ControlledWorker> {
  await vi.waitFor(() => expect(ControlledWorker.instances[index]?.requests.length).toBeGreaterThan(0));
  return ControlledWorker.instances[index];
}

afterEach(() => {
  resetPDFWorkerForTests();
  delete (globalThis as { Worker?: unknown }).Worker;
  ControlledWorker.instances.length = 0;
});

describe('worker saves and concurrent document edits', () => {
  it('queues quick saves for one document so both incremental revisions survive', async () => {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: ControlledWorker });
    const doc = await fixture();
    doc.catalog.set('Marker', new PDFRef(900, 0));
    const rootKey = doc.xref.trailerDict.getRef('Root')!.toKey();
    const first = saveQuick(doc, new Set([rootKey]), new Map([['900_0', new PDFString('first')]]));
    const second = saveDocument(doc, 'quick');
    const worker = await waitForWorker();
    expect(worker.requests).toHaveLength(1);
    await worker.reply(0);
    await first;
    await waitForRequests(worker, 2);
    await worker.reply(1);
    const bytes = await second;
    const reopened = await parseDirect(bytes);
    expect(reopened.objects.get('900_0')).toBeInstanceOf(PDFString);
    expect(doc.objects.has('900_0')).toBe(true);
    expect((await parseDirect(doc.rawBytes)).objects.has('900_0')).toBe(true);
  });

  it('keeps both distinct new objects when two quick saves overlap', async () => {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: ControlledWorker });
    const doc = await fixture();
    const first = saveQuick(doc, new Set(), new Map([['900_0', new PDFString('first')]]));
    const second = saveQuick(doc, new Set(), new Map([['901_0', new PDFString('second')]]));
    const worker = await waitForWorker();
    expect(worker.requests).toHaveLength(1);
    await worker.reply(0);
    await first;
    await waitForRequests(worker, 2);
    await worker.reply(1);
    await second;
    const reopened = await parseDirect(doc.rawBytes);
    expect(reopened.objects.has('900_0')).toBe(true);
    expect(reopened.objects.has('901_0')).toBe(true);
    expect(doc.objects.has('900_0')).toBe(true);
    expect(doc.objects.has('901_0')).toBe(true);
  });

  it('rejects a stale quick save when the live document changes', async () => {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: ControlledWorker });
    const doc = await fixture();
    const original = doc.rawBytes;
    const saved = saveQuick(doc, new Set(), new Map([['900_0', new PDFString('new')]]));
    const worker = await waitForWorker();
    doc.catalog.set('ConcurrentEdit', new PDFString('keep me'));
    await worker.reply(0);
    await expect(saved).rejects.toThrow(/document changed during save/i);
    expect(doc.rawBytes).toBe(original);
    expect(doc.objects.has('900_0')).toBe(false);
    expect(doc.catalog.getString('ConcurrentEdit')).toBe('keep me');
  });

  it('rejects a stale quick save when a pending new object changes', async () => {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: ControlledWorker });
    const doc = await fixture();
    const original = doc.rawBytes;
    const added = new PDFDict([['Value', new PDFString('old')]]);
    const saved = saveQuick(doc, new Set(), new Map([['900_0', added]]));
    const worker = await waitForWorker();
    added.set('Value', new PDFString('new'));
    await worker.reply(0);
    await expect(saved).rejects.toThrow(/document changed during save/i);
    expect(doc.rawBytes).toBe(original);
    expect(doc.objects.has('900_0')).toBe(false);
    expect(added.getString('Value')).toBe('new');
  });

  it('rejects optimized output if a concurrent quick save advances the document', async () => {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: ControlledWorker });
    const doc = await fixture();
    const optimized = saveOptimized(doc);
    const quick = saveQuick(doc, new Set(), new Map([['900_0', new PDFString('new')]]));
    const worker = await waitForWorker();
    await waitForRequests(worker, 2);
    await worker.reply(1);
    await quick;
    await worker.reply(0);
    await expect(optimized).rejects.toThrow(/document changed during save/i);
    expect((await parseDirect(doc.rawBytes)).objects.has('900_0')).toBe(true);
  });

  it('starts a fresh worker for a queued save after the previous worker crashes', async () => {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: ControlledWorker });
    const doc = await fixture();
    const first = saveQuick(doc, new Set(), new Map([['900_0', new PDFString('failed')]]));
    const second = saveQuick(doc, new Set(), new Map([['901_0', new PDFString('saved')]]));
    const failedWorker = await waitForWorker();
    failedWorker.onerror?.({ message: 'crash', preventDefault() {} } as ErrorEvent);
    await expect(first).rejects.toThrow(/worker failed/i);
    const replacementWorker = await waitForWorker(1);
    expect(failedWorker.terminated).toBe(true);
    expect(ControlledWorker.instances).toHaveLength(2);
    await replacementWorker.reply(0);
    await second;
    const reopened = await parseDirect(doc.rawBytes);
    expect(reopened.objects.has('900_0')).toBe(false);
    expect(reopened.objects.has('901_0')).toBe(true);
  });

  it('allows saves of different documents to run concurrently', async () => {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: ControlledWorker });
    const firstDoc = await fixture(), secondDoc = await fixture();
    const first = saveQuick(firstDoc, new Set(), new Map([['900_0', new PDFString('first')]]));
    const second = saveQuick(secondDoc, new Set(), new Map([['901_0', new PDFString('second')]]));
    const worker = await waitForWorker();
    await waitForRequests(worker, 2);
    await worker.reply(1); await second;
    await worker.reply(0); await first;
    expect((await parseDirect(firstDoc.rawBytes)).objects.has('900_0')).toBe(true);
    expect((await parseDirect(secondDoc.rawBytes)).objects.has('901_0')).toBe(true);
  });

  it('continues the queue after a failed quick save', async () => {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: ControlledWorker });
    const doc = await fixture();
    const first = saveQuick(doc, new Set(), new Map([['900_0', new PDFString('failed')]]));
    const second = saveQuick(doc, new Set(), new Map([['901_0', new PDFString('saved')]]));
    const worker = await waitForWorker();
    worker.fail(0);
    await expect(first).rejects.toThrow(/simulated failure/i);
    await waitForRequests(worker, 2);
    await worker.reply(1);
    await second;
    const reopened = await parseDirect(doc.rawBytes);
    expect(reopened.objects.has('900_0')).toBe(false);
    expect(reopened.objects.has('901_0')).toBe(true);
  });

  it('serializes a root-engine quick save behind an in-flight browser quick save', async () => {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: ControlledWorker });
    const doc = await fixture();
    const browser = saveQuick(doc, new Set(), new Map([['900_0', new PDFString('browser')]]));
    const direct = directSaveQuick(doc, new Set(), new Map([['901_0', new PDFString('direct')]]));
    const worker = await waitForWorker();
    await worker.reply(0);
    await browser;
    await direct;
    const reopened = await parseDirect(doc.rawBytes);
    expect(reopened.objects.has('900_0')).toBe(true);
    expect(reopened.objects.has('901_0')).toBe(true);
  });

  it('serializes a browser quick save behind an in-flight root-engine quick save', async () => {
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: ControlledWorker });
    const doc = await fixture();
    const direct = directSaveQuick(doc, new Set(), new Map([['900_0', new PDFString('direct')]]));
    const browser = saveQuick(doc, new Set(), new Map([['901_0', new PDFString('browser')]]));
    expect(ControlledWorker.instances).toHaveLength(0);
    await direct;
    const worker = await waitForWorker();
    expect(worker).toBeDefined();
    await worker.reply(0);
    await browser;
    const reopened = await parseDirect(doc.rawBytes);
    expect(reopened.objects.has('900_0')).toBe(true);
    expect(reopened.objects.has('901_0')).toBe(true);
  });

  it.each(['quick', 'optimized'] as const)('rejects stale root-engine %s save output', async mode => {
    const doc = await fixture();
    const original = doc.rawBytes;
    const operation = mode === 'quick' ? directSaveDocument(doc, 'quick') : directSaveOptimized(doc);
    doc.catalog.set('ConcurrentEdit', new PDFString('preserve me'));
    await expect(operation).rejects.toThrow(/document changed during save/i);
    expect(doc.catalog.getString('ConcurrentEdit')).toBe('preserve me');
    expect(doc.rawBytes).toBe(original);
  });

  it('uses the same queue in environments without Worker', async () => {
    delete (globalThis as { Worker?: unknown }).Worker;
    const doc = await fixture();
    const first = saveQuick(doc, new Set(), new Map([['900_0', new PDFString('first')]]));
    const second = saveQuick(doc, new Set(), new Map([['901_0', new PDFString('second')]]));
    await Promise.all([first, second]);
    const reopened = await parseDirect(doc.rawBytes);
    expect(reopened.objects.has('900_0')).toBe(true);
    expect(reopened.objects.has('901_0')).toBe(true);
  });
});
