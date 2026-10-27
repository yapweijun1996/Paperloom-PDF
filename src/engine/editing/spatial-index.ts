/**
 * Spatial Index — Phase 5 Editing Engine
 *
 * Quadtree for O(log n) hit testing over display list items.
 * Used for object selection, snap, and grouping.
 */

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpatialEntry<T> {
  id: string;
  bounds: Bounds;
  data: T;
}

interface QTNode<T> {
  bounds: Bounds;
  entries: SpatialEntry<T>[];
  children: QTNode<T>[] | null;
  depth: number;
}

const MAX_ENTRIES = 8;
const MAX_DEPTH = 12;

export class QuadTree<T> {
  private root: QTNode<T>;

  constructor(bounds: Bounds) {
    this.root = { bounds, entries: [], children: null, depth: 0 };
  }

  insert(entry: SpatialEntry<T>): void {
    this.insertInto(this.root, entry);
  }

  queryPoint(x: number, y: number): SpatialEntry<T>[] {
    const results: SpatialEntry<T>[] = [];
    this.queryPointIn(this.root, x, y, results);
    return results;
  }

  queryRect(rect: Bounds): SpatialEntry<T>[] {
    const results: SpatialEntry<T>[] = [];
    this.queryRectIn(this.root, rect, results);
    return results;
  }

  clear(): void {
    this.root.entries = [];
    this.root.children = null;
  }

  private insertInto(node: QTNode<T>, entry: SpatialEntry<T>): void {
    if (!intersects(node.bounds, entry.bounds)) return;

    if (node.children) {
      for (let i = 0; i < 4; i++) {
        this.insertInto(node.children[i], entry);
      }
      return;
    }

    node.entries.push(entry);

    if (node.entries.length > MAX_ENTRIES && node.depth < MAX_DEPTH) {
      this.subdivide(node);
      const old = node.entries;
      node.entries = [];
      for (let i = 0; i < old.length; i++) {
        for (let c = 0; c < 4; c++) {
          this.insertInto(node.children![c], old[i]);
        }
      }
    }
  }

  private subdivide(node: QTNode<T>): void {
    const { x, y, width, height } = node.bounds;
    const hw = width / 2;
    const hh = height / 2;
    const d = node.depth + 1;

    node.children = [
      { bounds: { x, y: y + hh, width: hw, height: hh }, entries: [], children: null, depth: d },
      { bounds: { x: x + hw, y: y + hh, width: hw, height: hh }, entries: [], children: null, depth: d },
      { bounds: { x, y, width: hw, height: hh }, entries: [], children: null, depth: d },
      { bounds: { x: x + hw, y, width: hw, height: hh }, entries: [], children: null, depth: d },
    ];
  }

  private queryPointIn(node: QTNode<T>, x: number, y: number, out: SpatialEntry<T>[]): void {
    if (!containsPoint(node.bounds, x, y)) return;

    for (let i = 0; i < node.entries.length; i++) {
      if (containsPoint(node.entries[i].bounds, x, y)) {
        out.push(node.entries[i]);
      }
    }

    if (node.children) {
      for (let i = 0; i < 4; i++) {
        this.queryPointIn(node.children[i], x, y, out);
      }
    }
  }

  private queryRectIn(node: QTNode<T>, rect: Bounds, out: SpatialEntry<T>[]): void {
    if (!intersects(node.bounds, rect)) return;

    for (let i = 0; i < node.entries.length; i++) {
      if (intersects(node.entries[i].bounds, rect)) {
        out.push(node.entries[i]);
      }
    }

    if (node.children) {
      for (let i = 0; i < 4; i++) {
        this.queryRectIn(node.children[i], rect, out);
      }
    }
  }
}

function intersects(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x
    && a.y < b.y + b.height && a.y + a.height > b.y;
}

function containsPoint(b: Bounds, x: number, y: number): boolean {
  return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
}

/** Topmost hit (last inserted wins for z-order). */
export function hitTestSpatial<T>(
  tree: QuadTree<T>,
  x: number,
  y: number,
): SpatialEntry<T> | null {
  const hits = tree.queryPoint(x, y);
  return hits.length > 0 ? hits[hits.length - 1] : null;
}
