// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FullSecurityReport, PDFDocumentData } from '@/engine/browser-core';
import { SecurityPanel } from './SecurityPanel';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function report(score: number): FullSecurityReport {
  return {
    score, encrypted: false, metadata: { hasInfo: false, hasXmp: false },
    embeddedFiles: { count: 0 }, javascript: { present: false },
    integrity: { ok: true, issueCount: 0 }, redactionMarks: 0, recommendations: [],
  } as unknown as FullSecurityReport;
}

it('ignores an inspection result for a document that has been replaced', async () => {
  let finishFirst!: (value: FullSecurityReport) => void;
  const first = new Promise<FullSecurityReport>(resolve => { finishFirst = resolve; });
  const inspectFull = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(report(88));
  const engine = {
    securityEngine: { inspector: { inspectFull }, policy: { listPolicies: () => [] } },
  } as unknown as typeof import('@/engine/browser-core');
  const doc = {} as PDFDocumentData;
  const props = { doc, engine, onDocChange: vi.fn() };
  await act(async () => root.render(createElement(SecurityPanel, props)));
  await act(async () => root.render(createElement(SecurityPanel, { ...props, doc: {} as PDFDocumentData })));
  expect(container.textContent).toContain('88/100');
  await act(async () => finishFirst(report(12)));
  expect(container.textContent).toContain('88/100');
  expect(container.textContent).not.toContain('12/100');
});
