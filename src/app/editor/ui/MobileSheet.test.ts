// @vitest-environment happy-dom
import { act, createElement, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Z_LAYERS } from '../zLayers';
import { MobileSheet } from './MobileSheet';
import { buttonByText, clickOutside, press, mountHarness } from './__tests__/harness';

const harness = mountHarness();

function sheet(): HTMLElement | null {
  return document.querySelector('[role="dialog"]');
}

function render(props: Partial<Parameters<typeof MobileSheet>[0]> = {}) {
  return harness.render(createElement(MobileSheet, {
    open: true, onOpenChange: vi.fn(), title: 'Options', ...props,
  }, createElement('button', { type: 'button' }, 'Inside')));
}

describe('MobileSheet', () => {
  it('portals a named modal dialog to document.body and passes attributes through', async () => {
    await render({ 'data-testid': 'options-sheet', title: 'Options' } as never);
    const node = sheet()!;
    expect(node).not.toBeNull();
    expect(harness.container.contains(node)).toBe(false);
    expect(node.closest('body')).toBe(document.body);
    expect(node.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(node.getAttribute('aria-labelledby')!)?.textContent).toBe('Options');
    expect(node.hasAttribute('aria-describedby')).toBe(false);
    expect(node.dataset.testid).toBe('options-sheet');
  });

  it('describes itself when a description is given', async () => {
    await render({ description: 'Page 2 settings' });
    const node = sheet()!;
    expect(document.getElementById(node.getAttribute('aria-describedby')!)?.textContent).toBe('Page 2 settings');
  });

  it('uses the drawer layers, backdrop token, safe-area padding and a scrolling body', async () => {
    await render();
    const backdrop = document.querySelector<HTMLElement>('[data-ui="sheet-backdrop"]')!;
    expect(backdrop.style.zIndex).toBe(String(Z_LAYERS.drawerBackdrop));
    expect(backdrop.classList.contains('mobile-backdrop')).toBe(true);
    const node = sheet()!;
    expect(node.style.zIndex).toBe(String(Z_LAYERS.drawer));
    for (const name of ['pb-[env(safe-area-inset-bottom)]', 'max-h-[85dvh]', 'bottom-0']) {
      expect(node.classList.contains(name), name).toBe(true);
    }
    expect(node.querySelector('[data-ui="sheet-body"]')!.classList.contains('overflow-y-auto')).toBe(true);
  });

  it('has a 44px close button that closes the sheet', async () => {
    const onOpenChange = vi.fn();
    await render({ onOpenChange, closeLabel: 'Hide options' });
    const close = document.querySelector<HTMLButtonElement>('button[aria-label="Hide options"]')!;
    expect(close.classList.contains('size-11')).toBe(true);
    await act(async () => close.click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes on Escape and on backdrop click', async () => {
    const onOpenChange = vi.fn();
    await render({ onOpenChange });
    await press('Escape');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    onOpenChange.mockClear();
    await clickOutside('[data-ui="sheet-backdrop"]');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not render while closed, and returns focus to the opener after closing', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return createElement('div', null,
        createElement('button', { type: 'button', onClick: () => setOpen(true) }, 'Open'),
        createElement(MobileSheet, { open, onOpenChange: setOpen, title: 'Options' }, 'Body'));
    }
    await harness.render(createElement(Harness));
    expect(sheet()).toBeNull();
    const opener = buttonByText('Open');
    opener.focus();
    await act(async () => opener.click());
    expect(sheet()!.contains(document.activeElement)).toBe(true);
    await press('Escape');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
