// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  loadPdf: vi.fn(),
  loadSession: vi.fn(),
  savePdf: vi.fn(),
  clearPdf: vi.fn(),
  inspectOrphan: vi.fn(),
  clearOrphan: vi.fn(),
  restoreOrphan: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('next/image', async () => {
  const React = await import('react');
  return { default: ({ alt, src }: { alt: string; src: string }) => React.createElement('img', { alt, src }) };
});
vi.mock('@/lib/pdfStorage', () => ({
  loadPdfFromStorage: mocks.loadPdf,
  loadEditorSession: mocks.loadSession,
  savePdfToStorage: mocks.savePdf,
  clearPdfFromStorage: mocks.clearPdf,
  inspectOrphanRecovery: mocks.inspectOrphan,
  clearOrphanRecovery: mocks.clearOrphan,
  restoreOrphanRecovery: mocks.restoreOrphan,
}));

import Home from '../page';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  mocks.loadPdf.mockResolvedValue({ fileName: 'saved.pdf', bytes: new ArrayBuffer(1) });
  mocks.loadSession.mockResolvedValue({ fileName: 'recovery.pdf' });
  mocks.savePdf.mockResolvedValue(undefined);
  mocks.clearPdf.mockResolvedValue(undefined);
  mocks.inspectOrphan.mockResolvedValue(null);
  mocks.clearOrphan.mockResolvedValue(undefined);
  mocks.restoreOrphan.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function getButton(label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
}

