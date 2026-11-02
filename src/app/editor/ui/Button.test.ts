// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Z_LAYERS } from '../zLayers';
import { Button, IconButton, type ButtonVariant } from './Button';
import { buttonByText, press, mountHarness } from './__tests__/harness';

const harness = mountHarness();

describe('Button', () => {
  it('renders a type=button with its label and passes title, aria-label and data attributes through', async () => {
    const onClick = vi.fn();
    await harness.render(createElement(Button, { onClick, title: 'Save the file', 'aria-label': 'Save', 'data-testid': 'save' } as never, 'Save'));
    const button = buttonByText('Save');
    expect(button.type).toBe('button');
    expect(button.title).toBe('Save the file');
    expect(button.getAttribute('aria-label')).toBe('Save');
    expect(button.dataset.testid).toBe('save');
    await act(async () => button.click());
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('activates from the keyboard as a native button', async () => {
    const onSubmit = vi.fn((event: Event) => event.preventDefault());
    await harness.render(createElement('form', { onSubmit }, createElement(Button, { type: 'submit' }, 'Go')));
    const button = buttonByText('Go');
    expect(button.type).toBe('submit');
    await act(async () => button.click());
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it.each([
    ['primary', ['bg-bloom-500', 'text-on-accent', 'hover:bg-bloom-600']],
    ['secondary', ['bg-panel', 'border-border-strong']],
    ['ghost', ['text-app-muted']],
    ['danger', ['text-danger', 'bg-danger-soft', 'border-danger']],
  ] as [ButtonVariant, string[]][])('applies the %s variant classes', async (variant, classes) => {
    await harness.render(createElement(Button, { variant }, 'Label'));
    const button = buttonByText('Label');
    expect(button.dataset.variant).toBe(variant);
    for (const name of classes) expect(button.classList.contains(name), name).toBe(true);
  });

  it('applies size classes', async () => {
    await harness.render(createElement(Button, { size: 'sm' }, 'Small'));
    expect(buttonByText('Small').classList.contains('h-8')).toBe(true);
    await harness.render(createElement(Button, { size: 'md' }, 'Small'));
    expect(buttonByText('Small').classList.contains('h-9')).toBe(true);
  });

  it('blocks clicks when disabled', async () => {
    const onClick = vi.fn();
    await harness.render(createElement(Button, { onClick, disabled: true }, 'Off'));
    await act(async () => buttonByText('Off').click());
    expect(onClick).not.toHaveBeenCalled();
    expect(buttonByText('Off').hasAttribute('aria-busy')).toBe(false);
  });

  it('shows a spinner, sets aria-busy and disables while loading', async () => {
    const onClick = vi.fn();
    await harness.render(createElement(Button, { onClick, loading: true }, 'Saving'));
    const button = buttonByText('Saving');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.querySelector('[data-testid="button-spinner"]')?.getAttribute('aria-hidden')).toBe('true');
    await act(async () => button.click());
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('IconButton', () => {
  function icon() {
    return createElement('svg', { 'data-icon': 'x' });
  }

  it('requires an aria-label at the type level', () => {
    // @ts-expect-error aria-label is required for icon-only buttons.
    const element = createElement(IconButton, { icon: icon() });
    expect(element).toBeTruthy();
  });

  it('exposes its accessible name, hides the icon and passes attributes through', async () => {
    await harness.render(createElement(IconButton, { 'aria-label': 'Rotate page', icon: icon(), title: 'Rotate', 'data-testid': 'rotate' } as never));
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Rotate page"]')!;
    expect(button).not.toBeNull();
    expect(button.title).toBe('Rotate');
    expect(button.dataset.testid).toBe('rotate');
    expect(button.querySelector('[data-icon]')!.parentElement!.getAttribute('aria-hidden')).toBe('true');
    for (const name of ['min-h-6', 'min-w-6', 'pointer-coarse:min-h-11', 'pointer-coarse:min-w-11']) {
      expect(button.classList.contains(name), name).toBe(true);
    }
  });

  it('shows a visible tooltip on keyboard focus at the dropdown layer, and hides it on Escape', async () => {
    await harness.render(createElement(IconButton, { 'aria-label': 'Rotate page', icon: icon(), tooltip: 'Rotate (R)' }));
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Rotate page"]')!;
    await act(async () => { button.focus(); });
    const tooltip = document.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toBe('Rotate (R)');
    const content = document.querySelector<HTMLElement>('[data-radix-popper-content-wrapper] [data-side]') ??
      document.querySelector<HTMLElement>('[data-side]');
    expect(content?.style.zIndex).toBe(String(Z_LAYERS.dropdown));
    await press('Escape', button);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('defaults the tooltip to the aria-label and supports disabled and loading', async () => {
    await harness.render(createElement(IconButton, { 'aria-label': 'Delete', icon: icon(), variant: 'danger', loading: true }));
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Delete"]')!;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.dataset.variant).toBe('danger');
    await harness.render(createElement(IconButton, { 'aria-label': 'Delete', icon: icon() }));
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Delete"]')!.focus(); });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Delete');
  });
});
