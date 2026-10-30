// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnsavedChangesDialog } from './UnsavedChangesDialog';

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

function button(label: string): HTMLButtonElement {
  const result = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
  if (!result) throw new Error(`Button not found: ${label}`);
  return result;
}

describe('unsaved changes confirmation', () => {
  it('explains the download limit and presents distinct cancel, discard and download choices', async () => {
    const props = { open: true, busy: false, onCancel: vi.fn(), onDiscard: vi.fn(), onSave: vi.fn() };
    await act(async () => root.render(createElement(UnsavedChangesDialog, props)));
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-labelledby')).toBeTruthy();
    expect(dialog?.getAttribute('aria-describedby')).toBeTruthy();
    expect(dialog?.textContent).toContain('the app cannot confirm that it finishes');

    await act(async () => button('Keep editing').click());
    expect(props.onCancel).toHaveBeenCalledOnce();
    expect(props.onDiscard).not.toHaveBeenCalled();
    expect(props.onSave).not.toHaveBeenCalled();
    await act(async () => button('Discard changes').click());
    expect(props.onDiscard).toHaveBeenCalledOnce();
    expect(props.onSave).not.toHaveBeenCalled();
    await act(async () => button('Download and close').click());
    expect(props.onSave).toHaveBeenCalledOnce();
  });

  it('disables all actions and does not dismiss while an operation is in progress', async () => {
    const props = { open: true, busy: true, onCancel: vi.fn(), onDiscard: vi.fn(), onSave: vi.fn() };
    await act(async () => root.render(createElement(UnsavedChangesDialog, props)));
    for (const label of ['Keep editing', 'Discard changes', 'Working…']) {
      expect(button(label).disabled).toBe(true);
      await act(async () => button(label).click());
    }
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(props.onCancel).not.toHaveBeenCalled();
    expect(props.onDiscard).not.toHaveBeenCalled();
    expect(props.onSave).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-busy')).toBe('true');
  });

  it('announces operation failures inside the dialog and clears them when removed', async () => {
    const props = { open: true, busy: false, onCancel: vi.fn(), onDiscard: vi.fn(), onSave: vi.fn() };
    await act(async () => root.render(createElement(UnsavedChangesDialog, props)));
    expect(document.querySelector('[role="dialog"] [role="alert"]')).toBeNull();
    await act(async () => root.render(createElement(UnsavedChangesDialog, { ...props, error: 'Download failed' })));
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe('Download failed');
    await act(async () => root.render(createElement(UnsavedChangesDialog, { ...props, error: null })));
    expect(document.querySelector('[role="dialog"] [role="alert"]')).toBeNull();
  });

  it('treats Escape as keep editing when no operation is in progress', async () => {
    const props = { open: true, busy: false, onCancel: vi.fn(), onDiscard: vi.fn(), onSave: vi.fn() };
    await act(async () => root.render(createElement(UnsavedChangesDialog, props)));
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(props.onCancel).toHaveBeenCalledOnce();
    expect(props.onDiscard).not.toHaveBeenCalled();
    expect(props.onSave).not.toHaveBeenCalled();
  });
});
