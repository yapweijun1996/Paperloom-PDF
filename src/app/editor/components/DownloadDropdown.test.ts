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

  it('portals the mobile sheet to the body and keeps it open while choosing options', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width'), media: query,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    const doc = { rawBytes: new Uint8Array(1024), pages: [{}], objects: new Map() } as unknown as PDFDocumentData;
    await act(async () => root.render(createElement(DownloadDropdown, {
      doc, isSaving: false, saveMode: 'quick', onDownload: vi.fn(), onSaveModeChange: vi.fn(),
    })));
    const toggle = container.querySelector<HTMLButtonElement>('button[title="Download options"]')!;
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const sheet = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Download options"]')!;
    expect(sheet.parentElement).toBe(document.body);
    expect(container.contains(sheet)).toBe(false);
    expect(sheet.className).toContain('max-h-[80dvh]');
    const option = [...sheet.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Medium'))!;
    act(() => { option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); option.click(); });
    expect(option.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[role="dialog"][aria-label="Download options"]')).not.toBeNull();
    const backdrop = document.querySelector<HTMLElement>('.mobile-backdrop')!;
    act(() => { backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); backdrop.click(); });
    expect(document.querySelector('[role="dialog"][aria-label="Download options"]')).toBeNull();
  });
});
