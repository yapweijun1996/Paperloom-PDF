export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

/** Exact coverage of a finite axis-aligned rectangle by a bounded set of rectangles. */
export function coversRectangle(areas: readonly Bounds[], target: Bounds): boolean {
  const xs = [target.minX, target.maxX];
  for (const area of areas) {
    if (area.minX > target.minX && area.minX < target.maxX) xs.push(area.minX);
    if (area.maxX > target.minX && area.maxX < target.maxX) xs.push(area.maxX);
  }
  xs.sort((a, b) => a - b);
  for (let i = 1; i < xs.length; i++) {
    const left = xs[i - 1], right = xs[i];
    if (left === right) continue;
    const intervals = areas.filter(area => area.minX <= left && area.maxX >= right)
      .map(area => [area.minY, area.maxY] as const).sort((a, b) => a[0] - b[0]);
    let covered = target.minY;
    for (const [bottom, top] of intervals) {
      if (bottom > covered) break;
      covered = Math.max(covered, top);
      if (covered >= target.maxY) break;
    }
    if (covered < target.maxY) return false;
  }
  return true;
}
