const DB_NAME = 'pdf-editor-db';
const DB_VERSION = 2;
const STORE_NAME = 'pdf-files';
const PDF_KEY = 'current-pdf';
const SESSION_KEY = 'editor-session';
import type { EncryptedRecoveryOverlay } from './recoveryEncryption';

// A generation belongs to this editor runtime. Capture it when scheduling
// autosave, so a timer started before a download cannot recreate stale recovery.
let sessionGeneration = 0;
let activeStorageRevision: string | null = null;
let activeSessionRevision: string | null = null;

export interface EditorSessionGeneration {
  generation: number;
  storageRevision: string | null;
}

export function captureEditorSessionGeneration(): EditorSessionGeneration {
  return { generation: sessionGeneration, storageRevision: activeStorageRevision };
}

export class StaleDocumentStorageError extends Error {
  constructor() {
    super('The local document or recovery changed in another tab. Your changes remain open but cannot be saved locally; copy your work before reloading.');
    this.name = 'StaleDocumentStorageError';
  }
}

export class RecoveryExistsError extends Error {
  constructor() {
    super('A previous document or recovery is stored. Reopen or discard it before uploading another file.');
    this.name = 'RecoveryExistsError';
  }
}

function newStorageRevision(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function revisionMatches(record: StoredPdf | undefined, expected: string | null): boolean {
  return !!record && (record.storageRevision ?? null) === expected;
}

function sessionRevisionMatches(session: EditorSessionRecord | undefined, storageRevision: string | null): boolean {
  // A recovery from a different upload is not owned by the current document.
  const revision = session && (session.storageRevision ?? null) === storageRevision
    ? session.sessionRevision ?? null : null;
  return revision === activeSessionRevision;
}

export interface StoredPdf {
  bytes: ArrayBuffer;
  fileName: string;
  /** Missing for uploads created before revision tracking. */
  storageRevision?: string;
}

export interface RecoveredFormDraft {
  pageKey: string;
  fieldKey: string;
  value: string;
}

export interface EditorSessionOverlay {
  drawnPathsJson: string;
  floatingTextsJson: string;
  floatingImagesJson: string;
  signaturesJson: string;
  currentPage: number;
  /** Optional private signed-document edit snapshot, protected with the overlays. */
  signedSnapshot?: string;
  /** Uncommitted form text; protected together with the other overlays. */
  formDraft?: RecoveredFormDraft;
}

export interface EditorSessionRecord {
  bytes: ArrayBuffer;
  fileName: string;
  updatedAt: number;
  overlays: EditorSessionOverlay;
  /** Protected overlays accompany encrypted PDF bytes; plaintext overlays are empty. */
  protectedOverlays?: EncryptedRecoveryOverlay;
  /** Identifies the upload/download this recovery belongs to. */
  storageRevision?: string;
  /** Changes on every recovery write to detect edits from another tab. */
  sessionRevision?: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function replaceStoredPdf(
  bytes: ArrayBuffer,
  fileName: string,
  isCurrent: () => boolean,
  requireCurrentRevision: boolean,
): Promise<boolean> {
  const expectedRevision = activeStorageRevision;
  const generation = ++sessionGeneration;
  const storageRevision = newStorageRevision();
  const db = await openDb();
  if (generation !== sessionGeneration || !isCurrent()) return false;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    let changedElsewhere = false;
    let recoveryExists = false;
    let published = false;
    const publish = () => {
      if (generation !== sessionGeneration || !isCurrent()) return;
      store.put({ bytes, fileName, storageRevision }, PDF_KEY);
      // A download replaces its own recovery after the revision check.
      store.delete(SESSION_KEY);
      published = true;
    };
    if (requireCurrentRevision) {
      const current = store.get(PDF_KEY);
      current.onsuccess = () => {
        if (!revisionMatches(current.result as StoredPdf | undefined, expectedRevision)) {
          changedElsewhere = true;
          return;
        }
        const recovery = store.get(SESSION_KEY);
        recovery.onsuccess = () => {
          if (!sessionRevisionMatches(recovery.result as EditorSessionRecord | undefined, expectedRevision)) {
            changedElsewhere = true;
            return;
          }
          publish();
        };
      };
    } else {
      // An upload must not replace a saved document or any recovery without
      // an explicit discard, including records created by older versions.
      const current = store.get(PDF_KEY);
      current.onsuccess = () => {
        if (current.result !== undefined) {
          recoveryExists = true;
          return;
        }
        const recovery = store.get(SESSION_KEY);
        recovery.onsuccess = () => {
          if (recovery.result !== undefined) {
            recoveryExists = true;
            return;
          }
          publish();
        };
      };
    }
    tx.oncomplete = () => {
      if (changedElsewhere) return reject(new StaleDocumentStorageError());
      if (recoveryExists) return reject(new RecoveryExistsError());
      if (published && generation === sessionGeneration) {
        activeStorageRevision = storageRevision;
        activeSessionRevision = null;
      }
      resolve(published);
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('PDF storage transaction aborted'));
  });
}

