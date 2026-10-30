import { deflateSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFDict, PDFName } from '../types';
import { inlineEncodedLength } from '../content/inline-image-boundary';
import { parseContentStream } from '../content/operator-lexer';
import { zlibEncodedLength } from '../parser/filters';
import { tinyJPEG } from './audit-p1-fixtures';

const bytes = (text: string) => new TextEncoder().encode(text);
const joined = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts.map(x => Buffer.from(x))));
const filtered = (name: string, body: Uint8Array) => joined(bytes(`BI /W 1 /H 1 /BPC 8 /CS /RGB /F /${name} ID `), body, bytes(' EI /Name Q'));

describe('inline image encoded boundaries', () => {
  it.each([0, 1, 6, 9])('locates complete zlib streams at compression level %i and rejects bad checksums', level => {
    const raw = Buffer.from(' EI 1 0 0 rg 0 0 100 100 re f '.repeat(200));
    const compressed = new Uint8Array(deflateSync(raw, { level }));
    const content = filtered('Fl', compressed);
    const instructions = parseContentStream(content);
    expect(instructions.map(item => item.operator)).toEqual(['BI', 'Q']);
    expect(zlibEncodedLength(joined(compressed, bytes(' EI tail')))).toBe(compressed.length);
    const corrupt = compressed.slice(); corrupt[corrupt.length - 1] ^= 1;
    expect(() => parseContentStream(filtered('Fl', corrupt))).toThrow(/checksum/i);
  });

  it('identifies zlib boundaries across multiple sizes and compression strategies', () => {
    for (const size of [0, 1, 13, 101, 1024, 8192]) {
      const raw = new Uint8Array(size);
      let seed = 13;
      for (let i = 0; i < size; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; raw[i] = seed >>> 24; }
      for (const level of [0, 1, 6, 9]) {
        const compressed = new Uint8Array(deflateSync(raw, { level }));
        expect(zlibEncodedLength(joined(compressed, bytes(' EI Q')))).toBe(compressed.length);
      }
    }
  });

  it('skips a fake EI in a JPEG comment segment', () => {
    const jpeg = tinyJPEG();
    const comment = bytes(' EI 1 0 0 rg 0 0 100 100 re f ');
    const jpegWithComment = joined(jpeg.subarray(0, 2), new Uint8Array([0xff, 0xfe, 0, comment.length + 2]), comment, jpeg.subarray(2));
    expect(parseContentStream(filtered('DCT', jpegWithComment)).map(item => item.operator)).toEqual(['BI', 'Q']);
    expect(inlineEncodedLength(new PDFDict([['Filter', new PDFName('DCTDecode')]]), jpegWithComment)).toBe(jpegWithComment.length);
  });

  it.each([
    ['A85', bytes('<~ EI ~>')],
    ['AHx', bytes('ff0000>')],
    ['RL', new Uint8Array([3, 0x20, 0x45, 0x49, 0x20, 128])],
  ])('uses the %s filter terminator instead of false EI bytes', (filter, data) => {
    expect(parseContentStream(filtered(filter, data)).map(item => item.operator)).toEqual(['BI', 'Q']);
  });

  it('bounds malformed zlib decoding in a subprocess', async () => {
    const result = await promisify(execFile)(process.execPath, [
      resolve('node_modules/vite-node/vite-node.mjs'), resolve('src/engine/__tests__/fixtures/inline-zlib-termination-runner.ts'),
    ], { timeout: 10000 });
    expect(result.stdout).toContain('invalid tree rejected');
  }, 15000);
});
