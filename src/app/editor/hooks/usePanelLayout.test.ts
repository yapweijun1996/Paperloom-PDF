// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usePanelLayout } from './usePanelLayout';

const key = 'paperloom.editor.panelLayout';
let root: Root;
let container: HTMLDivElement;
let layout: ReturnType<typeof usePanelLayout>;
let storageDescriptor: PropertyDescriptor | undefined;

function Harness({ mobile }: { mobile: boolean }) {
  const current = usePanelLayout(mobile);
  useEffect(() => { layout = current; });
  return null;
}

beforeEach(() => {
  const values = new Map<string, string>();
  storageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  if (storageDescriptor) Object.defineProperty(window, 'localStorage', storageDescriptor);
});

describe('panel layout persistence', () => {
  it('preserves desktop preferences on mobile startup and while changing mobile panels', () => {
    const saved = { panel: true, thumbnails: false, focus: true };
    window.localStorage.setItem(key, JSON.stringify(saved));
    act(() => root.render(createElement(Harness, { mobile: true })));
    expect(layout.isPanelOpen).toBe(false);
    expect(layout.isFocusMode).toBe(false);
    act(() => layout.setIsPanelOpen(true));
    expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual(saved);
    act(() => root.render(createElement(Harness, { mobile: false })));
    expect(layout.isPanelOpen).toBe(true);
    expect(layout.isThumbnailsOpen).toBe(false);
    expect(layout.isFocusMode).toBe(true);
  });

  it('restores the desktop layout after switching to mobile and back', () => {
    act(() => root.render(createElement(Harness, { mobile: false })));
    act(() => {
      layout.setIsPanelOpen(false);
      layout.setIsThumbnailsOpen(false);
      layout.setIsFocusMode(true);
    });
    act(() => root.render(createElement(Harness, { mobile: true })));
    act(() => layout.setIsPanelOpen(true));
    act(() => root.render(createElement(Harness, { mobile: false })));
    expect(layout.isPanelOpen).toBe(false);
    expect(layout.isThumbnailsOpen).toBe(false);
    expect(layout.isFocusMode).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(key)!)).toEqual({ panel: false, thumbnails: false, focus: true });
    act(() => root.render(createElement(Harness, { mobile: true })));
    expect(layout.isPanelOpen).toBe(false);
  });
});
