// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CertificateImportDialog } from './CertificateImportDialog';

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

it('clears a validation error when the certificate dialog is reopened', async () => {
  const props = { open: true, onOpenChange: vi.fn() };
  await act(async () => root.render(createElement(CertificateImportDialog, props)));
  const importButton = [...document.querySelectorAll('button')].find(button => button.textContent?.includes('Import PEM'))!;
  await act(async () => importButton.click());
  expect(document.body.textContent).toContain('Paste a PEM certificate and/or private key.');
  await act(async () => root.render(createElement(CertificateImportDialog, { ...props, open: false })));
  await act(async () => root.render(createElement(CertificateImportDialog, props)));
  expect(document.body.textContent).not.toContain('Paste a PEM certificate and/or private key.');
});
