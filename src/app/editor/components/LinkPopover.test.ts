// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { buttonByText, mountHarness } from '../ui/__tests__/harness';
import { LinkPopover, type LinkPopoverProps } from './LinkPopover';

const harness = mountHarness();

function props(overrides: Partial<LinkPopoverProps> = {}): LinkPopoverProps {
  return {
    mode: 'hover', anchorX: 120, anchorY: 80, url: 'https://example.com', displayText: 'Example',
    onEdit: vi.fn(), onOpen: vi.fn(), onRemove: vi.fn(), onClose: vi.fn(),
    onUrlChange: vi.fn(), onDisplayChange: vi.fn(), ...overrides,
  };
}

function setValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('LinkPopover', () => {
  it('shows the URL with Edit and Open Link when hovering', async () => {
    const p = props();
    await harness.render(createElement(LinkPopover, p));
    const popover = document.querySelector<HTMLElement>('[data-link-popover]')!;
    expect(popover.style.left).toBe('120px');
    expect(popover.textContent).toContain('https://example.com');
    buttonByText('Edit').click();
    buttonByText('Open Link').click();
    expect(p.onEdit).toHaveBeenCalledOnce();
    expect(p.onOpen).toHaveBeenCalledOnce();
  });

  it('shows a placeholder for an empty URL', async () => {
    await harness.render(createElement(LinkPopover, props({ url: '' })));
    expect(document.body.textContent).toContain('(empty URL)');
  });

  it('edits display text and URL, focuses the display field and offers Remove and Close', async () => {
    const p = props({ mode: 'edit' });
    await harness.render(createElement(LinkPopover, p));
    const display = document.querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(document.activeElement).toBe(display);
    await act(async () => setValue(display, 'New text'));
    expect(p.onDisplayChange).toHaveBeenCalledWith('New text');
    const url = document.querySelector<HTMLInputElement>('input[type="url"]')!;
    await act(async () => setValue(url, 'https://paperloom.test'));
    expect(p.onUrlChange).toHaveBeenCalledWith('https://paperloom.test');
    buttonByText('Remove').click();
    expect(p.onRemove).toHaveBeenCalledOnce();
    document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();
    expect(p.onClose).toHaveBeenCalledOnce();
  });

  it('uses theme tokens and the jade accent rather than orange or fixed light greys', async () => {
    for (const mode of ['hover', 'edit'] as const) {
      await harness.render(createElement(LinkPopover, props({ mode })));
      const classes = [...document.querySelectorAll('[data-link-popover], [data-link-popover] *')]
        .map(node => node.getAttribute('class') ?? '').join(' ');
      expect(classes).not.toMatch(/\b(?:bg|text|border)-(?:orange|zinc)-/);
      expect(classes).not.toMatch(/\b(?:bg|text)-white\b/);
    }
  });
});
