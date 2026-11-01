import { describe, expect, it, vi } from 'vitest';
import type { VisualSignature } from '@/engine/browser-core';
import type { PDFDocumentData } from '@/engine/types';
import { EditorDocumentOwner } from './document-owner';
import { runSignatureChange, runSignatureLockChange, assertSignatureFieldPlacementAllowed, assertLockedSignaturePagesPreserved } from './signature-change';
import { PDFRef, type PDFDict } from '@/engine/types';
import { deleteSignature, setSignatureOpacity, updateSignature } from '@/engine/signatures/visual/signature-model';

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


describe('locked signature mutation boundary', () => {
  it('rejects arbitrary replacement or removal of a locked signature before transaction', async () => {
    const locked = { ...signature('locked'), locked: true };
    const state = setup([locked]);
    await expect(state.run(() => [])).rejects.toThrow(/unlock/i);
    await expect(state.run(() => [{ ...locked, opacity: 0.2 }])).rejects.toThrow(/unlock/i);
    expect(state.transaction).not.toHaveBeenCalled();
    expect(state.history).not.toHaveBeenCalled();
    expect(state.getCurrent()).toEqual([locked]);
  });

  it('serializes edit, lock, blocked deletion and opacity, unlock and edit against latest state', async () => {
    const initial = { ...signature('one'), locked: false, opacity: 1 };
    const state = setup([initial]);
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const delayed = state.run(current => current.map(s => ({ ...s, opacity: 0.8 })));
    const blocker = state.enqueue(async () => { started(); await gate; });
    await entered;
    const lock = runSignatureLockChange({ enqueue: state.enqueue, current: state.getCurrent, id: 'one',
      apply: async next => { state.setCurrent(next); state.publish(next); state.history(next); } });
    const deletion = state.run(current => deleteSignature(current, 'one'));
    const opacity = state.run(current => updateSignature(current, 'one', s => setSignatureOpacity(s, 0.2)));
    release(); await blocker;
    expect(await delayed).toBe(true);
    expect(await lock).toBe(true);
    expect(await deletion).toBe(false);
    expect(await opacity).toBe(false);
    expect(state.getCurrent()[0]).toMatchObject({ locked: true, opacity: 0.8 });
    expect(state.transaction).toHaveBeenCalledTimes(1);
    expect(state.history).toHaveBeenCalledTimes(2);
    const unlock = await runSignatureLockChange({ enqueue: state.enqueue, current: state.getCurrent, id: 'one',
      apply: async next => { state.setCurrent(next); state.publish(next); state.history(next); } });
    expect(unlock).toBe(true);
    expect(await state.run(current => updateSignature(current, 'one', s => setSignatureOpacity(s, 0.3)))).toBe(true);
    expect(state.getCurrent()[0]).toMatchObject({ locked: false, opacity: 0.3 });
    expect(await state.run(current => deleteSignature(current, 'one'))).toBe(true);
    expect(state.getCurrent()).toEqual([]);
  });

  it('refuses locked overlapping or associated field even when recovery geometry differs', () => {
    const locked = { ...signature('locked'), locked: true, pageIndex: 0, x: 10, y: 20, requiresCompositeAppearance: true };
    const target = new PDFRef(5, 0), other = new PDFRef(6, 0);
    expect(() => assertSignatureFieldPlacementAllowed([locked], 0, 10, 20, target, new Map([['locked', other]]))).toThrow(/unlock/i);
    expect(() => assertSignatureFieldPlacementAllowed([locked], 0, 200, 300, target, new Map([['locked', target]]))).toThrow(/unlock/i);
    expect(() => assertSignatureFieldPlacementAllowed([locked], 0, 200, 300, target, new Map())).toThrow(/unlock/i);
    expect(() => assertSignatureFieldPlacementAllowed([locked], 0, 200, 300, target, new Map([['locked', other]]))).not.toThrow();
    expect(() => assertSignatureFieldPlacementAllowed([{ ...locked, locked: false }], 0, 10, 20, target, new Map([['locked', target]]))).not.toThrow();
  });
});


