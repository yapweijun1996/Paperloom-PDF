// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { UnassignedOverlays } from './UnassignedOverlays';
import type { DrawnPath, FloatingText, FloatingImage } from '../types';
import type { VisualSignature } from '@/engine/browser-core';

it('preserves unidentified recovered items until the user assigns each one', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const assign = vi.fn();
  const texts: FloatingText[] = [{ id: 'a', pageKey: '', text: 'Recovered words', pdfX: 1, pdfY: 2, fontSize: 12, fontFamily: 'Helvetica', color: '#000' }];
  const images: FloatingImage[] = [{ id: 'b', pageKey: '', dataUrl: 'data:image/png;base64,AA==', pdfX: 1, pdfY: 2, pdfWidth: 3, pdfHeight: 4 }];
  const paths: DrawnPath[] = [{ id: 'c', pageKey: '', type: 'draw', color: '#000', size: 2, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }];
  const invalidSignatures = [{ id: 'unknown' }] as VisualSignature[];
  act(() => root.render(createElement(UnassignedOverlays, { overlays: { drawnPaths: paths, floatingTexts: texts, floatingImages: images }, pageKeys: ['page-a', 'page-b'], invalidSignatures, onAssign: assign })));
  expect(element.textContent).toContain('Recovered words');
  expect(element.querySelector('img')?.getAttribute('alt')).toBe('Recovered image');
  const selects = element.querySelectorAll('select');
  expect(element.textContent).toContain('Drawing: freehand (2 points)');
  expect(element.textContent).toContain('A recovered signature has no valid page');
  expect(selects).toHaveLength(3);
  act(() => { selects[0].value = 'page-b'; selects[0].dispatchEvent(new Event('change', { bubbles: true })); });
  expect(assign).toHaveBeenCalledWith('floatingTexts', 'a', 'page-b');
  expect(images[0].pageKey).toBe('');
  act(() => root.unmount());
  element.remove();
  vi.unstubAllGlobals();
});
