// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from './ThemeProvider';

let root: Root;
let container: HTMLDivElement;
let storageDescriptor: PropertyDescriptor | undefined;
let matchMediaDescriptor: PropertyDescriptor | undefined;

/** Controllable `(prefers-color-scheme: dark)` query that records its change listeners. */
function fakeSystemScheme(initiallyDark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: initiallyDark,
    addEventListener: vi.fn((_type: string, listener: () => void) => { listeners.add(listener); }),
    removeEventListener: vi.fn((_type: string, listener: () => void) => { listeners.delete(listener); }),
  };
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => query) });
  return {
    listeners,
    set(dark: boolean) {
      query.matches = dark;
      listeners.forEach(listener => listener());
    },
  };
}

function useStorage(value: string | null) {
  const storage = { getItem: vi.fn(() => value), setItem: vi.fn((_key: string, next: string) => { value = next; }) };
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  return storage;
}

function Toggle() {
  const { theme, toggleTheme } = useTheme();
  return createElement('button', { onClick: toggleTheme }, theme);
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  storageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
  matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  if (storageDescriptor) Object.defineProperty(window, 'localStorage', storageDescriptor);
  if (matchMediaDescriptor) Object.defineProperty(window, 'matchMedia', matchMediaDescriptor);
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

it('follows the system scheme when nothing is stored and reacts to changes', () => {
  useStorage(null);
  const system = fakeSystemScheme(true);
  act(() => root.render(createElement(ThemeProvider, null, createElement(Toggle))));
  expect(container.textContent).toBe('dark');
  expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  expect(document.documentElement.style.colorScheme).toBe('dark');
  act(() => system.set(false));
  expect(container.textContent).toBe('light');
  expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  act(() => system.set(true));
  expect(container.textContent).toBe('dark');
});

it('lets a stored choice win over the system scheme', () => {
  useStorage('light');
  const system = fakeSystemScheme(true);
  act(() => root.render(createElement(ThemeProvider, null, createElement(Toggle))));
  expect(container.textContent).toBe('light');
  act(() => system.set(false));
  act(() => system.set(true));
  expect(container.textContent).toBe('light');
  expect(document.documentElement.getAttribute('data-theme')).toBe('light');
});

it('keeps an explicit toggle over later system changes and persists it', () => {
  const storage = useStorage(null);
  const system = fakeSystemScheme(false);
  act(() => root.render(createElement(ThemeProvider, null, createElement(Toggle))));
  expect(container.textContent).toBe('light');
  act(() => container.querySelector('button')!.click());
  expect(container.textContent).toBe('dark');
  expect(storage.setItem).toHaveBeenCalledWith('pdf-editor-theme', 'dark');
  act(() => system.set(false));
  expect(container.textContent).toBe('dark');
  expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
});

it('removes its system listener on unmount', () => {
  useStorage(null);
  const system = fakeSystemScheme(false);
  act(() => root.render(createElement(ThemeProvider, null, createElement(Toggle))));
  expect(system.listeners.size).toBe(1);
  act(() => root.unmount());
  expect(system.listeners.size).toBe(0);
  root = createRoot(container);
});
