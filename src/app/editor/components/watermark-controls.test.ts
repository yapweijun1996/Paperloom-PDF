// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PropertiesSidebar } from './PropertiesSidebar';

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('passes the actual selected File to the watermark upload handler', () => {
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container), onUpload = vi.fn();
  const props = { activeTool: 'watermark', watermarkType: 'image', onWatermarkImageUpload: onUpload, displayItems: [] } as unknown as ComponentProps<typeof PropertiesSidebar>;
  act(() => root.render(createElement(PropertiesSidebar, props)));
  const input = document.createElement('input');
  const file = new File(['fixture'], 'synthetic.png', { type: 'image/png' });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  vi.spyOn(input, 'click').mockImplementation(() => {});
  vi.spyOn(document, 'createElement').mockReturnValue(input);
  const button = [...container.querySelectorAll('button')].find(item => item.textContent?.includes('ADD IMAGE'))!;
  act(() => button.click());
  act(() => input.dispatchEvent(new Event('change')));
  expect(onUpload).toHaveBeenCalledExactlyOnceWith(file);
  act(() => root.unmount()); container.remove();
});

it('passes supported shape selections to the watermark control', () => {
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container), onShape = vi.fn();
  const props = { activeTool: 'watermark', watermarkType: 'shape', watermarkShapeType: 'circle', setWatermarkShapeType: onShape, displayItems: [] } as unknown as ComponentProps<typeof PropertiesSidebar>;
  act(() => root.render(createElement(PropertiesSidebar, props)));
  const select = [...container.querySelectorAll('select')].find(item => [...item.options].some(option => option.value === 'pill'))!;
  select.value = 'pill';
  act(() => select.dispatchEvent(new Event('change', { bubbles: true })));
  expect(onShape).toHaveBeenCalledExactlyOnceWith('pill');
  act(() => root.unmount()); container.remove();
});
