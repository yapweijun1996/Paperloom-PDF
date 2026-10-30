// @vitest-environment happy-dom
import { act, createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EditableLineBox } from './EditableLineBox';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('lets the IME handle Enter and Escape, then allows Enter after composition', () => {
  const onKeyDown = vi.fn((event: React.KeyboardEvent<HTMLTextAreaElement>) => event.preventDefault());
  const onBlur = vi.fn();
  act(() => root.render(createElement(EditableLineBox, {
    left: 0, top: 0, naturalWidth: 120, naturalHeight: 20, fontSizeCss: 14,
    fontFamily: 'sans-serif', fontWeight: 'normal', fontStyle: 'normal', color: '#000',
    text: 'text', caretStart: 4, caretEnd: 4, textRef: createRef<HTMLTextAreaElement>(),
    onTextInput: vi.fn(), onKeyDown, onBlur, onOffsetChange: vi.fn(), onSizeChange: vi.fn(),
    offsetCssX: 0, offsetCssY: 0, manualWidth: null, manualHeight: null,
  })));
  const input = container.querySelector('textarea')!;
  act(() => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  act(() => { input.dispatchEvent(enter); input.dispatchEvent(escape); });
  expect(enter.defaultPrevented).toBe(false);
  expect(escape.defaultPrevented).toBe(false);
  expect(onKeyDown).not.toHaveBeenCalled();
  act(() => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
  expect(onBlur).not.toHaveBeenCalled();
  act(() => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  expect(onBlur).toHaveBeenCalledTimes(1);
  const after = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  act(() => input.dispatchEvent(after));
  expect(onKeyDown).toHaveBeenCalledTimes(1);
  expect(after.defaultPrevented).toBe(true);
});
