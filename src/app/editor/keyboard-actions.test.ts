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
    expect(editorKeyboardAction({ key: 'ArrowDown' }, { ...base, selectedDisplayItem: 'path' })).toEqual({ type: 'nudge', target: 'drawing', dx: 0, dy: -1 });
  });

  it('deletes selected images and floating images', () => {
    expect(editorKeyboardAction({ key: 'Delete' }, { ...base, selectedDisplayItem: 'image' })).toEqual({ type: 'delete', target: 'embedded-image' });
    expect(editorKeyboardAction({ key: 'Backspace' }, { ...base, activeFloatingImage: true })).toEqual({ type: 'delete', target: 'floating-image' });
  });
});

describe('duplicate shortcut', () => {
  it('duplicates the selection with Ctrl/Cmd+D and leaves the browser shortcut otherwise', () => {
    expect(editorKeyboardAction({ key: 'd', metaKey: true }, { ...base, selectedDisplayItem: 'path' })).toEqual({ type: 'duplicate', target: 'display-item' });
    expect(editorKeyboardAction({ key: 'D', ctrlKey: true }, { ...base, selectedDisplayItem: 'image' })).toEqual({ type: 'duplicate', target: 'display-item' });
    expect(editorKeyboardAction({ key: 'd', ctrlKey: true }, { ...base, activeFloatingImage: true })).toEqual({ type: 'duplicate', target: 'floating-image' });
    expect(editorKeyboardAction({ key: 'd', metaKey: true }, { ...base, activeFloatingText: true })).toEqual({ type: 'duplicate', target: 'floating-text' });
    expect(editorKeyboardAction({ key: 'd', metaKey: true, shiftKey: true }, { ...base, selectedDisplayItem: 'path' })).toBeNull();
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

describe('print shortcut', () => {
  it('prints the edited PDF with Ctrl/Cmd+P instead of the editor page', () => {
    expect(editorKeyboardAction({ key: 'p', metaKey: true }, base)).toEqual({ type: 'print' });
    expect(editorKeyboardAction({ key: 'P', ctrlKey: true }, base)).toEqual({ type: 'print' });
    expect(editorKeyboardAction({ key: 'p', ctrlKey: true, shiftKey: true }, base)).toBeNull();
  });
});
