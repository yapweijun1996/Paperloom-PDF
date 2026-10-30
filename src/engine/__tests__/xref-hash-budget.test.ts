import { PDFDocument } from 'pdf-lib';
import { expect, it, vi } from 'vitest';
import { parsePDF } from '../parser/parser';
import { PDFString } from '../types';
import { saveQuick } from '../writer/save-pipeline';
import { saveQuick as saveWorker, resetPDFWorkerForTests } from '../worker/client';
import { handleWorkerCommand } from '../worker/handler';
import * as provenance from '../parser/xref-provenance';

vi.mock('../parser/xref-provenance', async importOriginal => {
  const actual = await importOriginal<typeof import('../parser/xref-provenance')>();
  return { ...actual, bindXrefProvenance: vi.fn(actual.bindXrefProvenance),
    bindXrefProvenanceAsync: vi.fn(actual.bindXrefProvenanceAsync),
    withAssertedXrefProvenance: vi.fn(actual.withAssertedXrefProvenance),
    bindXrefProvenanceWithRawDigest: vi.fn(actual.bindXrefProvenanceWithRawDigest),
    assertXrefProvenance: vi.fn(actual.assertXrefProvenance) };
});

it.each(['direct', 'worker'] as const)('counts whole-source provenance scans during %s incremental save', async mode => {
  class FakeWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    terminate() {}
    postMessage(command: Parameters<typeof handleWorkerCommand>[0]) {
      void handleWorkerCommand(command).then(response => this.onmessage?.({ data: response } as MessageEvent));
    }
  }
  if (mode === 'worker') Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
  const source = await PDFDocument.create(); source.addPage([100, 100]);
  const doc = await parsePDF(await source.save({ useObjectStreams: false }));
  vi.mocked(provenance.bindXrefProvenance).mockClear();
  vi.mocked(provenance.bindXrefProvenanceAsync).mockClear();
  vi.mocked(provenance.withAssertedXrefProvenance).mockClear();
  vi.mocked(provenance.bindXrefProvenanceWithRawDigest).mockClear();
  vi.mocked(provenance.assertXrefProvenance).mockClear();
  await (mode === 'worker' ? saveWorker : saveQuick)(doc, undefined, new Map([['900_0', new PDFString('new')]]));
  expect(provenance.assertXrefProvenance).not.toHaveBeenCalled();
  expect(provenance.bindXrefProvenance).not.toHaveBeenCalled();
  expect(provenance.withAssertedXrefProvenance).toHaveBeenCalledTimes(3);
  expect(provenance.bindXrefProvenanceAsync).toHaveBeenCalledTimes(1);
  expect(provenance.bindXrefProvenanceWithRawDigest).toHaveBeenCalledTimes(1);
  expect(doc.objects.has('900_0')).toBe(true);
  resetPDFWorkerForTests(); delete (globalThis as { Worker?: unknown }).Worker;
});
