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
