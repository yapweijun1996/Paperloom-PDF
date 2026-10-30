import { describe, expect, it, vi } from 'vitest';
import type { VisualSignature } from '@/engine/browser-core';
import type { PDFDocumentData } from '@/engine/types';
import { EditorDocumentOwner } from './document-owner';
import { runSignatureChange } from './signature-change';

const signature = (id: string) => ({ id } as VisualSignature);

function setup(initial: VisualSignature[]) {
  const doc = {} as PDFDocumentData;
  const owner = new EditorDocumentOwner();
  owner.replace(doc);
  let current = initial;
  const transaction = vi.fn();
  const publish = vi.fn();
  const history = vi.fn();
  const enqueue = (apply: (isCurrent: () => boolean) => Promise<void>) => owner.enqueue(doc, () => null, apply);
  const run = (update: (signatures: VisualSignature[]) => VisualSignature[]) => runSignatureChange({
    enqueue,
    current: () => current,
    update,
    apply: async (previous, next, isCurrent) => {
      transaction(previous, next, isCurrent());
      current = next;
      publish(next);
      history(next);
    },
  });
  return { owner, doc, enqueue, run, transaction, publish, history, getCurrent: () => current, setCurrent: (next: VisualSignature[]) => { current = next; } };
}

describe('queued signature changes', () => {
  it('skips a fresh array with identical elements and order without publishing or history', async () => {
    const a = signature('a'), b = signature('b');
    const state = setup([a, b]);
    expect(await state.run(current => [...current])).toBe(false);
    expect(state.transaction).not.toHaveBeenCalled();
    expect(state.publish).not.toHaveBeenCalled();
    expect(state.history).not.toHaveBeenCalled();
    expect(state.getCurrent()).toEqual([a, b]);
  });

  it('commits changed identity, addition, deletion and reordering', async () => {
    const a = signature('a'), b = signature('b'), changedA = signature('a');
    const state = setup([a, b]);
    expect(await state.run(() => [changedA, b])).toBe(true);
    expect(await state.run(current => [...current, a])).toBe(true);
    expect(await state.run(current => current.slice(0, 2))).toBe(true);
    expect(await state.run(current => [...current].reverse())).toBe(true);
    expect(state.transaction).toHaveBeenCalledTimes(4);
    expect(state.publish).toHaveBeenCalledTimes(4);
    expect(state.history).toHaveBeenCalledTimes(4);
    expect(state.getCurrent()).toEqual([b, changedA]);
  });

  it('compares against the latest snapshot after a prior queued change', async () => {
    const a = signature('a'), b = signature('b'), c = signature('c');
    const state = setup([a]);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = state.enqueue(async () => {
      await gate;
      state.setCurrent([b]);
    });
    const observed = vi.fn((current: VisualSignature[]) => [...current]);
    const noChange = state.run(observed);
    const change = state.run(current => [...current, c]);
    release();
    await first;
    expect(await noChange).toBe(false);
    expect(observed).toHaveBeenCalledWith([b]);
    expect(await change).toBe(true);
    expect(state.transaction).toHaveBeenCalledTimes(1);
    expect(state.transaction).toHaveBeenCalledWith([b], [b, c], true);
    expect(state.history).toHaveBeenCalledTimes(1);
    expect(state.getCurrent()).toEqual([b, c]);
  });

  it('does not apply a queued update to a replaced document', async () => {
    const state = setup([signature('a')]);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const running = new Promise<void>(resolve => { started = resolve; });
    const first = state.enqueue(async () => { started(); await gate; });
    await running;
    const pending = state.run(current => [...current, signature('b')]);
    const rejected = expect(pending).rejects.toThrow('The document was replaced before the edit.');
    state.owner.replace({} as PDFDocumentData);
    release();
    await first;
    await rejected;
    expect(state.transaction).not.toHaveBeenCalled();
    expect(state.history).not.toHaveBeenCalled();
  });
});
