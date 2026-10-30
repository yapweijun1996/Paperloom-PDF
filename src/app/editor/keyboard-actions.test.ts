import { describe, expect, it } from 'vitest';
import { editorKeyboardAction, isCompositionKey } from './keyboard-actions';

const base = { selectedDisplayItem: null, activeFloatingImage: false, activeFloatingText: false, selectedSignature: false, activeTool: 'select' } as const;

describe('editor keyboard actions', () => {
  it('does not turn modified or shifted letters into tools', () => {
    expect(editorKeyboardAction({ key: 'v', ctrlKey: true }, base)).toBeNull();
    expect(editorKeyboardAction({ key: 'd', metaKey: true }, base)).toBeNull();
    expect(editorKeyboardAction({ key: 'e', shiftKey: true }, base)).toBeNull();
  });

  it('keeps native undo/redo shortcuts', () => {
    expect(editorKeyboardAction({ key: 'z', ctrlKey: true }, base)).toEqual({ type: 'undo' });
    expect(editorKeyboardAction({ key: 'y', ctrlKey: true }, base)).toEqual({ type: 'redo' });
  });

  it('nudges selected embedded and floating objects before page navigation', () => {
    expect(editorKeyboardAction({ key: 'ArrowRight', shiftKey: true }, { ...base, selectedDisplayItem: 'image' })).toEqual({ type: 'nudge', target: 'embedded-image', dx: 10, dy: 0 });
    expect(editorKeyboardAction({ key: 'ArrowUp' }, { ...base, activeFloatingImage: true })).toEqual({ type: 'nudge', target: 'floating-image', dx: 0, dy: 1 });
    expect(editorKeyboardAction({ key: 'ArrowLeft' }, { ...base, activeFloatingText: true })).toEqual({ type: 'nudge', target: 'floating-text', dx: -1, dy: 0 });
  });

  it('deletes selected images and floating images', () => {
    expect(editorKeyboardAction({ key: 'Delete' }, { ...base, selectedDisplayItem: 'image' })).toEqual({ type: 'delete', target: 'embedded-image' });
    expect(editorKeyboardAction({ key: 'Backspace' }, { ...base, activeFloatingImage: true })).toEqual({ type: 'delete', target: 'floating-image' });
  });
});

describe('IME composition keys', () => {
  it('keeps composing Enter, Shift+Enter, Escape and navigation in the input method', () => {
    for (const key of ['Enter', 'Escape', 'ArrowLeft', 'ArrowRight']) {
      expect(isCompositionKey({ key, isComposing: true })).toBe(true);
      expect(isCompositionKey({ key, keyCode: 229 })).toBe(true);
    }
    expect(isCompositionKey({ key: 'Process' })).toBe(true);
    expect(isCompositionKey({ key: 'Enter', isComposing: false, keyCode: 13 })).toBe(false);
    expect(isCompositionKey({ key: 'Escape', isComposing: false, keyCode: 27 })).toBe(false);
  });
});
