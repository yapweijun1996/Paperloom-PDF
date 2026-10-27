// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from './ThemeProvider';

let root: Root;
let container: HTMLDivElement;
let storageDescriptor: PropertyDescriptor | undefined;

function Toggle() {
  const { theme, toggleTheme } = useTheme();
  return createElement('button', { onClick: toggleTheme }, theme);
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  storageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  if (storageDescriptor) Object.defineProperty(window, 'localStorage', storageDescriptor);
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.colorScheme = '';
  vi.unstubAllGlobals();
});

it('restores the saved theme and persists a user toggle', () => {
  const storage = { getItem: vi.fn(() => 'dark'), setItem: vi.fn() };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  act(() => root.render(createElement(ThemeProvider, null, createElement(Toggle))));
  expect(container.textContent).toBe('dark');
  expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  act(() => container.querySelector('button')!.click());
  expect(container.textContent).toBe('light');
  expect(storage.setItem).toHaveBeenCalledWith('pdf-editor-theme', 'light');
});

it('keeps the chosen theme when storage is unavailable', () => {
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    getItem: () => { throw new Error('unavailable'); },
    setItem: () => { throw new Error('unavailable'); },
  } });
  act(() => root.render(createElement(ThemeProvider, null, createElement(Toggle))));
  act(() => container.querySelector('button')!.click());
  expect(container.textContent).toBe('dark');
  expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
});

it('hydrates server-rendered light markup using the saved dark preference', async () => {
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    getItem: () => 'dark', setItem: vi.fn(),
  } });
  const tree = createElement(ThemeProvider, null, createElement(Toggle));
  act(() => root.unmount());
  container.innerHTML = renderToString(tree);
  expect(container.textContent).toBe('light');
  const hydrationError = vi.fn();
  await act(async () => {
    root = hydrateRoot(container, tree, { onRecoverableError: hydrationError });
  });
  expect(container.textContent).toBe('dark');
  expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  expect(hydrationError).not.toHaveBeenCalled();
});
