import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDict, PDFNumber, type XRefTable } from '../types';
import { assertXrefProvenance, assertXrefProvenanceAsync, bindXrefProvenance,
  bindXrefProvenanceAsync, bindXrefProvenanceWithRawDigest, xrefProvenanceDigest } from '../parser/xref-provenance';

function fixture() {
  const raw = new Uint8Array([37, 80, 68, 70, 10, 42]);
  const xref: XRefTable = { entries: new Map([['1_0', { objNum: 1, genNum: 0, offset: 5, type: 'n' }]]),
    trailerDict: new PDFDict([['Size', new PDFNumber(2)]]) };
  return { raw, xref };
}

function holdCrypto() {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const active = new Promise<void>(resolve => { started = resolve; });
  const digest = vi.fn(async (_algorithm: AlgorithmIdentifier, data: BufferSource) => {
    started();
    await gate;
    return webcrypto.subtle.digest('SHA-256', data as globalThis.BufferSource);
  });
  vi.stubGlobal('crypto', { subtle: { digest } });
  return { active, release, digest };
}

afterEach(() => vi.unstubAllGlobals());

describe('xref provenance asynchronous verification', () => {
  it('binds and verifies both source and graph using native SHA-256', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const { raw, xref } = fixture();
    await bindXrefProvenanceAsync(raw, xref, 'strict');
    expect(xref.provenance?.rawDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(await assertXrefProvenanceAsync(raw, xref)).toBe(true);
    expect(() => assertXrefProvenance(raw, xref)).not.toThrow();
    const copy = { ...xref, trailerDict: new PDFDict([...xref.trailerDict.entries()]) };
    bindXrefProvenanceWithRawDigest(copy, 'strict', xref.provenance!.rawDigest!);
    expect(() => assertXrefProvenance(raw, copy)).not.toThrow();
  });

  it.each(['bytes', 'entry', 'trailer', 'source', 'proof'] as const)(
    'rejects a %s change while native verification awaits', async change => {
      const { raw, xref } = fixture();
      bindXrefProvenance(raw, xref, 'strict');
      const gate = holdCrypto();
      const pending = assertXrefProvenanceAsync(raw, xref);
      await gate.active;
      if (change === 'bytes') raw[1] ^= 1;
      if (change === 'entry') xref.entries.get('1_0')!.offset++;
      if (change === 'trailer') xref.trailerDict.set('Size', new PDFNumber(3));
      if (change === 'source') xref.provenance!.source = 'conservative';
      if (change === 'proof') xref.provenance!.rawDigest = 'changed';
      gate.release();
      await expect(pending).rejects.toThrow(/changed|conflicts/i);
    },
  );

  it.each(['bytes', 'entry', 'trailer', 'proof'] as const)(
    'does not publish a binding when %s changes during hashing', async change => {
      const { raw, xref } = fixture();
      const gate = holdCrypto();
      const pending = bindXrefProvenanceAsync(raw, xref, 'strict');
      await gate.active;
      if (change === 'bytes') raw[0] ^= 1;
      if (change === 'entry') xref.entries.get('1_0')!.offset++;
      if (change === 'trailer') xref.trailerDict.set('Size', new PDFNumber(3));
      if (change === 'proof') xref.provenance = { source: 'strict', digest: 'other' };
      gate.release();
      await expect(pending).rejects.toThrow(/changed/i);
      expect(xref.provenance).toEqual(change === 'proof' ? { source: 'strict', digest: 'other' } : undefined);
    },
  );

  it('preserves legacy proof verification and falls back when WebCrypto is unavailable', async () => {
    const { raw, xref } = fixture();
    xref.provenance = { source: 'strict', digest: xrefProvenanceDigest(raw, xref.entries, xref.trailerDict, 'strict') };
    vi.stubGlobal('crypto', undefined);
    expect(await assertXrefProvenanceAsync(raw, xref)).toBe(true);
    await bindXrefProvenanceAsync(raw, xref, 'strict');
    expect(await assertXrefProvenanceAsync(raw, xref)).toBe(true);
    raw[0] ^= 1;
    await expect(assertXrefProvenanceAsync(raw, xref)).rejects.toThrow(/conflicts/);
  });

  it('accepts an isolated parse snapshot only while it matches the mutable source', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const { raw, xref } = fixture();
    const snapshot = new Uint8Array(raw);
    await bindXrefProvenanceAsync(raw, xref, 'strict', snapshot);
    expect(await assertXrefProvenanceAsync(raw, xref)).toBe(true);
    raw[0] ^= 1;
    await expect(bindXrefProvenanceAsync(raw, xref, 'strict', snapshot)).rejects.toThrow(/changed/);
    await expect(bindXrefProvenanceAsync(raw, xref, 'strict', raw)).rejects.toThrow(/changed/);
  });

  it('hashes exactly a non-zero-offset view instead of its entire backing buffer', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const { xref } = fixture();
    const raw = new Uint8Array([9, 1, 2, 3, 4, 5, 8]).subarray(1, 6);
    const snapshot = new Uint8Array([7, 1, 2, 3, 4, 5, 6]).subarray(1, 6);
    await bindXrefProvenanceAsync(raw, xref, 'strict', snapshot);
    expect(await assertXrefProvenanceAsync(raw, xref)).toBe(true);
    expect(() => assertXrefProvenance(raw, xref)).not.toThrow();
  });

  it('rejects shared source memory whose contents can change on another thread', async () => {
    const { xref } = fixture();
    const raw = new Uint8Array(new SharedArrayBuffer(8));
    expect(() => bindXrefProvenance(raw, xref, 'strict')).toThrow(/shared PDF source/);
    await expect(bindXrefProvenanceAsync(raw, xref, 'strict')).rejects.toThrow(/shared PDF source/);
  });
});
