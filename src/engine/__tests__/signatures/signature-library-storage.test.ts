import { describe, expect, it } from 'vitest';
import { SignatureLibrary } from '../../signatures/visual/library';

const key = 'bloom-pdf-signature-library-v1';
const signature = { name: 'Test', source: 'typed' as const, imageDataUrl: 'data:image/png;base64,abc', width: 100, height: 40 };

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => { values.set(k, v); },
    removeItem: (k: string) => { values.delete(k); },
    clear: () => values.clear(), key: () => null, length: 0,
  } as Storage;
}

describe('visual signature library storage', () => {
  it('keeps existing device entries and excludes session entries from later writes and reopen', () => {
    const disk = storage();
    const first = new SignatureLibrary(disk);
    const old = first.add(signature);
    const rawBefore = disk.getItem(key);
    const reopened = new SignatureLibrary(disk);
    const session = reopened.add({ ...signature, name: 'Private', sessionOnly: true });
    expect(disk.getItem(key)).toBe(rawBefore);
    reopened.add({ ...signature, name: 'Device' });
    expect(disk.getItem(key)).not.toContain('Private');
    expect(reopened.get(session.id)?.sessionOnly).toBe(true);
    const afterReload = new SignatureLibrary(disk);
    expect(afterReload.get(old.id)?.name).toBe('Test');
    expect(afterReload.list().map(entry => entry.name)).toEqual(['Device', 'Test']);
  });

  it('warns and retains a new signature in memory when storage fails', () => {
    const disk = storage();
    const original = new SignatureLibrary(disk).add(signature);
    const before = disk.getItem(key);
    const broken = { ...disk, setItem: () => { throw new Error('quota'); } } as Storage;
    const library = new SignatureLibrary(broken);
    const created = library.add({ ...signature, name: 'New' });
    expect(created.sessionOnly).toBe(true);
    expect(library.consumeStorageWarning()).toContain('Could not save');
    expect(library.delete(original.id)).toBe(false);
    expect(library.get(original.id)).not.toBeNull();
    expect(library.consumeStorageWarning()).toContain('Could not save');
    expect(disk.getItem(key)).toBe(before);
  });

  it('does not overwrite corrupt or externally changed stored data', () => {
    const disk = storage();
    disk.setItem(key, '{broken');
    const library = new SignatureLibrary(disk);
    expect(library.add(signature).sessionOnly).toBe(true);
    expect(library.consumeStorageWarning()).toContain('Could not save');
    expect(disk.getItem(key)).toBe('{broken');
    disk.removeItem(key);
    const first = new SignatureLibrary(disk);
    const other = new SignatureLibrary(disk);
    first.add(signature);
    expect(other.add({ ...signature, name: 'Other' }).sessionOnly).toBe(true);
    expect(other.consumeStorageWarning()).toContain('another tab');
    expect(new SignatureLibrary(disk).list().map(e => e.name)).toEqual(['Test']);
  });
});
