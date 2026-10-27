const DB_NAME = 'pdf-editor-db';
const DB_VERSION = 2;
const STORE_NAME = 'pdf-files';
const PDF_KEY = 'current-pdf';
const SESSION_KEY = 'editor-session';

export interface StoredPdf {
  bytes: ArrayBuffer;
  fileName: string;
}

export interface EditorSessionOverlay {
  drawnPathsJson: string;
  floatingTextsJson: string;
  floatingImagesJson: string;
  signaturesJson: string;
  currentPage: number;
}

export interface EditorSessionRecord {
  bytes: ArrayBuffer;
  fileName: string;
  updatedAt: number;
  overlays: EditorSessionOverlay;
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

export async function savePdfToStorage(bytes: ArrayBuffer, fileName: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({ bytes, fileName }, PDF_KEY);
    // New upload replaces any prior dirty session
    store.delete(SESSION_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadPdfFromStorage(): Promise<StoredPdf | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(PDF_KEY);
    req.onsuccess = () => resolve((req.result as StoredPdf) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function clearPdfFromStorage(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(PDF_KEY);
    store.delete(SESSION_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveEditorSession(session: EditorSessionRecord): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(session, SESSION_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadEditorSession(): Promise<EditorSessionRecord | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(SESSION_KEY);
    req.onsuccess = () => resolve((req.result as EditorSessionRecord) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function clearEditorSession(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(SESSION_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
