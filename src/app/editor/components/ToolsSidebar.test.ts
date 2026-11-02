// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToolsSidebar } from './ToolsSidebar';

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

it('shows a portalled tool tooltip with the shortcut on keyboard focus', async () => {
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(ToolsSidebar, { activeTool: 'select', setActiveTool: vi.fn(), highlightColor: '#ffff00' })));
  const draw = container.querySelector<HTMLButtonElement>('button[aria-label="Draw"]')!;
  expect(draw.getAttribute('aria-keyshortcuts')).toBe('D');
  await act(async () => { draw.focus(); });
  const tooltip = [...document.body.querySelectorAll('[role="tooltip"]')].find(node => node.textContent?.includes('Draw'));
  expect(tooltip?.textContent).toContain('D');
  // Rendered outside the scrolling rail, so its overflow cannot clip the tooltip.
  expect(container.contains(tooltip!)).toBe(false);
  act(() => root.unmount()); container.remove();
});
