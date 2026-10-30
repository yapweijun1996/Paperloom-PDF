// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Toolbar } from './Toolbar';
import { ToolsSidebar } from './ToolsSidebar';

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

it('names navigation and zoom controls and exposes disabled states', () => {
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  const noop = vi.fn();
  act(() => root.render(createElement(Toolbar, {
    fileName: 'test.pdf', currentPage: 0, totalPages: 2, scale: 0.5,
    drawnPaths: [], isSaving: false, canUndo: false, canRedo: false,
    onClose: noop, onPrevPage: noop, onNextPage: noop, onZoomIn: noop, onZoomOut: noop,
    onUndo: noop, onRedo: noop, onClearPaths: noop, onDownload: noop,
  })));
  const button = (name: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
  expect(button('Previous page').disabled).toBe(true);
  expect(button('Next page').disabled).toBe(false);
  expect(button('Zoom out').disabled).toBe(true);
  expect(button('Zoom in').disabled).toBe(false);
  act(() => button('Next page').click());
  expect(noop).toHaveBeenCalledOnce();
  act(() => root.unmount()); container.remove();
});

it.each([false, true])('names tools and exposes selection on mobile=%s', (isMobile) => {
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container); const select = vi.fn();
  act(() => root.render(createElement(ToolsSidebar, { activeTool: 'text', setActiveTool: select, highlightColor: '#ffff00', isMobile })));
  const text = container.querySelector<HTMLButtonElement>('button[aria-label="Edit Text"]')!;
  const security = container.querySelector<HTMLButtonElement>('button[aria-label="Security"]')!;
  expect(text.getAttribute('aria-pressed')).toBe('true');
  expect(security.getAttribute('aria-pressed')).toBe('false');
  act(() => security.click());
  expect(select).toHaveBeenCalledWith('security');
  act(() => root.unmount()); container.remove();
});
