// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WatermarkAppliedNotice } from './WatermarkAppliedNotice';

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

function setup(open = true) {
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container), onDismiss = vi.fn(), onTurnOnPreview = vi.fn();
  act(() => root.render(createElement(WatermarkAppliedNotice, { open, onDismiss, onTurnOnPreview })));
  return { container, onDismiss, onTurnOnPreview, done: () => { act(() => root.unmount()); container.remove(); } };
}

it('tells the user live preview is off without blocking the page, and closes on Escape', () => {
  const { container, onDismiss, done } = setup();
  const notice = container.querySelector('[role="status"]')!;
  expect(notice.textContent).toContain('Watermark applied');
  expect(notice.textContent).toContain('Live preview is now off');
  expect(notice.className).not.toContain('inset-0');
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(onDismiss).toHaveBeenCalledOnce();
  act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss watermark notice"]')!.click());
  expect(onDismiss).toHaveBeenCalledTimes(2);
  done();
});

it('can turn live preview back on', () => {
  const { container, onDismiss, onTurnOnPreview, done } = setup();
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === 'Turn live preview back on')!;
  act(() => button.click());
  expect(onTurnOnPreview).toHaveBeenCalledOnce();
  expect(onDismiss).toHaveBeenCalledOnce();
  done();
});

it('renders nothing and ignores Escape when closed', () => {
  const { container, onDismiss, done } = setup(false);
  expect(container.childElementCount).toBe(0);
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(onDismiss).not.toHaveBeenCalled();
  done();
});
