// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PropertiesSidebar } from './PropertiesSidebar';

type Props = ComponentProps<typeof PropertiesSidebar>;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const render = (props: Record<string, unknown>) =>
  act(() => root.render(createElement(PropertiesSidebar, { displayItems: [], ...props } as unknown as Props)));
const byLabel = (name: string) => container.querySelector<HTMLElement>(`[aria-label="${name}"]`);
const labelled = (control: HTMLElement) => container.querySelector(`label[for="${control.id}"]`)?.textContent;

it('names text controls and exposes selection state', () => {
  const setSize = vi.fn(), setColor = vi.fn(), setAlign = vi.fn();
  render({
    activeTool: 'text', textFontFamily: 'Helvetica', setTextFontFamily: vi.fn(), textFontSize: 12, setTextFontSize: setSize,
    textBold: true, setTextBold: vi.fn(), textItalic: false, setTextItalic: vi.fn(), textUnderline: false, setTextUnderline: vi.fn(),
    textColor: '#EF4444', setTextColor: setColor, textAlign: 'center', setTextAlign: setAlign,
  });
  expect(labelled(container.querySelector('select')!)).toBe('Font');
  expect(labelled(container.querySelector<HTMLElement>('input[type="number"]')!)).toBe('Size');
  act(() => byLabel('Decrease font size')!.click());
  act(() => byLabel('Increase font size')!.click());
  expect(setSize).toHaveBeenCalledTimes(2);
  expect(byLabel('Font size 12')!.getAttribute('aria-pressed')).toBe('true');
  expect(container.querySelector('[title="Bold"]')!.getAttribute('aria-pressed')).toBe('true');
  expect(byLabel('Text colour Red')!.getAttribute('aria-pressed')).toBe('true');
  expect(byLabel('Text colour Black')!.getAttribute('aria-pressed')).toBe('false');
  act(() => byLabel('Text colour Black')!.click());
  expect(setColor).toHaveBeenCalledWith('#000000');
  expect(byLabel('Text colour')).not.toBeNull();
  expect(byLabel('Align center')!.getAttribute('aria-pressed')).toBe('true');
  expect(byLabel('Align left')!.getAttribute('aria-pressed')).toBe('false');
  act(() => byLabel('Align right')!.click());
  expect(setAlign).toHaveBeenCalledWith('right');
});

it('names draw and highlight swatches and size sliders', () => {
  render({ activeTool: 'draw', drawColor: '#3b82f6', setDrawColor: vi.fn(), drawSize: 3, setDrawSize: vi.fn(), drawMode: 'line', setDrawMode: vi.fn() });
  expect(byLabel('Draw colour Blue')!.getAttribute('aria-pressed')).toBe('true');
  expect(labelled(container.querySelector<HTMLElement>('input[type="range"]')!)).toBe('Brush Size');
  expect(container.querySelector('[title="Line"]')!.getAttribute('aria-pressed')).toBe('true');
  render({ activeTool: 'highlight', highlightColor: '#FFFB00', setHighlightColor: vi.fn(), highlightSize: 10, setHighlightSize: vi.fn() });
  expect(byLabel('Highlight colour Yellow')!.getAttribute('aria-pressed')).toBe('true');
  expect(labelled(container.querySelector<HTMLElement>('input[type="range"]')!)).toBe('Thickness');
});

it('names the watermark position grid', () => {
  const setPosition = vi.fn();
  render({ activeTool: 'watermark', watermarkType: 'text', watermarkPosition: 'center', setWatermarkPosition: setPosition });
  const grid = container.querySelector('[role="group"][aria-label="Watermark position"]')!;
  expect([...grid.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))).toEqual([
    'Top left', 'Top centre', 'Top right', 'Middle left', 'Centre', 'Middle right', 'Bottom left', 'Bottom centre', 'Bottom right',
  ]);
  expect(byLabel('Centre')!.getAttribute('aria-pressed')).toBe('true');
  act(() => byLabel('Bottom right')!.click());
  expect(setPosition).toHaveBeenCalledWith('bottom-right');
});