export async function savePdfToStorage(bytes: ArrayBuffer, fileName: string): Promise<void> {
  const saved = await replaceStoredPdf(bytes, fileName, () => true, false);
  if (!saved) throw new Error('The upload was superseded by another operation. Try again.');
}

/** Publish downloaded bytes and remove prior recovery in the same transaction. */
export async function commitDownloadedPdf(
  bytes: ArrayBuffer,
  fileName: string,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  return replaceStoredPdf(bytes, fileName, isCurrent, true);
}

export async function loadPdfFromStorage(): Promise<StoredPdf | null> {
  const generation = sessionGeneration;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(PDF_KEY);
    req.onsuccess = () => {
      const record = (req.result as StoredPdf) ?? null;
      if (generation === sessionGeneration) {
        activeStorageRevision = record?.storageRevision ?? null;
        activeSessionRevision = null;
      }
      resolve(record);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function clearPdfFromStorage(): Promise<void> {
  const expectedRevision = activeStorageRevision;
  const generation = ++sessionGeneration;
  const db = await openDb();
  if (generation !== sessionGeneration) return;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    let changedElsewhere = false;
    const current = store.get(PDF_KEY);
    current.onsuccess = () => {
      if (generation !== sessionGeneration) return;
      if (!revisionMatches(current.result as StoredPdf | undefined, expectedRevision)) {
        changedElsewhere = true;
        return;
      }
      const recovery = store.get(SESSION_KEY);
      recovery.onsuccess = () => {
        if (generation !== sessionGeneration) return;
        if (!sessionRevisionMatches(recovery.result as EditorSessionRecord | undefined, expectedRevision)) {
          changedElsewhere = true;
          return;
        }
        store.delete(PDF_KEY);
        store.delete(SESSION_KEY);
      };
    };
    tx.oncomplete = () => {
      if (changedElsewhere) return reject(new StaleDocumentStorageError());
      if (generation === sessionGeneration) {
        activeStorageRevision = null;
        activeSessionRevision = null;
      }
      resolve();
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('PDF storage transaction aborted'));
  });
}

export async function saveEditorSession(
  session: EditorSessionRecord,
  isCurrent: () => boolean = () => true,
  generation: EditorSessionGeneration = captureEditorSessionGeneration(),
): Promise<void> {
  const db = await openDb();
  // A document may be replaced while IndexedDB is opening. Do not create a
  // transaction for an obsolete editor session.
  if (generation.generation !== sessionGeneration || !isCurrent()) return;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    let changedElsewhere = false;
    let publishedRevision: string | null = null;
    const current = store.get(PDF_KEY);
    current.onsuccess = () => {
      if (generation.generation !== sessionGeneration || !isCurrent()) return;
      if (!revisionMatches(current.result as StoredPdf | undefined, generation.storageRevision)) {
        changedElsewhere = true;
        return;
      }
      const recovery = store.get(SESSION_KEY);
      recovery.onsuccess = () => {
        if (generation.generation !== sessionGeneration || !isCurrent()) return;
        if (!sessionRevisionMatches(recovery.result as EditorSessionRecord | undefined, generation.storageRevision)) {
          changedElsewhere = true;
          return;
        }
        publishedRevision = newStorageRevision();
        store.put({ ...session, storageRevision: generation.storageRevision ?? undefined, sessionRevision: publishedRevision }, SESSION_KEY);
      };
    };
    tx.oncomplete = () => {
      if (changedElsewhere) return reject(new StaleDocumentStorageError());
      if (publishedRevision !== null && generation.generation === sessionGeneration) activeSessionRevision = publishedRevision;
      resolve();
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Session storage transaction aborted'));
  });
}

export async function loadEditorSession(): Promise<EditorSessionRecord | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const pdf = store.get(PDF_KEY);
    const req = store.get(SESSION_KEY);
    tx.oncomplete = () => {
      const stored = pdf.result as StoredPdf | undefined;
      const session = req.result as EditorSessionRecord | undefined;
      if (!revisionMatches(stored, activeStorageRevision)) {
        reject(new StaleDocumentStorageError());
        return;
      }
      if (!stored || !session || (stored.storageRevision ?? null) !== (session.storageRevision ?? null)) {
        activeSessionRevision = null;
        resolve(null);
        return;
      }
      activeSessionRevision = session.sessionRevision ?? null;
      resolve(session);
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Session storage transaction aborted'));
  });
}

/** Inspect an orphan without altering either stored record. */
export async function inspectOrphanRecovery(): Promise<EditorSessionRecord | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const pdf = store.get(PDF_KEY);
    const recovery = store.get(SESSION_KEY);
    tx.oncomplete = () => resolve(pdf.result === undefined
      ? (recovery.result as EditorSessionRecord | undefined) ?? null : null);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Recovery inspection transaction aborted'));
  });
}

