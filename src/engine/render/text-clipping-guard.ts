import type { DisplayItem } from '../content/interpreter';

/** Glyph outlines must contribute to the graphics clip for text modes 4–7. */
export class UnsupportedTextClippingError extends Error {
  constructor() {
    super('PDF text clipping modes 4–7 are not supported for rendering.');
    this.name = 'UnsupportedTextClippingError';
  }
}

export function assertTextClippingSupported(items: readonly DisplayItem[]): void {
  if (items.some(item => item.type === 'text' && item.renderingMode !== undefined &&
      item.renderingMode >= 4 && item.renderingMode <= 7 && !item.textClipSupported)) {
    throw new UnsupportedTextClippingError();
  }
}