describe('locked signature page and in-flight edits', () => {
  it('rejects removal of a locked signature page but permits reordering and unlocked deletion', () => {
    const locked = { ...signature('one'), locked: true, pageIndex: 1 };
    expect(() => assertLockedSignaturePagesPreserved([locked], ['a', 'b'], ['a'])).toThrow(/unlock/i);
    expect(() => assertLockedSignaturePagesPreserved([locked], ['a', 'b'], ['b', 'a'])).not.toThrow();
    expect(() => assertLockedSignaturePagesPreserved([{ ...locked, locked: false }], ['a', 'b'], ['a'])).not.toThrow();
  });

  it('does not lose a lock queued behind a genuinely in-flight asynchronous edit', async () => {
    const doc = {} as PDFDocumentData, owner = new EditorDocumentOwner(); owner.replace(doc);
    let current = [{ ...signature('one'), locked: false, opacity: 1 }];
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const enqueue = (apply: (isCurrent: () => boolean) => Promise<void>) => owner.enqueue(doc, () => null, apply);
    const first = runSignatureChange({ enqueue, current: () => current,
      update: items => items.map(s => ({ ...s, opacity: 0.8 })),
      apply: async (_previous, next) => { started(); await gate; current = next; } });
    await entered;
    const lock = runSignatureLockChange({ enqueue, current: () => current, id: 'one',
      apply: async next => { current = next; } });
    const deletion = runSignatureChange({ enqueue, current: () => current,
      update: items => deleteSignature(items, 'one'), apply: async (_previous, next) => { current = next; } });
    release();
    expect(await first).toBe(true);
    expect(await lock).toBe(true);
    expect(await deletion).toBe(false);
    expect(current[0]).toMatchObject({ locked: true, opacity: 0.8 });
  });
});

describe('locked field replacement in a real staged transaction', () => {
  it('uses the current queued lock and native reference even with stale recovery coordinates', async () => {
    const { rawPDF } = await import('@/engine/__tests__/audit-p1-fixtures');
    const { parsePDF } = await import('@/engine/parser/parser');
    const { serializeDocument } = await import('@/engine/writer/serializer');
    const { SessionDocumentEditor } = await import('@/engine/session/document-edit');
    const { findVisualSignatureRefs } = await import('@/engine/session/signature-edit');
    const { PDFName } = await import('@/engine/types');
    const doc = await parsePDF(rawPDF([
      '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] >> >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Annots [5 0 R] >>',
      '<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] /Length 0 >>\nstream\nendstream',
      '<< /Type /Annot /Subtype /Widget /FT /Sig /Rect [100 150 300 230] /PaperloomSignatureId (locked) /AP << /N 4 0 R >> >>',
    ]));
    const target = new PDFRef(5, 0), owner = new EditorDocumentOwner(); owner.replace(doc);
    let current: VisualSignature[] = [{ ...signature('locked'), pageIndex: 0, x: 350, y: 20, locked: false, requiresCompositeAppearance: true }];
    const original = await serializeDocument(doc), editor = new SessionDocumentEditor(), history = vi.fn();
    const enqueue = (apply: (isCurrent: () => boolean) => Promise<void>) => owner.enqueue(doc, () => null, apply);
    const lock = runSignatureLockChange({ enqueue, current: () => current, id: 'locked',
      apply: async next => { current = next; history(); } });
    const replacement = enqueue(async isCurrent => editor.edit(doc, 'replace-field', async staged => {
      assertSignatureFieldPlacementAllowed(current, 0, 100, 150, target,
        findVisualSignatureRefs(staged, new Set(current.filter(s => s.locked).map(s => s.id))));
      (staged.objects.get(target.toKey()) as PDFDict).set('Subtype', new PDFName('Stamp'));
    }, { isCurrent }));
    await lock;
    await expect(replacement).rejects.toThrow(/unlock/i);
    expect(current[0].locked).toBe(true);
    expect(history).toHaveBeenCalledTimes(1);
    expect(editor.canUndo).toBe(false);
    expect(Buffer.from(await serializeDocument(doc)).equals(Buffer.from(original))).toBe(true);
    expect((doc.objects.get(target.toKey()) as PDFDict).getName('Subtype')).toBe('Widget');
  });
});
