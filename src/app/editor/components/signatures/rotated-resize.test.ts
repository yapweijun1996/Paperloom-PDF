import { describe, expect, it } from 'vitest';
import { resizeBox, resizeRotatedBox, type ResizeHandle } from '../resizeGeometry';

const origin = { x: 30, y: 50, width: 200, height: 100 };
const handles: ResizeHandle[] = ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'];
function anchor(box: typeof origin, rotation: number, handle: ResizeHandle) {
  const x = handle.includes('w') ? 1 : handle.includes('e') ? -1 : 0;
  const y = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0;
  const theta = rotation * Math.PI / 180, c = Math.cos(theta), s = Math.sin(theta);
  return { x: box.x + box.width / 2 + c * x * box.width / 2 - s * y * box.height / 2,
    y: box.y + box.height / 2 + s * x * box.width / 2 + c * y * box.height / 2 };
}
describe('rotated signature resize', () => {
  for (const rotation of [0, 37, 90, 270]) for (const handle of handles) for (const free of [true, false]) {
    it(`keeps opposite ${handle} anchor fixed at ${rotation} degrees, free=${free}`, () => {
      const options = { dx: 34, dy: -19, minWidth: 24, minHeight: 16, free };
      const box = resizeRotatedBox(origin, handle, options, rotation);
      const before = anchor(origin, rotation, handle), after = anchor(box, rotation, handle);
      expect(after.x).toBeCloseTo(before.x, 8);
      expect(after.y).toBeCloseTo(before.y, 8);
      expect(Math.abs(box.width - origin.width) + Math.abs(box.height - origin.height)).toBeGreaterThan(0.01);
      if (free) {
        const theta = rotation * Math.PI / 180, c = Math.cos(theta), s = Math.sin(theta);
        const localX = c * options.dx + s * options.dy, localY = -s * options.dx + c * options.dy;
        if (handle.includes('e') || handle.includes('w')) {
          expect(box.width - origin.width).toBeCloseTo((handle.includes('e') ? 1 : -1) * localX, 8);
        }
        if (handle.includes('n') || handle.includes('s')) {
          expect(box.height - origin.height).toBeCloseTo((handle.includes('n') ? 1 : -1) * localY, 8);
        }
      } else if (handle.length === 2) {
        expect(box.width / box.height).toBeCloseTo(origin.width / origin.height, 8);
      }
      if (rotation === 0) expect(box).toEqual(resizeBox(origin, handle, options));
    });
  }
});
