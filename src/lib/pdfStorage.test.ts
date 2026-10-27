import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveEditorSession, type EditorSessionRecord } from './pdfStorage';

afterEach(() => vi.unstubAllGlobals());

function session(): EditorSessionRecord {
  return {
    bytes: new ArrayBuffer(1), fileName: 'test.pdf', updatedAt: 1,
    overlays: { drawnPathsJson: '[]', floatingTextsJson: '[]', floatingImagesJson: '[]', signaturesJson: '[]', currentPage: 0 },
  };
}

describe('editor session storage', () => {
  it('does not open a write transaction when its document changes while IndexedDB opens', async () => {
    let resolveOpen!: () => void;
    const transaction = vi.fn();
    const request = { result: { transaction }, onsuccess: null as null | (() => void), onerror: null };
    vi.stubGlobal('indexedDB', { open: () => {
      resolveOpen = () => request.onsuccess?.();
      return request;
    } });
    let current = true;
    const save = saveEditorSession(session(), () => current);
    current = false;
    resolveOpen();
    await save;
    expect(transaction).not.toHaveBeenCalled();
  });

  it('writes a session that is still current after IndexedDB opens', async () => {
    let resolveOpen!: () => void;
    const put = vi.fn();
    const tx = { objectStore: () => ({ put }), oncomplete: null as null | (() => void), onerror: null };
    const transaction = vi.fn(() => {
      queueMicrotask(() => tx.oncomplete?.());
      return tx;
    });
    const request = { result: { transaction }, onsuccess: null as null | (() => void), onerror: null };
    vi.stubGlobal('indexedDB', { open: () => {
      resolveOpen = () => request.onsuccess?.();
      return request;
    } });
    const record = session();
    const save = saveEditorSession(record, () => true);
    resolveOpen();
    await save;
    expect(transaction).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledWith(record, 'editor-session');
  });
});
