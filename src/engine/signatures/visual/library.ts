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
  private sessionIds = new Set<string>();
  private lastRaw: string | null = null;
  private readable = true;
  private warning: string | null = null;

  constructor(storage?: Storage | null) {
    try {
      this.storage = storage === undefined ? (typeof localStorage !== 'undefined' ? localStorage : null) : storage;
    } catch {
      this.storage = null;
    }
    this.load();
  }

  list(): SignatureLibraryEntry[] {
    return this.entries.map((e) => this.view(e));
  }

  get(id: string): SignatureLibraryEntry | null {
    const e = this.entries.find((x) => x.id === id);
    return e ? this.view(e) : null;
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
    sessionOnly?: boolean;
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
    if (input.sessionOnly) this.sessionIds.add(entry.id);
    else if (!this.persist()) this.sessionIds.add(entry.id);
    return this.view(entry);
  }

  rename(id: string, name: string): SignatureLibraryEntry | null {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return null;
    const before = { ...e };
    e.name = name.trim() || e.name;
    e.updatedAt = Date.now();
    if (!this.sessionIds.has(id) && !this.persist()) Object.assign(e, before);
    return this.view(e);
  }

  delete(id: string): boolean {
    const index = this.entries.findIndex((x) => x.id === id);
    if (index < 0) return false;
    const [entry] = this.entries.splice(index, 1);
    if (this.sessionIds.delete(id)) return true;
    if (!this.persist()) {
      this.entries.splice(index, 0, entry);
      return false;
    }
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
    if (this.sessionIds.has(id)) this.sessionIds.add(copy.id);
    else if (!this.persist()) this.sessionIds.add(copy.id);
    return this.view(copy);
  }

  setFavorite(id: string, favorite: boolean): SignatureLibraryEntry | null {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return null;
    const before = { ...e };
    e.favorite = favorite;
    e.updatedAt = Date.now();
    if (!this.sessionIds.has(id) && !this.persist()) Object.assign(e, before);
    return this.view(e);
  }

  toggleFavorite(id: string): SignatureLibraryEntry | null {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return null;
    return this.setFavorite(id, !e.favorite);
  }

  clear(): void {
    const before = this.entries;
    this.entries = [];
    if (!this.persist()) this.entries = before;
    else this.sessionIds.clear();
  }

  consumeStorageWarning(): string | null {
    const warning = this.warning;
    this.warning = null;
    return warning;
  }

  private view(entry: SignatureLibraryEntry): SignatureLibraryEntry {
    return { ...entry, sessionOnly: this.sessionIds.has(entry.id) };
  }

  private load(): void {
    if (!this.storage) return;
    try {
      this.lastRaw = this.storage.getItem(STORAGE_KEY);
      if (this.lastRaw === null) return;
      const parsed: unknown = JSON.parse(this.lastRaw);
      if (!Array.isArray(parsed) || !parsed.every(e => e && typeof e === 'object' && typeof e.id === 'string' && typeof e.imageDataUrl === 'string')) {
        this.readable = false;
        return;
      }
      this.entries = parsed as SignatureLibraryEntry[];
    } catch {
      this.readable = false;
    }
  }

  private persist(): boolean {
    try {
      if (!this.storage || !this.readable) throw new Error('unavailable');
      if (this.storage.getItem(STORAGE_KEY) !== this.lastRaw) {
        this.warning = 'Signature library changed in another tab. Existing data was preserved; new signatures are available only for this session. Reload before saving other changes.';
        return false;
      }
      const raw = JSON.stringify(this.entries.filter(entry => !this.sessionIds.has(entry.id)));
      this.storage.setItem(STORAGE_KEY, raw);
      this.lastRaw = raw;
      return true;
    } catch {
      this.warning = 'Could not save the signature library on this device. New signatures remain available only for this session; other changes were not saved.';
      return false;
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
