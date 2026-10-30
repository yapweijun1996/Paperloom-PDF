export type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';
export type ResizeHandle = ResizeCorner | 'n' | 's' | 'e' | 'w';

interface ResizeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ResizeOptions {
  /** Pointer displacement in PDF units: positive y points upward. */
  dx: number;
  dy: number;
  minWidth: number;
  minHeight: number;
  free: boolean;
}

/** Resize a positive-size PDF box, keeping the opposite edge or corner fixed. */
export function resizeBox(
  origin: ResizeBox,
  handle: ResizeHandle,
  { dx, dy, minWidth, minHeight, free }: ResizeOptions,
): ResizeBox {
  if (handle === 'n' || handle === 's') {
    const height = Math.max(minHeight, origin.height + (handle === 'n' ? dy : -dy));
    return {
      x: origin.x,
      y: handle === 'n' ? origin.y : origin.y + origin.height - height,
      width: origin.width,
      height,
    };
  }
  if (handle === 'e' || handle === 'w') {
    const width = Math.max(minWidth, origin.width + (handle === 'e' ? dx : -dx));
    return {
      x: handle === 'e' ? origin.x : origin.x + origin.width - width,
      y: origin.y,
      width,
      height: origin.height,
    };
  }

  const east = handle === 'ne' || handle === 'se';
  const north = handle === 'nw' || handle === 'ne';
  const dw = east ? dx : -dx;
  const dh = north ? dy : -dy;
  let width: number;
  let height: number;

  if (free) {
    width = Math.max(minWidth, origin.width + dw);
    height = Math.max(minHeight, origin.height + dh);
  } else {
    const relativeWidth = dw / origin.width;
    const relativeHeight = dh / origin.height;
    // Compare changes, not resulting scales: inward drags must also shrink.
    // A tie follows width, keeping mixed-direction diagonal drags deterministic.
    const change = Math.abs(relativeWidth) >= Math.abs(relativeHeight)
      ? relativeWidth
      : relativeHeight;
    const scale = Math.max(1 + change, minWidth / origin.width, minHeight / origin.height);
    width = origin.width * scale;
    height = origin.height * scale;
  }

  return {
    x: east ? origin.x : origin.x + origin.width - width,
    y: north ? origin.y : origin.y + origin.height - height,
    width,
    height,
  };
}

/** Resize in the signature's local axes and preserve the opposite rotated anchor. */
export function resizeRotatedBox(origin: ResizeBox, handle: ResizeHandle, options: ResizeOptions, rotation: number): ResizeBox {
  if (rotation % 360 === 0) return resizeBox(origin, handle, options);
  const angle = rotation * Math.PI / 180;
  const c = Math.cos(angle), s = Math.sin(angle);
  const local = resizeBox(origin, handle, { ...options,
    dx: c * options.dx + s * options.dy, dy: -s * options.dx + c * options.dy });
  const originX = origin.x + origin.width / 2, originY = origin.y + origin.height / 2;
  const dx = local.x + local.width / 2 - originX, dy = local.y + local.height / 2 - originY;
  return { x: originX + c * dx - s * dy - local.width / 2,
    y: originY + s * dx + c * dy - local.height / 2, width: local.width, height: local.height };
}
