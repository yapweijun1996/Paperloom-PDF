// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDrawingPointer } from './drawing-pointer';

let root: Root;
let container: HTMLDivElement;
const start = vi.fn(() => true);
const move = vi.fn();
const end = vi.fn();

function Page({ enabled = true }: { enabled?: boolean }) {
  const pointer = useDrawingPointer({ enabled, start, move, end });
  return createElement('div', pointer);
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(createElement(Page)));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function pointer(type: string, options: PointerEventInit = {}) {
  const target = container.firstElementChild!;
  const event = new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0,
    pointerType: 'touch', ...options,
  });
  target.dispatchEvent(event);
  return event;
}

describe('drawing pointer gestures', () => {
  it.each(['touch', 'pen', 'mouse'])('draws and finishes for %s without waiting for a render', (pointerType) => {
    const element = container.firstElementChild!;
    const capture = vi.fn();
    const release = vi.fn();
    Object.assign(element, { setPointerCapture: capture, releasePointerCapture: release });
    act(() => {
      pointer('pointerdown', { pointerType, clientX: 10 });
      pointer('pointermove', { pointerType, clientX: 30 });
      pointer('pointerup', { pointerType, clientX: 40 });
    });
    expect(start).toHaveBeenCalledOnce();
    expect(move.mock.calls.map(([event]) => event.clientX)).toEqual([30, 40]);
    expect(end).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledWith(true);
    expect(capture).toHaveBeenCalledWith(1);
    expect(release).toHaveBeenCalledWith(1);
  });

  it('ignores secondary contacts and finishes only the captured gesture', () => {
    act(() => {
      pointer('pointerdown');
      pointer('pointerdown', { pointerId: 2, isPrimary: false });
      pointer('pointermove', { pointerId: 2, isPrimary: false });
      pointer('pointerup', { pointerId: 2, isPrimary: false });
    });
    expect(start).toHaveBeenCalledOnce();
    expect(move).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    act(() => pointer('pointerup'));
    expect(end).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledWith(true);
  });

  it.each(['pointercancel', 'lostpointercapture'])('finishes an interrupted gesture once on %s', (type) => {
    act(() => { pointer('pointerdown'); pointer(type); pointer('pointerup'); });
    expect(end).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledWith(false);
  });

  it('does not intercept scrolling or secondary buttons when disabled', () => {
    act(() => root.render(createElement(Page, { enabled: false })));
    let event: PointerEvent;
    act(() => { event = pointer('pointerdown'); });
    expect(event!.defaultPrevented).toBe(false);
    expect(start).not.toHaveBeenCalled();
    act(() => root.render(createElement(Page)));
    act(() => pointer('pointerdown', { pointerType: 'mouse', button: 1 }));
    expect(start).not.toHaveBeenCalled();
  });

  it('does not capture when the editor refuses to start', () => {
    start.mockReturnValueOnce(false);
    const capture = vi.fn();
    Object.assign(container.firstElementChild!, { setPointerCapture: capture });
    act(() => { pointer('pointerdown'); pointer('pointermove'); pointer('pointerup'); });
    expect(capture).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });
});
