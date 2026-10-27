// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PDFDocumentData } from '@/engine/browser-core';
import { WatermarkPreview } from './WatermarkPreview';

let root: Root | null;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('updates every image tile and revokes replaced preview URLs', () => {
  const doc = { pages: [{ rotate: 0, mediaBox: { width: 600, height: 800 } }] } as unknown as PDFDocumentData;
  const file = new File(['image'], 'watermark.png', { type: 'image/png' });
  const props = {
    doc, currentPage: 0, scale: 1, watermarkType: 'image' as const, watermarkText: '',
    watermarkFontName: 'Arial', watermarkSize: 100, watermarkColor: '#000000', watermarkOpacity: 50,
    watermarkRotation: 0, watermarkMosaic: false, watermarkPosition: 'center',
    watermarkImageDims: { width: 20, height: 20 }, watermarkImageFile: file,
    watermarkShapeType: 'rectangle' as const, watermarkShapeColor: '#000000', watermarkBlendMode: 'Normal',
  };
  act(() => root!.render(createElement(WatermarkPreview, props)));
  expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:first');
  act(() => root!.render(createElement(WatermarkPreview, { ...props, watermarkMosaic: true })));
  const tiles = [...container.querySelectorAll('img')];
  expect(tiles.length).toBeGreaterThan(1);
  expect(tiles.every(tile => tile.getAttribute('src') === 'blob:second')).toBe(true);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:first');
  act(() => root!.unmount());
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:second');
  root = null;
});
