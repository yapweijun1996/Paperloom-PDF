// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThumbnailsSidebar } from './ThumbnailsSidebar';

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
  vi.unstubAllGlobals();
});

describe('thumbnail page controls', () => {
  it('preserves insert controls across rerenders and passes their page indices', () => {
    const insert = vi.fn();
    const rotate = vi.fn();
    const props = {
      totalPages: 2, currentPage: 0, thumbnails: ['first', 'second'],
      isGeneratingThumbnails: false, onPageSelect: vi.fn(),
      onInsertBlankPage: insert, onRotatePage: rotate,
    };
    act(() => root.render(createElement(ThumbnailsSidebar, props)));
    const insertButtons = container.querySelectorAll<HTMLButtonElement>('button[aria-label="Insert blank page"]');
    expect(insertButtons).toHaveLength(3);
    const first = insertButtons[0];
    act(() => root.render(createElement(ThumbnailsSidebar, { ...props, currentPage: 1 })));
    expect(container.querySelector('button[aria-label="Insert blank page"]')).toBe(first);
    act(() => container.querySelectorAll<HTMLButtonElement>('button[aria-label="Insert blank page"]')[2].click());
    act(() => container.querySelectorAll<HTMLButtonElement>('button[aria-label="Rotate page"]')[2].click());
    expect(insert).toHaveBeenCalledWith(2);
    expect(rotate).toHaveBeenCalledWith(1);
  });

  it('moves a dragged page to an insertion bar', () => {
    const reorder = vi.fn();
    act(() => root.render(createElement(ThumbnailsSidebar, {
      totalPages: 2, currentPage: 0, thumbnails: ['first', 'second'],
      isGeneratingThumbnails: false, onPageSelect: vi.fn(), onReorderPages: reorder,
    })));
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), setDragImage: vi.fn() };
    const drag = (type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
      return event;
    };
    const thumbnail = container.querySelectorAll<HTMLElement>('[draggable="true"]')[0];
    const lastBar = container.querySelectorAll<HTMLElement>('[class*="group/bar"]')[2];
    act(() => thumbnail.dispatchEvent(drag('dragstart')));
    act(() => lastBar.dispatchEvent(drag('dragover')));
    act(() => lastBar.dispatchEvent(drag('drop')));
    expect(reorder).toHaveBeenCalledWith(0, 1);
  });
});
