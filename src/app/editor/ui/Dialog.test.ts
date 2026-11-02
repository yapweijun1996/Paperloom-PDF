// @vitest-environment happy-dom
import { act, createElement, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Z_LAYERS } from '../zLayers';
import { ConfirmDialog, Dialog, DialogFooter } from './Dialog';
import { Button } from './Button';
import { buttonByText, clickOutside, press, mountHarness } from './__tests__/harness';

const harness = mountHarness();

function dialog(): HTMLElement | null {
  return document.querySelector('[role="dialog"]');
}

function basic(props: Partial<Parameters<typeof Dialog>[0]> = {}) {
  return createElement(Dialog, {
    open: true,
    onOpenChange: vi.fn(),
    title: 'Rename field',
    description: 'Choose a new name.',
    ...props,
  }, createElement(DialogFooter, null, createElement(Button, null, 'First'), createElement(Button, null, 'Last')));
}

describe('Dialog', () => {
  it('names and describes the dialog and passes title, aria and data attributes through', async () => {
    await harness.render(basic({ 'data-testid': 'rename', 'aria-busy': true, title: 'Rename field' } as never));
    const node = dialog()!;
    expect(node).not.toBeNull();
    expect(document.getElementById(node.getAttribute('aria-labelledby')!)?.textContent).toBe('Rename field');
    expect(document.getElementById(node.getAttribute('aria-describedby')!)?.textContent).toBe('Choose a new name.');
    expect(node.getAttribute('data-testid')).toBe('rename');
    expect(node.getAttribute('aria-busy')).toBe('true');
  });

  it('layers the scrim overlay and the content on the modal tiers', async () => {
    await harness.render(basic());
    const overlay = document.querySelector<HTMLElement>('[data-ui="dialog-overlay"]')!;
    expect(overlay.style.zIndex).toBe(String(Z_LAYERS.modalBackdrop));
    expect(overlay.className).toContain('bg-scrim');
    expect(dialog()!.style.zIndex).toBe(String(Z_LAYERS.modal));
  });

  it('mounts content only while open', async () => {
    await harness.render(basic({ open: false }));
    expect(dialog()).toBeNull();
    await harness.render(basic({ open: true }));
    expect(dialog()).not.toBeNull();
  });

  it('closes on Escape and outside click when dismissible', async () => {
    const onOpenChange = vi.fn();
    await harness.render(basic({ onOpenChange }));
    expect(dialog()!.getAttribute('aria-modal')).toBe('true');
    await press('Escape');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    onOpenChange.mockClear();
    await clickOutside('[data-ui="dialog-overlay"]');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('ignores Escape and outside clicks when not dismissible', async () => {
    const onOpenChange = vi.fn();
    await harness.render(basic({ onOpenChange, dismissible: false }));
    await press('Escape');
    await clickOutside('[data-ui="dialog-overlay"]');
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
  });

  it('moves focus inside, traps Tab at the edges and returns focus to the opener on close', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return createElement('div', null,
        createElement('button', { type: 'button', onClick: () => setOpen(true) }, 'Open'),
        createElement(Dialog, { open, onOpenChange: setOpen, title: 'T', description: 'D' },
          createElement(DialogFooter, null,
            createElement(Button, null, 'First'),
            createElement(Button, { onClick: () => setOpen(false) }, 'Last'))));
    }
    await harness.render(createElement(Harness));
    const opener = buttonByText('Open');
    opener.focus();
    await act(async () => opener.click());
    expect(dialog()!.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.textContent).toBe('First');

    buttonByText('Last').focus();
    await press('Tab');
    expect(document.activeElement?.textContent).toBe('First');

    await act(async () => buttonByText('Last').click());
    expect(dialog()).toBeNull();
    // Radix restores focus on the next task after unmount.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(document.activeElement).toBe(opener);
  });
});

describe('ConfirmDialog', () => {
  const base = { open: true, title: 'Delete page?', message: 'This cannot be undone.', onConfirm: vi.fn(), onCancel: vi.fn() };

  it('wires title and message, labels both actions and reports the chosen one', async () => {
    const props = { ...base, onConfirm: vi.fn(), onCancel: vi.fn(), confirmLabel: 'Delete', cancelLabel: 'Keep' };
    await harness.render(createElement(ConfirmDialog, props));
    const node = dialog()!;
    expect(document.getElementById(node.getAttribute('aria-labelledby')!)?.textContent).toBe('Delete page?');
    expect(document.getElementById(node.getAttribute('aria-describedby')!)?.textContent).toBe('This cannot be undone.');
    expect(document.activeElement).toBe(buttonByText('Keep'));
    await act(async () => buttonByText('Delete').click());
    expect(props.onConfirm).toHaveBeenCalledOnce();
    await act(async () => buttonByText('Keep').click());
    expect(props.onCancel).toHaveBeenCalledOnce();
  });

  it('uses the danger variant for destructive confirmations and primary otherwise', async () => {
    await harness.render(createElement(ConfirmDialog, { ...base, tone: 'danger' }));
    expect(buttonByText('Confirm').dataset.variant).toBe('danger');
    expect(dialog()!.dataset.tone).toBe('danger');
    await harness.render(createElement(ConfirmDialog, { ...base, tone: 'default' }));
    expect(buttonByText('Confirm').dataset.variant).toBe('primary');
  });

  it('treats Escape as cancel', async () => {
    const onCancel = vi.fn();
    await harness.render(createElement(ConfirmDialog, { ...base, onCancel }));
    await press('Escape');
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('disables both actions and blocks dismissal while busy', async () => {
    const props = { ...base, onConfirm: vi.fn(), onCancel: vi.fn(), busy: true };
    await harness.render(createElement(ConfirmDialog, props));
    expect(dialog()!.getAttribute('aria-busy')).toBe('true');
    expect(buttonByText('Cancel').disabled).toBe(true);
    expect(buttonByText('Confirm').disabled).toBe(true);
    expect(buttonByText('Confirm').getAttribute('aria-busy')).toBe('true');
    await press('Escape');
    expect(props.onCancel).not.toHaveBeenCalled();
  });
});
