import { describe, expect, it } from 'vitest';
import { buildDiagnosticReport } from './diagnostic-report';
import type { PDFDocumentData } from '@/engine/browser-core';

const doc = {
  version: '1.7',
  pages: [{ mediaBox: { x: 0, y: 0, width: 595.92, height: 842.88 }, rotate: 90 }],
  rawBytes: new Uint8Array(1234),
  objects: new Map([['1_0', {}]]),
  info: { title: 'Secret plan', author: 'Someone', producer: 'Skia/PDF m120', creator: 'Chrome' },
} as unknown as PDFDocumentData;

describe('diagnostic report', () => {
  it('describes the error, browser and PDF structure', () => {
    const report = buildDiagnosticReport({
      error: 'Delete failed: ambiguous', doc, pageIndex: 0, userAgent: 'TestAgent/1', now: new Date('2026-11-03T00:00:00Z'),
    });
    expect(report).toContain('Error: Delete failed: ambiguous');
    expect(report).toContain('Browser: TestAgent/1');
    expect(report).toContain('PDF version: 1.7');
    expect(report).toContain('Pages: 1');
    expect(report).toContain('Producer: Skia/PDF m120');
    expect(report).toContain('Current page: 1, 596 x 843 pt, rotate 90');
  });

  it('leaves out the title and author', () => {
    const report = buildDiagnosticReport({ doc, userAgent: 'x', now: new Date(0) });
    expect(report).not.toContain('Secret plan');
    expect(report).not.toContain('Someone');
  });

  it('works before a document is open', () => {
    const report = buildDiagnosticReport({ error: 'Invalid PDF', userAgent: 'x', now: new Date(0) });
    expect(report).toContain('Error: Invalid PDF');
    expect(report).not.toContain('Pages:');
  });
});
