// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExportPanel } from './ExportPanel';

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

it('retains the range choice but resets its upper bound on reopening', () => {
  const props = { isOpen: true, onClose: vi.fn(), doc: null, engine: null, fileName: 'test.pdf', totalPages: 5, currentPage: 0 };
  act(() => root.render(createElement(ExportPanel, props)));
  const range = [...container.querySelectorAll('button')].find(button => button.textContent === 'Range')!;
  act(() => range.click());
  const upper = container.querySelectorAll<HTMLInputElement>('input[type="number"]')[1];
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(upper, '2');
    upper.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(upper.value).toBe('2');
  act(() => root.render(createElement(ExportPanel, { ...props, isOpen: false })));
  act(() => root.render(createElement(ExportPanel, props)));
  expect(container.querySelectorAll<HTMLInputElement>('input[type="number"]')[1].value).toBe('5');
});
