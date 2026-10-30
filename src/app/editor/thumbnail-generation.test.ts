import { describe, expect, it } from 'vitest';
import { generateThumbnails, ThumbnailCoordinator } from './thumbnail-generation';

describe('thumbnail generation', () => {
  it('preserves page order and yields between batches', async () => {
    const events: string[] = [];
    const result = await generateThumbnails(9, async page => { events.push(`page-${page}`); return `image-${page}`; },
      () => false, async () => { events.push('yield'); });
    expect(result).toEqual(Array.from({ length: 9 }, (_, page) => `image-${page}`));
    expect(events).toEqual(['page-0', 'page-1', 'page-2', 'page-3', 'yield', 'page-4', 'page-5', 'page-6', 'page-7', 'yield', 'page-8']);
  });

  it('stops without publishing partial or outdated images when cancelled during a yield', async () => {
    let cancelled = false;
    const pages: number[] = [];
    const result = await generateThumbnails(9, async page => { pages.push(page); return `image-${page}`; },
      () => cancelled, async () => { cancelled = true; });
    expect(result).toBeNull();
    expect(pages).toEqual([0, 1, 2, 3]);
  });

  it('discards a page whose rendering finishes after cancellation', async () => {
    let cancelled = false;
    const result = await generateThumbnails(1, async () => { cancelled = true; return 'old'; }, () => cancelled);
    expect(result).toBeNull();
  });
});

describe('targeted thumbnail refresh', () => {
  it('updates only changed pages while preserving the other images', async () => {
    const owner = {}, coordinator = new ThumbnailCoordinator<object>();
    const pages = ['a', 'b', 'c', 'd'];
    const token = coordinator.beginFull();
    expect(coordinator.finishFull(token, owner, pages, ['old-a', 'old-b', 'old-c', 'old-d'], pages)).toBe(true);
    const rendered: number[] = [];
    const result = await coordinator.refresh(owner, pages, [0, 2, 2], async page => { rendered.push(page); return `new-${pages[page]}`; }, () => true, () => pages);
    expect(rendered).toEqual([0, 2]);
    expect(result).toEqual({ status: 'updated', thumbnails: ['new-a', 'old-b', 'new-c', 'old-d'] });
  });

  it('requests a full pass when the original thumbnails are not ready', async () => {
    const owner = {}, coordinator = new ThumbnailCoordinator<object>();
    coordinator.beginFull();
    expect(await coordinator.refresh(owner, ['a'], [0], async () => 'new', () => true, () => ['a'])).toEqual({ status: 'rebuild' });
  });

  it('cannot publish an old partial render after a structural change', async () => {
    const owner = {}, coordinator = new ThumbnailCoordinator<object>();
    const pages = ['a', 'b'];
    const token = coordinator.beginFull();
    coordinator.finishFull(token, owner, pages, ['old-a', 'old-b'], pages);
    let finish!: (value: string) => void;
    const pending = coordinator.refresh(owner, pages, [0], () => new Promise(resolve => { finish = resolve; }), () => true, () => pages);
    coordinator.invalidate();
    const next = coordinator.beginFull();
    coordinator.finishFull(next, owner, ['b', 'a'], ['new-b', 'new-a'], ['b', 'a']);
    finish('stale-a');
    expect(await pending).toEqual({ status: 'superseded' });
    expect(await coordinator.refresh(owner, ['b', 'a'], [1], async () => 'latest-a', () => true, () => ['b', 'a']))
      .toEqual({ status: 'updated', thumbnails: ['new-b', 'latest-a'] });
  });

  it('rejects a full result if page identities changed before publication', () => {
    const owner = {}, coordinator = new ThumbnailCoordinator<object>();
    const token = coordinator.beginFull();
    expect(coordinator.finishFull(token, owner, ['a', 'b'], ['a', 'b'], ['b', 'a'])).toBe(false);
  });
});
