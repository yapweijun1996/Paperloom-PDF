// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PasswordDialog } from './PasswordDialog';
import { buttonByText, clickOutside, mountHarness, press } from '../ui/__tests__/harness';

const harness = mountHarness();

function dialog(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!node) throw new Error('Dialog not found');
  return node;
}

function passwordInput(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('input#pdf-password')!;
}

async function type(value: string) {
  const input = passwordInput();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('PasswordDialog', () => {
  it('is a named, described modal with a labelled password field that receives focus', async () => {
    await harness.render(createElement(PasswordDialog, { fileName: 'secret.pdf', onSubmit: vi.fn() }));
    const node = dialog();
    expect(node.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(node.getAttribute('aria-labelledby')!)?.textContent).toBe('Password required');
    expect(document.getElementById(node.getAttribute('aria-describedby')!)?.textContent).toBe('"secret.pdf" is encrypted');
    const input = passwordInput();
    expect(input.type).toBe('password');
    expect(input.getAttribute('autocomplete')).toBe('current-password');
    expect(input.getAttribute('spellcheck')).toBe('false');
    expect(document.querySelector<HTMLLabelElement>('label[for="pdf-password"]')?.textContent).toBe('Document password');
    expect(document.activeElement).toBe(input);
  });

  it('submits the typed password with Enter or the Unlock button', async () => {
    const onSubmit = vi.fn();
    await harness.render(createElement(PasswordDialog, { onSubmit }));
    expect(dialog().textContent).toContain('This PDF is encrypted');
    await type('hunter2');
    await act(async () => buttonByText('Unlock').click());
    expect(onSubmit).toHaveBeenCalledWith('hunter2');
  });

  it('shows the verification error on the field', async () => {
    await harness.render(createElement(PasswordDialog, { onSubmit: vi.fn(), error: 'Incorrect password' }));
    const input = passwordInput();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const alert = dialog().querySelector('[role="alert"]')!;
    expect(alert.textContent).toBe('Incorrect password');
    expect(input.getAttribute('aria-describedby')).toContain(alert.id);
  });

  it('cannot be dismissed without onCancel', async () => {
    await harness.render(createElement(PasswordDialog, { onSubmit: vi.fn() }));
    expect(() => buttonByText('Cancel')).toThrow();
    await press('Escape');
    await clickOutside('[data-ui="dialog-overlay"]');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('cancels with the Cancel button and with Escape when onCancel is given', async () => {
    const onCancel = vi.fn();
    await harness.render(createElement(PasswordDialog, { onSubmit: vi.fn(), onCancel }));
    await act(async () => buttonByText('Cancel').click());
    expect(onCancel).toHaveBeenCalledTimes(1);
    await press('Escape');
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('disables input and actions and blocks dismissal while verifying', async () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();
    await harness.render(createElement(PasswordDialog, { onSubmit, onCancel, isVerifying: true }));
    expect(passwordInput().disabled).toBe(true);
    expect(buttonByText('Cancel').disabled).toBe(true);
    const unlock = buttonByText('Unlock');
    expect(unlock.disabled).toBe(true);
    expect(unlock.getAttribute('aria-busy')).toBe('true');
    expect(dialog().getAttribute('aria-busy')).toBe('true');
    await press('Escape', dialog());
    await act(async () => unlock.click());
    expect(onCancel).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
