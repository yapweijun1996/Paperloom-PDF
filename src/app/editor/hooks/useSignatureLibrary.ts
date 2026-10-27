import { useState, useSyncExternalStore } from 'react';
import { getSignatureLibrary, orderLibraryByRecent, type SignatureLibraryEntry } from '@/engine/browser-core';

const emptyEntries: SignatureLibraryEntry[] = [];

function createLibraryStore() {
  let entries = emptyEntries;
  const listeners = new Set<() => void>();
  const refresh = () => {
    entries = orderLibraryByRecent(getSignatureLibrary().list());
    listeners.forEach(listener => listener());
  };
  return {
    refresh,
    subscribe(listener: () => void) {
      listeners.add(listener);
      refresh();
      return () => { listeners.delete(listener); };
    },
    getSnapshot: () => entries,
  };
}

export function useSignatureLibrary() {
  const [store] = useState(createLibraryStore);
  const entries = useSyncExternalStore(store.subscribe, store.getSnapshot, () => emptyEntries);
  return { entries, refresh: store.refresh };
}