function sameRecoverySnapshot(left: EditorSessionRecord | undefined, right: EditorSessionRecord): boolean {
  try {
    if (!left || left.fileName !== right.fileName || left.updatedAt !== right.updatedAt ||
        left.storageRevision !== right.storageRevision || left.sessionRevision !== right.sessionRevision ||
        JSON.stringify(left.overlays) !== JSON.stringify(right.overlays) ||
        JSON.stringify(left.protectedOverlays) !== JSON.stringify(right.protectedOverlays)) return false;
    if (!(left.bytes instanceof ArrayBuffer) || !(right.bytes instanceof ArrayBuffer)) return left.bytes === right.bytes;
    if (left.bytes.byteLength !== right.bytes.byteLength) return false;
    const a = new Uint8Array(left.bytes);
    const b = new Uint8Array(right.bytes);
    return a.every((byte, index) => byte === b[index]);
  } catch {
    return false;
  }
}

/** Restore the orphan's PDF bytes while keeping its recovery for editor reload. */
export async function restoreOrphanRecovery(expected: EditorSessionRecord): Promise<void> {
  const generation = ++sessionGeneration;
  const db = await openDb();
  if (generation !== sessionGeneration) throw new StaleDocumentStorageError();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    let changedElsewhere = false;
    let invalidRecovery = false;
    const pdf = store.get(PDF_KEY);
    pdf.onsuccess = () => {
      if (generation !== sessionGeneration || pdf.result !== undefined) {
        changedElsewhere = true;
        return;
      }
      const recovery = store.get(SESSION_KEY);
      recovery.onsuccess = () => {
        const record = recovery.result as EditorSessionRecord | undefined;
        if (generation !== sessionGeneration || !sameRecoverySnapshot(record, expected)) {
          changedElsewhere = true;
          return;
        }
        if (!(record?.bytes instanceof ArrayBuffer) || record.bytes.byteLength === 0 || typeof record.fileName !== 'string') {
          invalidRecovery = true;
          return;
        }
        store.put({
          bytes: record.bytes,
          fileName: record.fileName,
          storageRevision: record.storageRevision,
        }, PDF_KEY);
      };
    };
    tx.oncomplete = () => {
      if (changedElsewhere) return reject(new StaleDocumentStorageError());
      if (invalidRecovery) return reject(new Error('Recovery does not contain valid PDF bytes.'));
      if (generation === sessionGeneration) {
        activeStorageRevision = expected.storageRevision ?? null;
        activeSessionRevision = expected.sessionRevision ?? null;
      }
      resolve();
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Recovery restore transaction aborted'));
  });
}

/** Explicitly discard only the orphan that was shown to the user. */
export async function clearOrphanRecovery(expected: EditorSessionRecord): Promise<void> {
  const generation = ++sessionGeneration;
  const db = await openDb();
  if (generation !== sessionGeneration) throw new StaleDocumentStorageError();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    let changedElsewhere = false;
    const pdf = store.get(PDF_KEY);
    pdf.onsuccess = () => {
      if (generation !== sessionGeneration || pdf.result !== undefined) {
        changedElsewhere = true;
        return;
      }
      const recovery = store.get(SESSION_KEY);
      recovery.onsuccess = () => {
        if (generation !== sessionGeneration ||
            !sameRecoverySnapshot(recovery.result as EditorSessionRecord | undefined, expected)) {
          changedElsewhere = true;
          return;
        }
        store.delete(SESSION_KEY);
      };
    };
    tx.oncomplete = () => {
      if (changedElsewhere) return reject(new StaleDocumentStorageError());
      if (generation === sessionGeneration) {
        activeStorageRevision = null;
        activeSessionRevision = null;
      }
      resolve();
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Recovery discard transaction aborted'));
  });
}

export async function clearEditorSession(): Promise<void> {
  const expectedRevision = activeStorageRevision;
  const generation = ++sessionGeneration;
  const db = await openDb();
  if (generation !== sessionGeneration) return;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    let changedElsewhere = false;
    const current = store.get(PDF_KEY);
    current.onsuccess = () => {
      if (generation !== sessionGeneration) return;
      if (!revisionMatches(current.result as StoredPdf | undefined, expectedRevision)) {
        changedElsewhere = true;
        return;
      }
      const recovery = store.get(SESSION_KEY);
      recovery.onsuccess = () => {
        if (generation !== sessionGeneration) return;
        if (!sessionRevisionMatches(recovery.result as EditorSessionRecord | undefined, expectedRevision)) {
          changedElsewhere = true;
          return;
        }
        store.delete(SESSION_KEY);
      };
    };
    tx.oncomplete = () => {
      if (changedElsewhere) return reject(new StaleDocumentStorageError());
      if (generation === sessionGeneration) activeSessionRevision = null;
      resolve();
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Session storage transaction aborted'));
  });
}
