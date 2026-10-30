/** Render all thumbnails in order while allowing input and cancellation between batches. */
export async function generateThumbnails(
  pageCount: number,
  render: (pageIndex: number) => Promise<string>,
  isCancelled: () => boolean,
  yieldControl: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 0)),
): Promise<string[] | null> {
  const thumbnails: string[] = [];
  for (let index = 0; index < pageCount; index++) {
    if (isCancelled()) return null;
    const image = await render(index);
    if (isCancelled()) return null;
    thumbnails.push(image);
    if ((index + 1) % 4 === 0 && index + 1 < pageCount) {
      await yieldControl();
    }
  }
  return isCancelled() ? null : thumbnails;
}

type RefreshResult =
  | { status: 'updated'; thumbnails: string[] }
  | { status: 'rebuild' | 'superseded' };

function samePages(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

/** Coordinates full and targeted renders so old work cannot publish over newer pages. */
export class ThumbnailCoordinator<Owner extends object> {
  private generation = 0;
  private cached: { owner: Owner; pageKeys: string[]; thumbnails: string[] } | null = null;

  invalidate(): void {
    this.generation++;
    this.cached = null;
  }

  beginFull(): number {
    this.invalidate();
    return this.generation;
  }

  finishFull(generation: number, owner: Owner, pageKeys: readonly string[], thumbnails: string[], currentPageKeys: readonly string[]): boolean {
    if (generation !== this.generation || thumbnails.length !== pageKeys.length || !samePages(pageKeys, currentPageKeys)) return false;
    this.cached = { owner, pageKeys: [...pageKeys], thumbnails: [...thumbnails] };
    return true;
  }

  async refresh(
    owner: Owner,
    pageKeys: readonly string[],
    indices: readonly number[],
    render: (pageIndex: number) => Promise<string>,
    isOwnerCurrent: () => boolean,
    getCurrentPageKeys: () => readonly string[],
    yieldControl?: () => Promise<void>,
  ): Promise<RefreshResult> {
    const cache = this.cached;
    if (!cache || cache.owner !== owner || !samePages(cache.pageKeys, pageKeys) ||
      indices.some(index => !Number.isInteger(index) || index < 0 || index >= pageKeys.length)) return { status: 'rebuild' };
    const generation = this.generation;
    const uniqueIndices = [...new Set(indices)];
    const images = await generateThumbnails(uniqueIndices.length, index => render(uniqueIndices[index]),
      () => generation !== this.generation || !isOwnerCurrent() || !samePages(pageKeys, getCurrentPageKeys()), yieldControl);
    if (generation !== this.generation || !isOwnerCurrent()) return { status: 'superseded' };
    if (!images || !samePages(pageKeys, getCurrentPageKeys())) return { status: 'rebuild' };
    const next = [...cache.thumbnails];
    uniqueIndices.forEach((index, position) => { next[index] = images[position]; });
    this.cached = { owner, pageKeys: [...pageKeys], thumbnails: next };
    return { status: 'updated', thumbnails: next };
  }
}
