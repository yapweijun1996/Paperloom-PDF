// Test-only React harness for happy-dom primitive tests.
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, vi } from 'vitest';

export function mountHarness() {
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
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  return {
    async render(element: ReactElement) {
      await act(async () => root.render(element));
    },
    get container() { return container; },
  };
}

export async function press(key: string, target: EventTarget = document.activeElement ?? document) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

export function buttonByText(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === label);
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

/** Pointer-down outside a Radix layer. Its outside listener attaches one task after mount. */
export async function clickOutside(selector: string) {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const target = document.querySelector(selector);
  if (!target) throw new Error(`Outside target not found: ${selector}`);
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  });
}
