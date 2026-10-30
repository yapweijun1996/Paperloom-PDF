import { parsePDF as parseDirect, type ParsePDFOptions } from '../parser/parser';
import { saveQuickUnchecked, saveOptimizedUnchecked, type SaveMode } from '../writer/save-pipeline';
import { getSavedMetadataPatch } from '../writer/save-metadata';
import { coordinateOptimizedSave, coordinateQuickSave } from '../writer/save-coordinator';
import type { PDFDocumentData, PDFObject } from '../types';
import { collectTransferBuffers, extractNewObjects, hydrateDocument } from './codec';
import type { WorkerCommand, WorkerResponse } from './protocol';
type WorkerRequest = WorkerCommand extends infer T ? T extends { requestId: string } ? Omit<T, 'requestId'> : never : never;

// A stalled worker must never cause the same untrusted document to be parsed
// synchronously on the UI thread. A subsequent request can start a fresh worker.
const WORKER_TIMEOUT_MS = 60_000;
class WorkerUnavailableError extends Error {}

type Pending = {
  instance: Worker;
  command: WorkerRequest['type'];
  validate?: (response: WorkerResponse) => void;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: WorkerResponse) => void;
  reject: (error: unknown) => void;
};
let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<string, Pending>();

function retireWorker(instance: Worker, error: Error): void {
  if (worker === instance) worker = null;
  instance.onmessage = null;
  instance.onerror = null;
  instance.onmessageerror = null;
  instance.terminate();
  for (const [id, item] of pending) {
    if (item.instance !== instance) continue;
    clearTimeout(item.timer);
    pending.delete(id);
    item.reject(error);
  }
}

function getWorker(): Worker {
  if (typeof Worker === 'undefined') throw new WorkerUnavailableError('PDF workers are not available in this environment.');
  if (worker) return worker;
  let instance: Worker;
  try {
    instance = new Worker(new URL('./pdf.worker.ts', import.meta.url), { type: 'module' });
  } catch (cause) {
    throw new Error('Unable to start the PDF worker.', { cause });
  }
  worker = instance;
  instance.onmessage = (event: MessageEvent<WorkerResponse>) => {
    if (worker !== instance) return;
    const response = event.data;
    if (!response || typeof response !== 'object' || typeof response.requestId !== 'string' ||
        (response.type !== 'RESULT' && response.type !== 'ERROR') ||
        (response.type === 'ERROR' && (!response.error || typeof response.error.message !== 'string' || typeof response.error.name !== 'string'))) {
      retireWorker(instance, new Error('The PDF worker returned an invalid response.'));
      return;
    }
    const item = pending.get(response.requestId);
    if (!item || item.instance !== instance) return;
    if (response.type === 'RESULT' && (item.command === 'PARSE_PDF'
      ? !response.document || typeof response.document !== 'object'
      : !(response.bytes instanceof Uint8Array))) {
      retireWorker(instance, new Error('The PDF worker returned an incomplete response.'));
      return;
    }
    if (response.type === 'RESULT' && item.validate) {
      try { item.validate(response); } catch (cause) {
        retireWorker(instance, new Error('The PDF worker returned an invalid document.', { cause }));
        return;
      }
    }
    clearTimeout(item.timer);
    pending.delete(response.requestId);
    if (response.type === 'ERROR') item.reject(Object.assign(new Error(response.error.message), { name: response.error.name, stack: response.error.stack }));
    else item.resolve(response);
  };
  instance.onerror = (event) => {
    event.preventDefault?.();
    if (worker === instance) retireWorker(instance, new Error(`PDF worker failed: ${event.message || 'unknown error'}`));
  };
  instance.onmessageerror = () => {
    if (worker === instance) retireWorker(instance, new Error('The PDF worker returned an unreadable message.'));
  };
  return instance;
}

async function request(command: WorkerRequest, transfer: Transferable[], validate?: (response: WorkerResponse) => void): Promise<WorkerResponse> {
  const instance = getWorker();
  const requestId = `pdf-${++nextId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.has(requestId)) retireWorker(instance, new Error('PDF worker timed out; try again with a different document.'));
    }, WORKER_TIMEOUT_MS);
    pending.set(requestId, { instance, command: command.type, validate, timer, resolve, reject });
    try { instance.postMessage({ ...command, requestId }, transfer); }
    catch (cause) {
      retireWorker(instance, new Error('Failed to send the request to the PDF worker.', { cause }));
    }
  });
}

export async function parsePDF(data: Uint8Array, options?: ParsePDFOptions): Promise<PDFDocumentData> {
  const input = data.slice();
  try {
    let hydrated: PDFDocumentData | undefined;
    await request({ type: 'PARSE_PDF', bytes: input, options }, [input.buffer as ArrayBuffer], result => {
      if (result.type !== 'RESULT' || !result.document) throw new Error('Invalid PDF worker parse response');
      hydrated = hydrateDocument(result.document, data);
    });
    if (!hydrated) throw new Error('Invalid PDF worker parse response');
    return hydrated;
  }
  catch (error) { if (error instanceof WorkerUnavailableError) return parseDirect(data, options); throw error; }
}

export function saveQuick(doc: PDFDocumentData, modifiedKeys?: Set<string>, newObjects?: Map<string, PDFObject>): Promise<Uint8Array> {
  return coordinateQuickSave(doc, modifiedKeys, newObjects, async command => {
    const wire = command.document;
    try {
      const result = await request({ type: 'SAVE_PDF', document: wire,
        modifiedKeys: command.modifiedKeys ? Array.from(command.modifiedKeys) : undefined,
        newObjectKeys: command.newObjectKeys }, collectTransferBuffers(wire));
      if (result.type !== 'RESULT' || !result.bytes) throw new Error('Invalid PDF worker save response');
      return { bytes: result.bytes, rawBytesAdvanced: result.rawBytesAdvanced === true, metadata: result.metadata };
    } catch (error) {
      if (!(error instanceof WorkerUnavailableError)) throw error;
      const staged = hydrateDocument(wire);
      const before = staged.rawBytes;
      const added = command.newObjectKeys ? extractNewObjects(staged, command.newObjectKeys) : undefined;
      const bytes = await saveQuickUnchecked(staged, command.modifiedKeys, added);
      return { bytes, rawBytesAdvanced: staged.rawBytes === bytes && staged.rawBytes !== before, metadata: getSavedMetadataPatch(staged) };
    }
  });
}

export function saveOptimized(doc: PDFDocumentData): Promise<Uint8Array> {
  return coordinateOptimizedSave(doc, async wire => {
    try {
      const result = await request({ type: 'OPTIMIZE_PDF', document: wire }, collectTransferBuffers(wire));
      if (result.type !== 'RESULT' || !result.bytes) throw new Error('Invalid PDF worker optimize response');
      return result.bytes;
    } catch (error) {
      if (!(error instanceof WorkerUnavailableError)) throw error;
      return saveOptimizedUnchecked(hydrateDocument(wire));
    }
  });
}

export async function saveDocument(doc: PDFDocumentData, mode: SaveMode = 'optimized'): Promise<Uint8Array> { return mode === 'quick' ? saveQuick(doc) : saveOptimized(doc); }

export function resetPDFWorkerForTests(): void {
  if (worker) retireWorker(worker, new Error('PDF worker was reset.'));
}