describe('saved document on the home page', () => {
  it('shows the recovery and resumes it without clearing storage', async () => {
    await act(async () => root.render(createElement(Home)));
    expect(container.textContent).toContain('recovery.pdf');
    expect(container.textContent).toContain('Recovery changes are available');
    expect(mocks.loadPdf).toHaveBeenCalledOnce();
    expect(mocks.loadSession).toHaveBeenCalledOnce();
    await act(async () => getButton('Resume saved document').click());
    expect(mocks.push).toHaveBeenCalledWith('/editor');
    expect(mocks.clearPdf).not.toHaveBeenCalled();
  });

  it('preserves the saved document when discard is cancelled and clears it only after confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await act(async () => root.render(createElement(Home)));
    await act(async () => getButton('Discard saved document').click());
    expect(mocks.clearPdf).not.toHaveBeenCalled();
    expect(container.textContent).toContain('recovery.pdf');
    await act(async () => getButton('Discard saved document').click());
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(mocks.clearPdf).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain('recovery.pdf');
    confirm.mockRestore();
  });

  it('reports discard failures and leaves the resume action available', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mocks.clearPdf.mockRejectedValue(new Error('storage changed'));
    await act(async () => root.render(createElement(Home)));
    await act(async () => getButton('Discard saved document').click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('storage changed');
    expect(getButton('Resume saved document').disabled).toBe(false);
    confirm.mockRestore();
  });

  it('reports storage read failures and does not offer a destructive action', async () => {
    mocks.loadPdf.mockRejectedValue(new Error('storage unavailable'));
    await act(async () => root.render(createElement(Home)));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('storage unavailable');
    expect(container.querySelector('section')).toBeNull();
    expect(mocks.clearPdf).not.toHaveBeenCalled();
  });

  it('allows a new upload normally when no recovery exists', async () => {
    mocks.loadPdf.mockResolvedValue(null);
    await act(async () => root.render(createElement(Home)));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(['%PDF-1.7'], 'new.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(mocks.savePdf).toHaveBeenCalledOnce();
    expect(mocks.push).toHaveBeenCalledWith('/editor');
  });

  it.each(['Enter', ' '])('opens the PDF chooser using %s', async key => {
    mocks.loadPdf.mockResolvedValue(null);
    await act(async () => root.render(createElement(Home)));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const click = vi.spyOn(input, 'click').mockImplementation(() => {});
    const dropZone = container.querySelector<HTMLElement>('[role="button"][aria-label="Open a PDF file"]')!;
    expect(dropZone.tabIndex).toBe(0);
    await act(async () => dropZone.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
    expect(click).toHaveBeenCalledOnce();
    click.mockRestore();
  });

  it('exposes an orphaned recovery and prevents upload until it is explicitly discarded', async () => {
    const orphan = { fileName: 'orphan.pdf', bytes: new ArrayBuffer(1), updatedAt: 1, overlays: {} };
    mocks.loadPdf.mockResolvedValue(null);
    mocks.inspectOrphan.mockResolvedValue(orphan);
    await act(async () => root.render(createElement(Home)));
    expect(container.textContent).toContain('orphan.pdf');
    expect(container.textContent).toContain('original document record is missing');
    expect(container.textContent).not.toContain('Resume saved document');
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['%PDF-1.7'], 'new.pdf', { type: 'application/pdf' })] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(mocks.savePdf).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Resolve it');
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('restores an orphan record before navigating to the editor', async () => {
    const orphan = { fileName: 'orphan.pdf', bytes: new ArrayBuffer(1), updatedAt: 1, overlays: {} };
    mocks.loadPdf.mockResolvedValue(null);
    mocks.inspectOrphan.mockResolvedValue(orphan);
    await act(async () => root.render(createElement(Home)));
    await act(async () => getButton('Resume recovery').click());
    expect(mocks.restoreOrphan).toHaveBeenCalledExactlyOnceWith(orphan);
    expect(mocks.push).toHaveBeenCalledWith('/editor');
    expect(mocks.clearOrphan).not.toHaveBeenCalled();
  });

  it('preserves an orphan and stays home when restore fails', async () => {
    const orphan = { fileName: 'orphan.pdf', bytes: new ArrayBuffer(1), updatedAt: 1, overlays: {} };
    mocks.loadPdf.mockResolvedValue(null);
    mocks.inspectOrphan.mockResolvedValue(orphan);
    mocks.restoreOrphan.mockRejectedValue(new Error('storage changed'));
    await act(async () => root.render(createElement(Home)));
    await act(async () => getButton('Resume recovery').click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('storage changed');
    expect(getButton('Resume recovery').disabled).toBe(false);
    expect(container.textContent).toContain('orphan.pdf');
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.clearOrphan).not.toHaveBeenCalled();
  });

  it('retains an orphan on cancellation and deletes only the inspected record after confirmation', async () => {
    const orphan = { fileName: 'orphan.pdf', bytes: new ArrayBuffer(1), updatedAt: 1, overlays: {} };
    mocks.loadPdf.mockResolvedValue(null);
    mocks.inspectOrphan.mockResolvedValue(orphan);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await act(async () => root.render(createElement(Home)));
    await act(async () => getButton('Discard orphaned recovery').click());
    expect(mocks.clearOrphan).not.toHaveBeenCalled();
    expect(container.textContent).toContain('orphan.pdf');
    await act(async () => getButton('Discard orphaned recovery').click());
    expect(mocks.clearOrphan).toHaveBeenCalledExactlyOnceWith(orphan);
    expect(mocks.clearPdf).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('orphan.pdf');
    confirm.mockRestore();
  });

  it('leaves the orphan visible when deletion fails or storage changed', async () => {
    const orphan = { fileName: 'orphan.pdf', bytes: new ArrayBuffer(1), updatedAt: 1, overlays: {} };
    mocks.loadPdf.mockResolvedValue(null);
    mocks.inspectOrphan.mockResolvedValue(orphan);
    mocks.clearOrphan.mockRejectedValue(new Error('storage changed'));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await act(async () => root.render(createElement(Home)));
    await act(async () => getButton('Discard orphaned recovery').click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('storage changed');
    expect(getButton('Discard orphaned recovery').disabled).toBe(false);
    expect(container.textContent).toContain('orphan.pdf');
    confirm.mockRestore();
  });

  it('refreshes an orphan discovered when a concurrent upload is refused', async () => {
    const orphan = { fileName: 'orphan.pdf', bytes: new ArrayBuffer(1), updatedAt: 1, overlays: {} };
    mocks.loadPdf.mockResolvedValue(null);
    mocks.inspectOrphan.mockResolvedValueOnce(null).mockResolvedValueOnce(orphan);
    mocks.savePdf.mockRejectedValue(Object.assign(new Error('recovery exists'), { name: 'RecoveryExistsError' }));
    await act(async () => root.render(createElement(Home)));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['%PDF-1.7'], 'new.pdf', { type: 'application/pdf' })] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(container.textContent).toContain('orphan.pdf');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Resolve it');
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('reports an existing saved document or recovery without navigating away', async () => {
    const failure = Object.assign(new Error('recovery exists'), { name: 'RecoveryExistsError' });
    mocks.savePdf.mockRejectedValue(failure);
    await act(async () => root.render(createElement(Home)));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(['%PDF-1.7'], 'new.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('saved local document or recovery');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Resume and download');
    expect(getButton('Resume saved document')).not.toBeNull();
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
