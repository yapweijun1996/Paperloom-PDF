import { deflateRawSync, deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyFilters } from '../parser/filters';

afterEach(() => vi.unstubAllGlobals());

describe.each(['native and fallback', 'manual only'])('stored deflate blocks (%s)', mode => {
  function prepare() { if (mode === 'manual only') vi.stubGlobal('DecompressionStream', undefined); }
  it.each([
    new Uint8Array([1, 2, 3]),
    new Uint8Array([1, 2, 0, 0, 0, 65, 66]),
    new Uint8Array([1, 3, 0, 0xfc, 0xff, 65]),
  ])('rejects a truncated or invalid block instead of fabricating bytes', async input => {
    prepare();
    await expect(applyFilters(input, ['FlateDecode'], [])).rejects.toThrow(/deflate/i);
  });
  it.each([deflateRawSync, deflateSync])('continues to decode valid stored blocks', async deflate => {
    prepare();
    const input = Buffer.from('valid stored block');
    await expect(applyFilters(new Uint8Array(deflate(input, { level: 0 })), ['FlateDecode'], [])).resolves.toEqual(new Uint8Array(input));
  });
});
