// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSignatureLibrary } from './useSignatureLibrary';

const library = vi.hoisted(() => ({ entries: [{ id: 'first' }] }));
vi.mock('@/engine/browser-core', () => ({
  getSignatureLibrary: () => ({ list: () => library.entries.slice() }),
  orderLibraryByRecent: (entries: typeof library.entries) => entries,
}));

let root: Root;
let container: HTMLDivElement;
function Harness() {
  const result = useSignatureLibrary();
  return createElement('button', { onClick: result.refresh }, result.entries.map(entry => entry.id).join(','));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  library.entries = [{ id: 'first' }];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('loads the library after subscription and publishes later changes', () => {
  act(() => root.render(createElement(Harness)));
  expect(container.textContent).toBe('first');
  library.entries.push({ id: 'second' });
  act(() => container.querySelector('button')!.click());
  expect(container.textContent).toBe('first,second');
});
