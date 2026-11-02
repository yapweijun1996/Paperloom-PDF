// @vitest-environment happy-dom
import { act, createElement, Fragment, useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { buttonByText, mountHarness, press } from './__tests__/harness';
import { useConfirm, type ConfirmOptions } from './useConfirm';

const harness = mountHarness();

let confirmFn: (options: ConfirmOptions) => Promise<boolean>;
const exposeConfirm = (confirm: typeof confirmFn) => { confirmFn = confirm; };

function Host() {
  const { confirm, dialog } = useConfirm();
  useEffect(() => exposeConfirm(confirm), [confirm]);
  return createElement(Fragment, null, dialog);
}

/** Opens a request and returns its pending answer (wrapped so await does not unwrap it). */
async function ask(options: ConfirmOptions = { title: 'Delete page', message: 'Delete page 2? You can undo this.' }) {
  let answer!: Promise<boolean>;
  await act(async () => { answer = confirmFn(options); });
  return { answer };
}

describe('useConfirm', () => {
  it('opens one modal confirmation with the given message and tone', async () => {
    await harness.render(createElement(Host));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await ask({ title: 'Delete page', message: 'Delete page 2? You can undo this.', confirmLabel: 'Delete', tone: 'danger' });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain('Delete page 2? You can undo this.');
    expect(dialog.dataset.tone).toBe('danger');
    expect(buttonByText('Delete')).toBeTruthy();
  });

  it('resolves true on confirm and false on cancel or Escape', async () => {
    await harness.render(createElement(Host));
    const first = await ask({ title: 'Remove', message: 'Remove it?', confirmLabel: 'Remove' });
    await act(async () => buttonByText('Remove').click());
    await expect(first.answer).resolves.toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    const second = await ask();
    await act(async () => buttonByText('Cancel').click());
    await expect(second.answer).resolves.toBe(false);

    const third = await ask();
    await press('Escape');
    await expect(third.answer).resolves.toBe(false);
  });

  it('cancels an older request when a newer one arrives', async () => {
    await harness.render(createElement(Host));
    const older = await ask({ title: 'One', message: 'First?' });
    const newer = await ask({ title: 'Two', message: 'Second?' });
    await expect(older.answer).resolves.toBe(false);
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Second?');
    await act(async () => buttonByText('Confirm').click());
    await expect(newer.answer).resolves.toBe(true);
  });
});
