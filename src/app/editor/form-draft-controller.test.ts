import { describe, expect, it, vi } from 'vitest';
import { FormDraftController, resolveRecoveredFormDraft } from './form-draft-controller';

const draft = { pageKey: '3_0', fieldKey: '7_0', value: 'abc' };

describe('form draft commit', () => {
  it('coalesces typing into one transaction and retains the draft on failure', async () => {
    const controller = new FormDraftController();
    controller.set({ ...draft, value: 'a' });
    controller.set({ ...draft, value: 'ab' });
    controller.set(draft);
    await expect(controller.commit(async () => { throw new Error('cannot save'); })).rejects.toThrow('cannot save');
    expect(controller.get()).toEqual(draft);
    const write = vi.fn(async () => {});
    await controller.commit(write);
    expect(write).toHaveBeenCalledExactlyOnceWith(draft);
    expect(controller.get()).toBeNull();
  });

  it('does not erase later input when a commit is already running', async () => {
    const controller = new FormDraftController();
    controller.set(draft);
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const write = vi.fn(async () => { if (write.mock.calls.length === 1) await waiting; });
    const first = controller.commit(write);
    controller.set({ ...draft, value: 'abcd' });
    const second = controller.commit(write);
    release();
    await Promise.all([first, second]);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith({ ...draft, value: 'abcd' });
    expect(controller.get()).toBeNull();
  });
});

describe('form draft restoration', () => {
  it('restores only to the original page and field', () => {
    const pages = [{ ref: { toKey: () => '3_0' } }, { ref: { toKey: () => '4_0' } }];
    const field = { ref: { toKey: () => '7_0' }, fieldType: 'Tx' };
    expect(resolveRecoveredFormDraft(draft, pages, () => [field])).toEqual({ pageIndex: 0, field });
    expect(() => resolveRecoveredFormDraft({ ...draft, pageKey: 'missing' }, pages, () => [field])).toThrow(/preserved/i);
    expect(() => resolveRecoveredFormDraft({ ...draft, fieldKey: 'missing' }, pages, () => [field])).toThrow(/preserved/i);
    expect(() => resolveRecoveredFormDraft(draft, pages, () => [field, field])).toThrow(/preserved/i);
  });
});
