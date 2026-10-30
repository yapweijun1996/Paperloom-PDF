// @vitest-environment happy-dom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getCertificateManager } from '@/engine/browser-core';
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('selects a newly imported identity instead of silently retaining the previous signer', async () => {
  const manager = getCertificateManager();
  for (const entry of manager.list()) manager.remove(entry.id);
  manager.select(null);
  const old = manager.addBundle({ label: 'Previous signer', certificates: [], leaf: null, key: null, chain: [], source: 'pem' });
  const next = { label: 'New signer', certificates: [], leaf: null, key: null, chain: [], source: 'p12' as const };
  vi.spyOn(manager, 'importFile').mockImplementation(async () => manager.addBundle(next));
  expect(manager.getSelected()?.id).toBe(old.id);
  await act(async () => root.render(createElement(CertificateImportDialog, { open: true, onOpenChange: vi.fn() })));
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['synthetic'], 'identity.p12')] });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(manager.getSelected()?.label).toBe('New signer');
  for (const entry of manager.list()) manager.remove(entry.id);
  manager.select(null);
});

it('selects a newly pasted PEM identity', async () => {
  const manager = getCertificateManager();
  for (const entry of manager.list()) manager.remove(entry.id);
  manager.select(null);
  manager.addBundle({ label: 'Previous signer', certificates: [], leaf: null, key: null, chain: [], source: 'pem' });
  vi.spyOn(manager, 'importPem').mockImplementation(async () => manager.addBundle({ label: 'Pasted signer', certificates: [], leaf: null, key: null, chain: [], source: 'pem' }));
  await act(async () => root.render(createElement(CertificateImportDialog, { open: true, onOpenChange: vi.fn() })));
  const textarea = document.querySelector('textarea')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(textarea, 'synthetic PEM'); textarea.dispatchEvent(new Event('input', { bubbles: true })); });
  const button = [...document.querySelectorAll('button')].find(item => item.textContent?.includes('Import PEM'))!;
  await act(async () => { button.click(); });
  expect(manager.getSelected()?.label).toBe('Pasted signer');
  for (const entry of manager.list()) manager.remove(entry.id);
  manager.select(null);
});

it('clears a validation error when the certificate dialog is reopened', async () => {
  const props = { open: true, onOpenChange: vi.fn() };
  await act(async () => root.render(createElement(CertificateImportDialog, props)));
  expect(document.body.textContent).toContain('supports PBES2 AES-CBC');
  expect(document.body.textContent).not.toContain('openssl pkcs12 -nodes');
  const importButton = [...document.querySelectorAll('button')].find(button => button.textContent?.includes('Import PEM'))!;
  await act(async () => importButton.click());
  expect(document.body.textContent).toContain('Paste a PEM certificate and/or private key.');
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Paste a PEM certificate and/or private key.');
  await act(async () => root.render(createElement(CertificateImportDialog, { ...props, open: false })));
  await act(async () => root.render(createElement(CertificateImportDialog, props)));
  expect(document.body.textContent).not.toContain('Paste a PEM certificate and/or private key.');
});

it('moves focus to an adjacent identity after deletion, then to import when none remain', async () => {
  const manager = getCertificateManager();
  for (const entry of manager.list()) manager.remove(entry.id);
  manager.select(null);
  manager.addBundle({ label: 'First signer', certificates: [], leaf: null, key: null, chain: [], source: 'pem' });
  manager.addBundle({ label: 'Second signer', certificates: [], leaf: null, key: null, chain: [], source: 'pem' });
  await act(async () => root.render(createElement(CertificateImportDialog, { open: true, onOpenChange: vi.fn() })));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 70)); });
  const removeSecond = document.querySelector<HTMLButtonElement>('button[aria-label="Remove certificate Second signer"]')!;
  await act(async () => { removeSecond.focus(); removeSecond.click(); });
  expect(document.activeElement?.textContent).toContain('First signer');
  const removeFirst = document.querySelector<HTMLButtonElement>('button[aria-label="Remove certificate First signer"]')!;
  await act(async () => { removeFirst.focus(); removeFirst.click(); });
  expect(document.activeElement?.textContent).toBe('Import PEM');
  manager.select(null);
});

it('exposes identities as selectable keyboard controls and names each removal', async () => {
  const manager = getCertificateManager();
  for (const entry of manager.list()) manager.remove(entry.id);
  manager.select(null);
  manager.addBundle({ label: 'First signer', certificates: [], leaf: null, key: null, chain: [], source: 'pem' });
  manager.addBundle({ label: 'Second signer', certificates: [], leaf: null, key: null, chain: [], source: 'pem' });
  await act(async () => root.render(createElement(CertificateImportDialog, { open: true, onOpenChange: vi.fn() })));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 70)); });
  const controls = [...document.querySelectorAll('button[aria-pressed]')];
  expect(controls).toHaveLength(2);
  const second = controls.find(button => button.textContent?.includes('Second signer')) as HTMLButtonElement;
  expect(second.getAttribute('aria-pressed')).toBe('false');
  await act(async () => second.click());
  expect(manager.getSelected()?.label).toBe('Second signer');
  expect(second.getAttribute('aria-pressed')).toBe('true');
  expect(document.querySelector('button[aria-label="Remove certificate Second signer"]')).not.toBeNull();
  for (const entry of manager.list()) manager.remove(entry.id);
  manager.select(null);
});

it('returns focus to the opener after the dialog closes', async () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return createElement('div', null,
      createElement('button', { id: 'open-certificates', onClick: () => setOpen(true) }, 'Manage certificates'),
      createElement(CertificateImportDialog, { open, onOpenChange: setOpen }));
  }
  await act(async () => root.render(createElement(Harness)));
  const opener = document.querySelector<HTMLButtonElement>('#open-certificates')!;
  await act(async () => { opener.focus(); opener.click(); });
  const done = [...document.querySelectorAll('button')].find(button => button.textContent === 'Done')!;
  await act(async () => done.click());
  // Radix restores focus in a timer after the focus scope unmounts.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(document.activeElement).toBe(opener);
});
