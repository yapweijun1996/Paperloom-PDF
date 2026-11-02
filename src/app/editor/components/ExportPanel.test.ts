// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExportPanel } from './ExportPanel';
import { exportDocument } from '../export-formats';
import type { PDFDocumentData } from '@/engine/browser-core';

vi.mock('../export-formats', async (importOriginal) => ({
  ...await importOriginal<typeof import('../export-formats')>(),
  exportDocument: vi.fn().mockResolvedValue({ blob: new Blob(['export']), filename: 'export.txt' }),
}));

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
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it('rejects invalid custom ranges before export and permits a valid range', async () => {
  vi.stubGlobal('URL', { createObjectURL: vi.fn().mockReturnValue('blob:test'), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const doc = { pages: Array.from({ length: 5 }, () => ({})) } as unknown as PDFDocumentData;
  const props = { isOpen: true, onClose: vi.fn(), doc, engine: {} as typeof import('@/engine/browser-core'), fileName: 'test.pdf', totalPages: 5, currentPage: 0 };
  await act(async () => root.render(createElement(ExportPanel, props)));
  const click = (text: string) => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === text);
    if (!button) throw new Error(`Missing ${text}`);
    button.click();
  };
  const fill = (id: string, value: string) => {
    const input = document.querySelector<HTMLInputElement>(id)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  await act(async () => click('Range'));
  for (const [from, to] of [['4', '2'], ['', '2'], ['0', '2'], ['1', '6'], ['1.5', '2']]) {
    await act(async () => { fill('#export-page-from', from); fill('#export-page-to', to); });
    await act(async () => click('Export as PNG Image'));
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/valid page range/i);
    expect(exportDocument).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  }
  await act(async () => { fill('#export-page-from', '2'); fill('#export-page-to', '4'); });
  await act(async () => click('Export as PNG Image'));
  expect(exportDocument).toHaveBeenCalledWith(doc, props.engine, expect.objectContaining({ pages: [1, 2, 3] }), expect.any(Function));
  expect(URL.createObjectURL).toHaveBeenCalledOnce();
});

it('focuses the named close button and returns focus to the opener', async () => {
  const opener = document.createElement('button');
  document.body.appendChild(opener); opener.focus();
  const props = { isOpen: true, onClose: vi.fn(), doc: null, engine: null, fileName: 'test.pdf', totalPages: 1, currentPage: 0 };
  await act(async () => root.render(createElement(ExportPanel, props)));
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const close = dialog.querySelector<HTMLButtonElement>('button[aria-label="Close export panel"]')!;
  expect(document.activeElement).toBe(close);
  await act(async () => close.click());
  expect(props.onClose).toHaveBeenCalledOnce();
  await act(async () => root.render(createElement(ExportPanel, { ...props, isOpen: false })));
  expect(document.activeElement).toBe(opener);
  opener.remove();
});

it('retains the range choice but resets its upper bound on reopening', () => {
  const props = { isOpen: true, onClose: vi.fn(), doc: null, engine: null, fileName: 'test.pdf', totalPages: 5, currentPage: 0 };
  act(() => root.render(createElement(ExportPanel, props)));
  const range = [...document.querySelectorAll('button')].find(button => button.textContent === 'Range')!;
  act(() => range.click());
  const upper = document.querySelectorAll<HTMLInputElement>('input[type="number"]')[1];
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(upper, '2');
    upper.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(upper.value).toBe('2');
  act(() => root.render(createElement(ExportPanel, { ...props, isOpen: false })));
  act(() => root.render(createElement(ExportPanel, props)));
  expect(document.querySelectorAll<HTMLInputElement>('input[type="number"]')[1].value).toBe('5');
});

it('follows the page theme, marks the selected format and closes on Escape', async () => {
  const props = { isOpen: true, onClose: vi.fn(), doc: null, engine: null, fileName: 'test.pdf', totalPages: 1, currentPage: 0 };
  await act(async () => root.render(createElement(ExportPanel, props)));
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(dialog.closest('[data-theme]')).toBeNull();
  expect(dialog.querySelector('[data-theme]')).toBeNull();
  const svg = [...dialog.querySelectorAll('button')].find(button => button.textContent?.includes('SVG Image'))!;
  expect(svg.getAttribute('aria-pressed')).toBe('false');
  await act(async () => svg.click());
  expect(svg.getAttribute('aria-pressed')).toBe('true');
  await act(async () => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
  expect(props.onClose).toHaveBeenCalledOnce();
});

it('uses a bottom sheet with a named close button on phones', async () => {
  const props = { isOpen: true, onClose: vi.fn(), doc: null, engine: null, fileName: 'test.pdf', totalPages: 1, currentPage: 0, isMobile: true };
  await act(async () => root.render(createElement(ExportPanel, props)));
  expect(document.querySelector('[data-ui="sheet-body"]')).not.toBeNull();
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Close export panel"]')!.click());
  expect(props.onClose).toHaveBeenCalledOnce();
});
