import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeZlibFully } from '../parser/filters';

describe('verified complete zlib decoding', () => {
  it.each([0, 1, 6, 9])('matches independent zlib streams at compression level %i', level => {
    for (const size of [0, 1, 127, 1024, 65536]) {
      const source = Uint8Array.from({ length: size }, (_, i) => (i * 73 + (i >>> 3)) & 255);
      const compressed = deflateSync(source, { level });
      expect(decodeZlibFully(compressed, source.length)).toEqual(source);
    }
  });

  it('rejects a bad checksum, truncated input, extra bytes, and expansion over the limit', () => {
    const compressed = new Uint8Array(deflateSync(Buffer.alloc(500, 65)));
    const corrupt = compressed.slice();
    corrupt[corrupt.length - 1] ^= 1;
    expect(() => decodeZlibFully(corrupt, 500)).toThrow();
    expect(() => decodeZlibFully(compressed.slice(0, -1), 500)).toThrow();
    expect(() => decodeZlibFully(Uint8Array.from([...compressed, 0]), 500)).toThrow();
    expect(() => decodeZlibFully(compressed, 499)).toThrow(/limit/i);
  });
});
