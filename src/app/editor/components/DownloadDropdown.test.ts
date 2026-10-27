// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentData } from '@/engine/browser-core';
import { DownloadDropdown } from './DownloadDropdown';

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

describe('download options', () => {
  it('updates the file estimate when reopened after the document changes', () => {
    const doc = { rawBytes: new Uint8Array(1024), pages: [{}], objects: new Map() } as unknown as PDFDocumentData;
    act(() => root.render(createElement(DownloadDropdown, {
      doc, isSaving: false, saveMode: 'quick', onDownload: vi.fn(), onSaveModeChange: vi.fn(),
    })));
    const toggle = container.querySelector<HTMLButtonElement>('button[title="Download options"]')!;
    act(() => toggle.click());
    expect(container.textContent).toContain('1.0 KB');
    act(() => toggle.click());
    doc.rawBytes = new Uint8Array(2048);
    act(() => toggle.click());
    expect(container.textContent).toContain('2.0 KB');
  });
});
