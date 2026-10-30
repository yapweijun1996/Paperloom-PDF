import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorSessionRecord, StoredPdf } from './pdfStorage';

type Request = { result?: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null };
type Operation = () => void;

/** A shared, FIFO readwrite transaction model for independent module owners. */
function fakeDatabase(initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(initial));
  const pending: Array<{ run: () => void }> = [];
  let running = false;
  const pump = () => {
    if (running || !pending.length) return;
    running = true;
    const next = pending.shift()!;
    queueMicrotask(() => {
      next.run();
      running = false;
      pump();
    });
  };
  const database = {
    transaction: vi.fn(() => {
      const operations: Operation[] = [];
      const tx = {
        oncomplete: null as null | (() => void),
        onerror: null as null | (() => void),
        onabort: null as null | (() => void),
        objectStore: () => ({
          get(key: string): Request {
            const req: Request = { onsuccess: null, onerror: null };
            operations.push(() => { req.result = data.get(key); req.onsuccess?.(); });
            return req;
          },
          put(value: unknown, key: string) { operations.push(() => { data.set(key, value); }); },
          delete(key: string) { operations.push(() => { data.delete(key); }); },
        }),
      };
      pending.push({ run: () => {
        while (operations.length) operations.shift()!();
        tx.oncomplete?.();
      } });
      pump();
      return tx;
    }),
  };
  const indexedDB = { open: () => {
    const request: Request = { result: database, onsuccess: null, onerror: null };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  } };
  return { data, database, indexedDB };
}

async function newOwner() {
  vi.resetModules();
  return import('./pdfStorage');
}

