import { describe, expect, it } from 'vitest';
import {
  computeImageToolbarPlacement,
  IMAGE_TOOLBAR_GAP,
  IMAGE_TOOLBAR_MARGIN,
} from './imageToolbarPlacement';

const viewport = { left: 0, top: 0, right: 1000, bottom: 800 };
const toolbar = { width: 120, height: 26 };

describe('computeImageToolbarPlacement', () => {
  it('places the toolbar above the image when there is room', () => {
    const frame = { left: 200, top: 300, right: 500, bottom: 500 };
    expect(computeImageToolbarPlacement(frame, viewport, toolbar)).toMatchObject({ side: 'above', offsetX: 0 });
  });

  it('keeps the 12 px gap requirement exact at the boundary', () => {
    const needed = toolbar.height + IMAGE_TOOLBAR_GAP + IMAGE_TOOLBAR_MARGIN;
    const fits = { left: 200, top: needed, right: 500, bottom: needed + 100 };
    const tight = { ...fits, top: needed - 1, bottom: needed + 99 };
    expect(computeImageToolbarPlacement(fits, viewport, toolbar).side).toBe('above');
    expect(computeImageToolbarPlacement(tight, viewport, toolbar).side).toBe('below');
  });

  it('flips below when the image touches the top of the viewport', () => {
    const frame = { left: 200, top: 0, right: 500, bottom: 200 };
    expect(computeImageToolbarPlacement(frame, viewport, toolbar).side).toBe('below');
  });

  it('falls back inside when the image fills the viewport vertically', () => {
    const frame = { left: 100, top: 0, right: 900, bottom: 800 };
    expect(computeImageToolbarPlacement(frame, viewport, toolbar).side).toBe('inside');
  });

  it('keeps the inside toolbar visible when the image extends above the viewport', () => {
    const frame = { left: 100, top: -200, right: 900, bottom: 900 };
    const placement = computeImageToolbarPlacement(frame, viewport, toolbar);
    expect(placement.side).toBe('inside');
    expect(frame.top + placement.offsetY).toBe(viewport.top + IMAGE_TOOLBAR_MARGIN);
  });

  it('shifts the toolbar left so it does not overflow the right edge', () => {
    const frame = { left: 950, top: 300, right: 1100, bottom: 500 };
    const { side, offsetX } = computeImageToolbarPlacement(frame, viewport, toolbar);
    expect(side).toBe('above');
    expect(frame.left + offsetX + toolbar.width).toBeLessThanOrEqual(viewport.right - IMAGE_TOOLBAR_MARGIN);
  });

  it('shifts the toolbar right when the frame starts left of the viewport', () => {
    const frame = { left: -80, top: 300, right: 300, bottom: 500 };
    const { offsetX } = computeImageToolbarPlacement(frame, viewport, toolbar);
    expect(frame.left + offsetX).toBe(viewport.left + IMAGE_TOOLBAR_MARGIN);
  });

  it('stays within a viewport narrower than the toolbar', () => {
    const narrow = { left: 0, top: 0, right: 100, bottom: 800 };
    const frame = { left: 30, top: 300, right: 90, bottom: 500 };
    const { offsetX } = computeImageToolbarPlacement(frame, narrow, toolbar);
    expect(frame.left + offsetX).toBe(narrow.left + IMAGE_TOOLBAR_MARGIN);
  });
});
