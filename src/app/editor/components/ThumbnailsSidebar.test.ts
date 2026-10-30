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

  it.each([false, true])('exposes page actions and forwards merge, split and removal on mobile=%s', isMobile => {
    const merge = vi.fn(), splitCurrent = vi.fn(), splitAll = vi.fn(), remove = vi.fn();
    act(() => root.render(createElement(ThumbnailsSidebar, {
      totalPages: 2, currentPage: 1, thumbnails: ['first', 'second'],
      isGeneratingThumbnails: false, onPageSelect: vi.fn(), isMobile,
      onMergePdf: merge, onSplitCurrentPage: splitCurrent, onSplitAllPages: splitAll, onRemoveCurrentPage: remove,
    })));
    const action = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === name)!;
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="file"]');
    const mergeInput = inputs[1];
    const choose = vi.spyOn(mergeInput, 'click').mockImplementation(() => {});
    act(() => action('Merge PDF').click());
    expect(choose).toHaveBeenCalledOnce();
    const file = new File(['pdf'], 'other.pdf', { type: 'application/pdf' });
    Object.defineProperty(mergeInput, 'files', { value: [file], configurable: true });
    act(() => mergeInput.dispatchEvent(new Event('change', { bubbles: true })));
    expect(merge).toHaveBeenCalledExactlyOnceWith(file);
    act(() => action('Download current page').click());
    act(() => action('Download each page').click());
    act(() => action('Remove current page').click());
    expect(splitCurrent).toHaveBeenCalledOnce();
    expect(splitAll).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
  });

  it('disables split-all and removal for a one-page document', () => {
    act(() => root.render(createElement(ThumbnailsSidebar, {
      totalPages: 1, currentPage: 0, thumbnails: ['first'], isGeneratingThumbnails: false,
      onPageSelect: vi.fn(), onSplitCurrentPage: vi.fn(), onSplitAllPages: vi.fn(), onRemoveCurrentPage: vi.fn(),
    })));
    const action = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === name)!;
    expect(action('Download current page').disabled).toBe(false);
    expect(action('Download each page').disabled).toBe(true);
    expect(action('Remove current page').disabled).toBe(true);
  });

  it('places the conformance notice before page downloads inside the mobile drawer', () => {
    act(() => root.render(createElement(ThumbnailsSidebar, {
      totalPages: 2, currentPage: 0, thumbnails: [], isGeneratingThumbnails: false,
      onPageSelect: vi.fn(), isMobile: true, onSplitCurrentPage: vi.fn(),
      conformanceNotice: createElement('p', { role: 'status' }, 'PDF/A warning'),
    })));
    const warning = container.querySelector('[role="status"]')!;
    const actions = container.querySelector('[aria-label="Page actions"]')!;
    expect(warning.textContent).toBe('PDF/A warning');
    expect(warning.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  it('supports keyboard-focusable page selection and page reordering', () => {
    const reorder = vi.fn(); const select = vi.fn();
    act(() => root.render(createElement(ThumbnailsSidebar, {
      totalPages: 2, currentPage: 0, thumbnails: ['first', 'second'],
      isGeneratingThumbnails: false, onPageSelect: select, onReorderPages: reorder,
    })));
    const selectSecond = container.querySelector<HTMLButtonElement>('button[aria-label="Select page 2"]')!;
    const earlier = container.querySelector<HTMLButtonElement>('button[aria-label="Move page 2 earlier"]')!;
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Move page 1 earlier"]')!.disabled).toBe(true);
    expect(container.querySelector('button[aria-label="Select page 1"]')?.getAttribute('aria-current')).toBe('page');
    act(() => selectSecond.click());
    act(() => earlier.click());
    expect(select).toHaveBeenCalledWith(1);
    expect(reorder).toHaveBeenCalledWith(1, 0);
  });
});