function session(): EditorSessionRecord {
  return {
    bytes: new ArrayBuffer(1), fileName: 'test.pdf', updatedAt: 1,
    overlays: { drawnPathsJson: '[]', floatingTextsJson: '[]', floatingImagesJson: '[]', signaturesJson: '[]', currentPage: 0 },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('editor session storage', () => {
  it('rejects an upload when a saved PDF exists even without a recovery', async () => {
    const db = fakeDatabase();
    vi.stubGlobal('indexedDB', db.indexedDB);
    const owner = await newOwner();
    await owner.savePdfToStorage(new Uint8Array([1]).buffer, 'saved.pdf');
    const savedPdf = db.data.get('current-pdf');
    await expect(owner.savePdfToStorage(new Uint8Array([2]).buffer, 'new.pdf'))
      .rejects.toMatchObject({ name: 'RecoveryExistsError' });
    expect(db.data.get('current-pdf')).toBe(savedPdf);
    expect(db.data.has('editor-session')).toBe(false);
  });

  it('rejects an upload when only an orphaned recovery exists', async () => {
    const orphan = session();
    const db = fakeDatabase({ 'editor-session': orphan });
    vi.stubGlobal('indexedDB', db.indexedDB);
    const owner = await newOwner();
    await expect(owner.savePdfToStorage(new ArrayBuffer(1), 'new.pdf'))
      .rejects.toMatchObject({ name: 'RecoveryExistsError' });
    expect(db.data.has('current-pdf')).toBe(false);
    expect(db.data.get('editor-session')).toBe(orphan);
  });

  it('inspects and explicitly discards an unchanged orphan, allowing a later upload', async () => {
    const orphan = session();
    const db = fakeDatabase({ 'editor-session': orphan });
    vi.stubGlobal('indexedDB', db.indexedDB);
    const owner = await newOwner();
    const snapshot = await owner.inspectOrphanRecovery();
    expect(snapshot).toEqual(orphan);
    expect(db.data.get('editor-session')).toBe(orphan);
    await owner.clearOrphanRecovery(snapshot!);
    expect(db.data.has('editor-session')).toBe(false);
    await owner.savePdfToStorage(new ArrayBuffer(1), 'new.pdf');
    expect(db.data.get('current-pdf')).toMatchObject({ fileName: 'new.pdf' });
  });

  it.each(['legacy', 'revisioned'] as const)('restores %s orphan bytes without changing its session', async (kind) => {
    const orphan = kind === 'legacy' ? session() : {
      ...session(), storageRevision: 'document-revision', sessionRevision: 'session-revision',
    };
    const db = fakeDatabase({ 'editor-session': orphan });
    vi.stubGlobal('indexedDB', db.indexedDB);
    const owner = await newOwner();
    const snapshot = await owner.inspectOrphanRecovery();
    await owner.restoreOrphanRecovery(snapshot!);
    expect(db.data.get('current-pdf')).toMatchObject({
      fileName: orphan.fileName, bytes: orphan.bytes, storageRevision: orphan.storageRevision,
    });
    expect(db.data.get('editor-session')).toBe(orphan);
    expect(await owner.inspectOrphanRecovery()).toBeNull();
    expect(await owner.loadPdfFromStorage()).toMatchObject({ fileName: orphan.fileName });
    expect(await owner.loadEditorSession()).toEqual(orphan);
    await expect(owner.saveEditorSession(session())).resolves.toBeUndefined();
  });

  it('does not restore an orphan if a PDF appears or recovery changes after inspection', async () => {
    const orphan = session();
    const db = fakeDatabase({ 'editor-session': orphan });
    vi.stubGlobal('indexedDB', db.indexedDB);
    const owner = await newOwner();
    const snapshot = await owner.inspectOrphanRecovery();
    const newPdf = { bytes: new ArrayBuffer(1), fileName: 'new.pdf' };
    db.data.set('current-pdf', newPdf);
    await expect(owner.restoreOrphanRecovery(snapshot!)).rejects.toMatchObject({ name: 'StaleDocumentStorageError' });
    expect(db.data.get('current-pdf')).toBe(newPdf);
    expect(db.data.get('editor-session')).toBe(orphan);
    db.data.delete('current-pdf');
    const changed = { ...orphan, bytes: new Uint8Array([42]).buffer };
    db.data.set('editor-session', changed);
    await expect(owner.restoreOrphanRecovery(snapshot!)).rejects.toMatchObject({ name: 'StaleDocumentStorageError' });
    expect(db.data.has('current-pdf')).toBe(false);
    expect(db.data.get('editor-session')).toBe(changed);
  });

  it('rejects empty orphan bytes without changing either record', async () => {
    const orphan = { ...session(), bytes: new ArrayBuffer(0) };
    const db = fakeDatabase({ 'editor-session': orphan });
    vi.stubGlobal('indexedDB', db.indexedDB);
    const owner = await newOwner();
    const snapshot = await owner.inspectOrphanRecovery();
    await expect(owner.restoreOrphanRecovery(snapshot!)).rejects.toThrow('valid PDF bytes');
    expect(db.data.has('current-pdf')).toBe(false);
    expect(db.data.get('editor-session')).toBe(orphan);
  });

  it('allows only one of two concurrent orphan restorations', async () => {
    const orphan = { ...session(), storageRevision: 'document-revision', sessionRevision: 'session-revision' };
    const db = fakeDatabase({ 'editor-session': orphan });
    vi.stubGlobal('indexedDB', db.indexedDB);
    const first = await newOwner();
    const second = await newOwner();
    const snapshot = await first.inspectOrphanRecovery();
    const a = first.restoreOrphanRecovery(snapshot!);
    const b = second.restoreOrphanRecovery(snapshot!);
    await expect(a).resolves.toBeUndefined();
    await expect(b).rejects.toMatchObject({ name: 'StaleDocumentStorageError' });
    expect(db.data.get('current-pdf')).toMatchObject({ fileName: orphan.fileName, storageRevision: orphan.storageRevision });
    expect(db.data.get('editor-session')).toBe(orphan);
  });

  it('does not expose a session as an orphan while a PDF exists', async () => {
    const db = fakeDatabase({ 'current-pdf': { bytes: new ArrayBuffer(1), fileName: 'test.pdf' }, 'editor-session': session() });
    vi.stubGlobal('indexedDB', db.indexedDB);
    const owner = await newOwner();
    expect(await owner.inspectOrphanRecovery()).toBeNull();
    expect(db.data.has('editor-session')).toBe(true);
  });

  it('does not discard an orphan if another tab creates a PDF after inspection', async () => {
    const orphan = session();
    const db = fakeDatabase({ 'editor-session': orphan });
    vi.stubGlobal('indexedDB', db.indexedDB);
    const owner = await newOwner();
    const snapshot = await owner.inspectOrphanRecovery();
    const newPdf = { bytes: new ArrayBuffer(1), fileName: 'new.pdf' };
    db.data.set('current-pdf', newPdf);
    await expect(owner.clearOrphanRecovery(snapshot!)).rejects.toMatchObject({ name: 'StaleDocumentStorageError' });
    expect(db.data.get('current-pdf')).toBe(newPdf);
    expect(db.data.get('editor-session')).toBe(orphan);
  });

  it('does not discard an orphan that changed after inspection', async () => {
    const original = session();
    const db = fakeDatabase({ 'editor-session': original });
    vi.stubGlobal('indexedDB', db.indexedDB);
    const owner = await newOwner();
    const snapshot = await owner.inspectOrphanRecovery();
    const changed = { ...original, bytes: new Uint8Array([42]).buffer };
    db.data.set('editor-session', changed);
    await expect(owner.clearOrphanRecovery(snapshot!)).rejects.toMatchObject({ name: 'StaleDocumentStorageError' });
    expect(db.data.get('editor-session')).toBe(changed);
  });

  it('serializes orphan discard before an upload from another owner', async () => {
    const orphan = session();
    const db = fakeDatabase({ 'editor-session': orphan });
    vi.stubGlobal('indexedDB', db.indexedDB);
    const first = await newOwner();
    const second = await newOwner();
    const snapshot = await first.inspectOrphanRecovery();
    const discard = first.clearOrphanRecovery(snapshot!);
    const upload = second.savePdfToStorage(new ArrayBuffer(1), 'new.pdf');
    await expect(discard).resolves.toBeUndefined();
    await expect(upload).resolves.toBeUndefined();
    expect(db.data.has('editor-session')).toBe(false);
    expect(db.data.get('current-pdf')).toMatchObject({ fileName: 'new.pdf' });
  });

  it('allows a new upload after the stored document is explicitly discarded', async () => {
    const db = fakeDatabase();
    vi.stubGlobal('indexedDB', db.indexedDB);
    const owner = await newOwner();
    await owner.savePdfToStorage(new ArrayBuffer(1), 'saved.pdf');
    await owner.clearPdfFromStorage();
    await owner.savePdfToStorage(new ArrayBuffer(2), 'new.pdf');
    expect(db.data.get('current-pdf')).toMatchObject({ fileName: 'new.pdf' });
  });

  it('rejects an upload without changing an existing PDF or recovery', async () => {
    const db = fakeDatabase();
    vi.stubGlobal('indexedDB', db.indexedDB);
    const owner = await newOwner();
    await owner.savePdfToStorage(new Uint8Array([1]).buffer, 'original.pdf');
    await owner.saveEditorSession(session());
    const previousPdf = db.data.get('current-pdf');
    const previousSession = db.data.get('editor-session');

    await expect(owner.savePdfToStorage(new Uint8Array([2]).buffer, 'new.pdf'))
      .rejects.toMatchObject({ name: 'RecoveryExistsError' });
    expect(db.data.get('current-pdf')).toBe(previousPdf);
    expect(db.data.get('editor-session')).toBe(previousSession);
  });

  it('rejects an upload when a different tab saves recovery first', async () => {
    const db = fakeDatabase();
    vi.stubGlobal('indexedDB', db.indexedDB);
    const first = await newOwner();
    await first.savePdfToStorage(new ArrayBuffer(1), 'original.pdf');
    const second = await newOwner();
    await second.loadPdfFromStorage();
    const recovery = first.saveEditorSession(session());
    const upload = second.savePdfToStorage(new ArrayBuffer(2), 'new.pdf');
    await expect(recovery).resolves.toBeUndefined();
    await expect(upload).rejects.toMatchObject({ name: 'RecoveryExistsError' });
    expect(db.data.get('current-pdf')).toMatchObject({ fileName: 'original.pdf' });
    expect(db.data.get('editor-session')).toMatchObject({ fileName: 'test.pdf' });
  });

  it('does not report success for a superseded upload', async () => {
    const db = fakeDatabase();
    vi.stubGlobal('indexedDB', db.indexedDB);
    const owner = await newOwner();
    const first = owner.savePdfToStorage(new ArrayBuffer(1), 'first.pdf');
    const second = owner.savePdfToStorage(new ArrayBuffer(2), 'second.pdf');
    await expect(first).rejects.toThrow('superseded');
    await expect(second).resolves.toBeUndefined();
    expect(db.data.get('current-pdf')).toMatchObject({ fileName: 'second.pdf' });
  });

  it('writes a current session and replaces it atomically on download', async () => {
    const db = fakeDatabase();
    vi.stubGlobal('indexedDB', db.indexedDB);
    const owner = await newOwner();
    await owner.savePdfToStorage(new Uint8Array([1]).buffer, 'original.pdf');
    await owner.saveEditorSession(session());
    expect(db.data.get('editor-session')).toMatchObject({ fileName: 'test.pdf' });
    const before = db.database.transaction.mock.calls.length;
    expect(await owner.commitDownloadedPdf(new Uint8Array([2]).buffer, 'saved.pdf')).toBe(true);
    expect(db.database.transaction.mock.calls.length - before).toBe(1);
    expect(db.data.get('current-pdf')).toMatchObject({ fileName: 'saved.pdf' });
    expect(db.data.has('editor-session')).toBe(false);
  });

  it('drops a delayed same-owner autosave scheduled before download', async () => {
    const db = fakeDatabase();
    vi.stubGlobal('indexedDB', db.indexedDB);
    const owner = await newOwner();
    await owner.savePdfToStorage(new ArrayBuffer(1), 'original.pdf');
    const oldGeneration = owner.captureEditorSessionGeneration();
    await owner.commitDownloadedPdf(new ArrayBuffer(2), 'saved.pdf');
    const before = db.database.transaction.mock.calls.length;
    await owner.saveEditorSession(session(), () => true, oldGeneration);
    expect(db.database.transaction.mock.calls.length).toBe(before);
    expect(db.data.has('editor-session')).toBe(false);
  });

  it('rejects another tab\'s stale autosave, download and close after replacement', async () => {
    const db = fakeDatabase();
    vi.stubGlobal('indexedDB', db.indexedDB);
    const first = await newOwner();
    await first.savePdfToStorage(new ArrayBuffer(1), 'original.pdf');
    const second = await newOwner();
    await second.loadPdfFromStorage();
    const secondGeneration = second.captureEditorSessionGeneration();
    await first.commitDownloadedPdf(new ArrayBuffer(2), 'newer.pdf');
    const newer = db.data.get('current-pdf');
    await expect(second.saveEditorSession(session(), () => true, secondGeneration)).rejects.toMatchObject({ name: 'StaleDocumentStorageError' });
    await expect(second.commitDownloadedPdf(new ArrayBuffer(3), 'obsolete.pdf')).rejects.toMatchObject({ name: 'StaleDocumentStorageError' });
    await expect(second.clearPdfFromStorage()).rejects.toMatchObject({ name: 'StaleDocumentStorageError' });
    expect(db.data.get('current-pdf')).toBe(newer);
    expect(db.data.has('editor-session')).toBe(false);
  });

  it('rejects a download when another tab has already saved newer recovery', async () => {
    const db = fakeDatabase();
    vi.stubGlobal('indexedDB', db.indexedDB);
    const first = await newOwner();
    await first.savePdfToStorage(new ArrayBuffer(1), 'original.pdf');
    const second = await newOwner();
    await second.loadPdfFromStorage();
    const write = second.saveEditorSession(session());
    const download = first.commitDownloadedPdf(new ArrayBuffer(2), 'newer.pdf');
    await expect(write).resolves.toBeUndefined();
    await expect(download).rejects.toMatchObject({ name: 'StaleDocumentStorageError' });
    expect(db.data.has('editor-session')).toBe(true);
    expect(db.data.get('current-pdf')).toMatchObject({ fileName: 'original.pdf' });
  });

  it('detects concurrent edits by two owners of the same upload', async () => {
    const db = fakeDatabase();
    vi.stubGlobal('indexedDB', db.indexedDB);
    const first = await newOwner();
    await first.savePdfToStorage(new ArrayBuffer(1), 'original.pdf');
    const second = await newOwner();
    await second.loadPdfFromStorage();
    expect(await second.loadEditorSession()).toBeNull();
    await first.saveEditorSession({ ...session(), fileName: 'first.pdf' });
    await expect(second.saveEditorSession({ ...session(), fileName: 'second.pdf' })).rejects.toMatchObject({ name: 'StaleDocumentStorageError' });
    await expect(second.clearPdfFromStorage()).rejects.toMatchObject({ name: 'StaleDocumentStorageError' });
    expect(db.data.get('editor-session')).toMatchObject({ fileName: 'first.pdf' });
  });

  it('allows successive queued saves by the same owner', async () => {
    const db = fakeDatabase();
    vi.stubGlobal('indexedDB', db.indexedDB);
    const owner = await newOwner();
    await owner.savePdfToStorage(new ArrayBuffer(1), 'original.pdf');
    const first = owner.saveEditorSession({ ...session(), fileName: 'first.pdf' });
    const second = owner.saveEditorSession({ ...session(), fileName: 'second.pdf' });
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(db.data.get('editor-session')).toMatchObject({ fileName: 'second.pdf' });
  });

  it('does not mix recovery from a different persisted document revision', async () => {
    const db = fakeDatabase({
      'current-pdf': { bytes: new ArrayBuffer(1), fileName: 'new.pdf', storageRevision: 'new' },
      'editor-session': { ...session(), storageRevision: 'old' },
    });
    vi.stubGlobal('indexedDB', db.indexedDB);
    const owner = await newOwner();
    await owner.loadPdfFromStorage();
    expect(await owner.loadEditorSession()).toBeNull();
  });

  it('does not load a recovery after another tab changes the PDF between reads', async () => {
    const db = fakeDatabase();
    vi.stubGlobal('indexedDB', db.indexedDB);
    const first = await newOwner();
    await first.savePdfToStorage(new ArrayBuffer(1), 'original.pdf');
    const second = await newOwner();
    await second.loadPdfFromStorage();
    await first.commitDownloadedPdf(new ArrayBuffer(2), 'newer.pdf');
    await expect(second.loadEditorSession()).rejects.toMatchObject({ name: 'StaleDocumentStorageError' });
  });

  it('accepts legacy PDF and recovery records with no stored revision', async () => {
    const legacy: StoredPdf = { bytes: new ArrayBuffer(1), fileName: 'legacy.pdf' };
    const db = fakeDatabase({ 'current-pdf': legacy, 'editor-session': session() });
    vi.stubGlobal('indexedDB', db.indexedDB);
    const owner = await newOwner();
    expect(await owner.loadPdfFromStorage()).toEqual(legacy);
    expect(await owner.loadEditorSession()).toMatchObject({ fileName: 'test.pdf' });
    await owner.saveEditorSession(session());
    expect(db.data.get('editor-session')).toMatchObject({ fileName: 'test.pdf' });
    expect(await owner.commitDownloadedPdf(new ArrayBuffer(2), 'saved.pdf')).toBe(true);
    expect((db.data.get('current-pdf') as StoredPdf).storageRevision).toBeTruthy();
    expect(db.data.has('editor-session')).toBe(false);
  });

  it('does not publish an obsolete download when its editor owner becomes stale', async () => {
    const db = fakeDatabase();
    vi.stubGlobal('indexedDB', db.indexedDB);
    const owner = await newOwner();
    await owner.savePdfToStorage(new ArrayBuffer(1), 'original.pdf');
    let current = true;
    const publication = owner.commitDownloadedPdf(new ArrayBuffer(2), 'other.pdf', () => current);
    current = false;
    expect(await publication).toBe(false);
    expect(db.data.get('current-pdf')).toMatchObject({ fileName: 'original.pdf' });
  });
});
