import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parsePDF, resetPDFWorkerForTests, saveQuick } from '../worker/client';
import { handleWorkerCommand } from '../worker/handler';
import type { WorkerCommand, WorkerResponse } from '../worker/protocol';
import { parsePDF as parseDirect } from '../parser/parser';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminated = false;
  commands: WorkerCommand[] = [];
  constructor() { FakeWorker.instances.push(this); }
  terminate() { this.terminated = true; }
  postMessage(command: WorkerCommand) { this.commands.push(command); }
  async respond() {
    const command = this.commands.shift()!;
    const response = await handleWorkerCommand(command);
    this.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
  }
}

let bytes: Uint8Array;
beforeEach(async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  bytes = await pdf.save({ useObjectStreams: false });
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
});
afterEach(() => {
  resetPDFWorkerForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('worker request failures', () => {
  it('times out, terminates the worker and succeeds on a fresh worker without re-running the request on the main thread', async () => {
    vi.useFakeTimers();
    const started = parsePDF(bytes);
    const rejected = expect(started).rejects.toThrow(/timed out/i);
    const first = FakeWorker.instances[0];
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(first.terminated).toBe(true);
    const secondRequest = parsePDF(bytes);
    const second = FakeWorker.instances[1];
    expect(second).not.toBe(first);
    await second.respond();
    await expect(secondRequest).resolves.toMatchObject({ pages: expect.arrayContaining([expect.anything()]) });
  });

  it('rejects every in-flight request on worker failure and does not replay them on the main thread', async () => {
    const first = parsePDF(bytes);
    const second = parsePDF(bytes);
    const failures = Promise.all([expect(first).rejects.toThrow(/worker failed/i), expect(second).rejects.toThrow(/worker failed/i)]);
    const instance = FakeWorker.instances[0];
    instance.onerror?.({ message: 'worker crashed', preventDefault: () => {} } as ErrorEvent);
    await failures;
    expect(instance.terminated).toBe(true);
    const recovered = parsePDF(bytes);
    await FakeWorker.instances[1].respond();
    await expect(recovered).resolves.toHaveProperty('pages');
  });

  it('does not fall back to direct parsing for a PDF error returned by the worker', async () => {
    const pending = parsePDF(bytes);
    const instance = FakeWorker.instances[0];
    instance.onmessage?.({ data: { type: 'ERROR', requestId: instance.commands[0].requestId, error: { name: 'Error', message: 'fixture failure' } } } as MessageEvent<WorkerResponse>);
    await expect(pending).rejects.toThrow('fixture failure');
    expect(instance.terminated).toBe(false);
  });

  it('rejects invalid responses and starts a new worker for subsequent operations', async () => {
    const pending = parsePDF(bytes);
    const instance = FakeWorker.instances[0];
    instance.onmessage?.({ data: null } as unknown as MessageEvent<WorkerResponse>);
    await expect(pending).rejects.toThrow(/invalid response/i);
    expect(instance.terminated).toBe(true);
    const retry = parsePDF(bytes);
    await FakeWorker.instances[1].respond();
    await expect(retry).resolves.toHaveProperty('pages');
  });

  it('rejects an incomplete result and retires the worker', async () => {
    const pending = parsePDF(bytes);
    const instance = FakeWorker.instances[0];
    instance.onmessage?.({ data: { type: 'RESULT', requestId: instance.commands[0].requestId } } as MessageEvent<WorkerResponse>);
    await expect(pending).rejects.toThrow(/incomplete response/i);
    expect(instance.terminated).toBe(true);
  });

  it('retires a worker whose document graph cannot be hydrated, ignoring stale replies', async () => {
    const pending = parsePDF(bytes);
    const first = FakeWorker.instances[0];
    const oldHandler = first.onmessage!;
    oldHandler({ data: { type: 'RESULT', requestId: first.commands[0].requestId, document: {} } } as MessageEvent<WorkerResponse>);
    await expect(pending).rejects.toThrow(/invalid document/i);
    expect(first.terminated).toBe(true);
    const next = parsePDF(bytes);
    const second = FakeWorker.instances[1];
    oldHandler({ data: null } as unknown as MessageEvent<WorkerResponse>);
    expect(second.terminated).toBe(false);
    await second.respond();
    await expect(next).resolves.toHaveProperty('pages');
  });

  it('reports a worker startup failure without parsing on the main thread', async () => {
    vi.stubGlobal('Worker', class { constructor() { throw new Error('blocked by browser'); } });
    await expect(parsePDF(bytes)).rejects.toThrow(/unable to start/i);
  });

  it('reports a save failure without writing new objects or replacing original bytes', async () => {
    const doc = await parseDirect(bytes);
    const original = doc.rawBytes;
    const saved = saveQuick(doc);
    const instance = FakeWorker.instances[0];
    instance.onmessageerror?.({} as MessageEvent);
    await expect(saved).rejects.toThrow(/unreadable message/i);
    expect(doc.rawBytes).toBe(original);
  });

  it('continues to support environments without Worker', async () => {
    vi.stubGlobal('Worker', undefined);
    await expect(parsePDF(bytes)).resolves.toHaveProperty('pages');
  });
});
