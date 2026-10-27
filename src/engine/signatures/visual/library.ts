/**
 * In-browser Signature Library — rename, delete, duplicate, favorites.
 * Persists to localStorage when available.
 */

import type { SignatureLibraryEntry, SignatureSourceKind } from './visual-types';
import { nextSignatureId } from './signature-model';

const STORAGE_KEY = 'bloom-pdf-signature-library-v1';

export class SignatureLibrary {
  private entries: SignatureLibraryEntry[] = [];
  private storage: Storage | null;

  constructor(storage?: Storage | null) {
    this.storage =
      storage === undefined
        ? typeof localStorage !== 'undefined'
          ? localStorage
          : null
        : storage;
    this.load();
  }

  list(): SignatureLibraryEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  get(id: string): SignatureLibraryEntry | null {
    const e = this.entries.find((x) => x.id === id);
    return e ? { ...e } : null;
  }

  favorites(): SignatureLibraryEntry[] {
    return this.list().filter((e) => e.favorite);
  }

  add(input: {
    name: string;
    source: SignatureSourceKind;
    imageDataUrl: string;
    width: number;
    height: number;
    favorite?: boolean;
    typedText?: string;
    typedFont?: string;
    typedColor?: string;
    typedFontSize?: number;
  }): SignatureLibraryEntry {
    const now = Date.now();
    const entry: SignatureLibraryEntry = {
      id: nextSignatureId('lib'),
      name: input.name.trim() || 'Untitled signature',
      favorite: input.favorite ?? false,
      createdAt: now,
      updatedAt: now,
      source: input.source,
      imageDataUrl: input.imageDataUrl,
      width: input.width,
      height: input.height,
      typedText: input.typedText,
      typedFont: input.typedFont,
      typedColor: input.typedColor,
      typedFontSize: input.typedFontSize,
    };
    this.entries.unshift(entry);
    this.persist();
    return { ...entry };
  }

  rename(id: string, name: string): SignatureLibraryEntry | null {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return null;
    e.name = name.trim() || e.name;
    e.updatedAt = Date.now();
    this.persist();
    return { ...e };
  }

  delete(id: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((x) => x.id !== id);
    if (this.entries.length === before) return false;
    this.persist();
    return true;
  }

  duplicate(id: string): SignatureLibraryEntry | null {
    const src = this.entries.find((x) => x.id === id);
    if (!src) return null;
    const now = Date.now();
    const copy: SignatureLibraryEntry = {
      ...src,
      id: nextSignatureId('lib'),
      name: `${src.name} copy`,
      favorite: false,
      createdAt: now,
      updatedAt: now,
    };
    this.entries.unshift(copy);
    this.persist();
    return { ...copy };
  }

  setFavorite(id: string, favorite: boolean): SignatureLibraryEntry | null {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return null;
    e.favorite = favorite;
    e.updatedAt = Date.now();
    this.persist();
    return { ...e };
  }

  toggleFavorite(id: string): SignatureLibraryEntry | null {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return null;
    return this.setFavorite(id, !e.favorite);
  }

  clear(): void {
    this.entries = [];
    this.persist();
  }

  private load(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as SignatureLibraryEntry[];
      if (Array.isArray(parsed)) this.entries = parsed;
    } catch {
      this.entries = [];
    }
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.entries));
    } catch {
      // quota / private mode — ignore
    }
  }
}

/** Singleton for app use. */
let _library: SignatureLibrary | null = null;

export function getSignatureLibrary(): SignatureLibrary {
  if (!_library) _library = new SignatureLibrary();
  return _library;
}

export function resetSignatureLibraryForTests(storage?: Storage | null): SignatureLibrary {
  _library = new SignatureLibrary(storage ?? null);
  return _library;
}
