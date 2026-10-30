// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { FieldRenameNotice } from './FieldRenameNotice';

it('shows the field mapping and lets the user dismiss it', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const dismiss = vi.fn();
  try {
    act(() => root.render(createElement(FieldRenameNotice, { changes: [{ from: 'Group.Name', to: 'Group_2.Name' }], onDismiss: dismiss })));
    expect(element.querySelector('[role="status"]')?.textContent).toContain('Group.Name → Group_2.Name');
    act(() => element.querySelector<HTMLButtonElement>('button[aria-label="Dismiss field name changes"]')!.click());
    expect(dismiss).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    element.remove();
    vi.unstubAllGlobals();
  }
});
