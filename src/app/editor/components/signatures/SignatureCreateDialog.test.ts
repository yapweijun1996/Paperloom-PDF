// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SignatureCreateDialog } from './SignatureCreateDialog';

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

it('clears a validation error when the signature dialog is reopened', async () => {
  const props = { open: true, onOpenChange: vi.fn(), onSave: vi.fn() };
  await act(async () => root.render(createElement(SignatureCreateDialog, props)));
  const save = [...document.querySelectorAll('button')].find(button => button.textContent?.includes('Save to library'))!;
  await act(async () => save.click());
  expect(document.body.textContent).toContain('Draw a signature first');
  await act(async () => root.render(createElement(SignatureCreateDialog, { ...props, open: false })));
  await act(async () => root.render(createElement(SignatureCreateDialog, props)));
  expect(document.body.textContent).not.toContain('Draw a signature first');
});

it('follows the page theme and keeps the tab, placeholder and action names', async () => {
  await act(async () => root.render(createElement(SignatureCreateDialog, { open: true, onOpenChange: vi.fn(), onSave: vi.fn() })));
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(dialog.closest('[data-theme]')).toBeNull();
  expect(dialog.hasAttribute('data-theme')).toBe(false);
  expect(dialog.querySelector('button[aria-label="Close signature dialog"]')).not.toBeNull();
  const type = [...dialog.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Type')!;
  await act(async () => type.click());
  expect(type.getAttribute('aria-pressed')).toBe('true');
  expect(dialog.querySelector('input[placeholder="Type your name"]')).not.toBeNull();
  expect([...dialog.querySelectorAll('button')].some(button => button.textContent?.includes('Save to library'))).toBe(true);
});
