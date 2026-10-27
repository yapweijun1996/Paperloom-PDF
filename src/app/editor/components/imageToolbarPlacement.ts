export interface ToolbarRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ToolbarSize {
  width: number;
  height: number;
}

export type ToolbarSide = 'above' | 'below' | 'inside';

export interface ToolbarPlacement {
  side: ToolbarSide;
  /** CSS px to add to the toolbar's left edge so it stays inside the viewport. */
  offsetX: number;
  /** CSS px from the frame's top edge for the inside placement. */
  offsetY: number;
}

/** Space between the image frame and the toolbar; clears the 5 px resize handles. */
export const IMAGE_TOOLBAR_GAP = 12;
/** Minimum distance kept from the visible viewport edge. */
export const IMAGE_TOOLBAR_MARGIN = 8;

/**
 * Places the image quick-action toolbar outside the image frame, preferring above,
 * then below, and only falling back to inside the frame's top-left corner when the
 * frame fills the viewport vertically. All rects share one coordinate space.
 */
export function computeImageToolbarPlacement(
  frame: ToolbarRect,
  viewport: ToolbarRect,
  toolbar: ToolbarSize,
  gap = IMAGE_TOOLBAR_GAP,
  margin = IMAGE_TOOLBAR_MARGIN,
): ToolbarPlacement {
  const needed = toolbar.height + gap;
  let side: ToolbarSide = 'inside';
  if (frame.top - needed >= viewport.top + margin) side = 'above';
  else if (frame.bottom + needed <= viewport.bottom - margin) side = 'below';

  const minLeft = viewport.left + margin;
  const maxLeft = viewport.right - margin - toolbar.width;
  // The toolbar starts at the frame's left edge (inside mode is inset by the gap).
  const baseLeft = side === 'inside' ? frame.left + margin : frame.left;
  const clamped = maxLeft < minLeft ? minLeft : Math.min(Math.max(baseLeft, minLeft), maxLeft);
  const minTop = viewport.top + margin;
  const maxTop = viewport.bottom - margin - toolbar.height;
  const insideTop = Math.max(minTop, Math.min(frame.top + margin, maxTop));
  return { side, offsetX: clamped - baseLeft, offsetY: insideTop - frame.top };
}
