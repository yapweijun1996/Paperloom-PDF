import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { parseXrefStream } from '../parser/xref';
import { parsePDF } from '../parser/parser';

function stream(dict: string, contents: number[]): Uint8Array {
  const prefix = new TextEncoder().encode(`1 0 obj\n<< /Type /XRef ${dict} /Length ${contents.length} >>\nstream\n`);
  const suffix = new TextEncoder().encode('\nendstream\nendobj\n');
  const result = new Uint8Array(prefix.length + contents.length + suffix.length);
  result.set(prefix);
  result.set(contents, prefix.length);
  result.set(suffix, prefix.length + contents.length);
  return result;
}

describe('cross-reference stream bounds', () => {
  it('terminates malformed large declarations within a subprocess deadline', async () => {
    const execute = promisify(execFile);
    const result = await execute(process.execPath, [
      resolve('node_modules/vite-node/vite-node.mjs'),
      resolve('src/engine/__tests__/fixtures/xref-stream-bounds-runner.ts'),
    ], { timeout: 5000, maxBuffer: 1024 * 1024 });
    expect(result.stdout).toContain('xref stream bounds passed');
  }, 10000);

  it('parses valid large unsigned offsets without signed 32-bit truncation', async () => {
    const parsed = await parseXrefStream(stream('/Size 1 /W [1 4 2]', [1, 0x80, 0, 0, 5, 0, 0]), 0);
    expect(parsed.entries.get('0_0')?.offset).toBe(2147483653);
  });

  it('accepts legal default fields and indexed subsections', async () => {
    const parsed = await parseXrefStream(stream('/Size 8 /W [0 1 0] /Index [1 2 5 1]', [7, 8, 9]), 0);
    expect([...parsed.entries.values()].map(entry => [entry.objNum, entry.offset])).toEqual([[1, 7], [2, 8], [5, 9]]);
    const zero = await parseXrefStream(stream('/Size 2 /W [0 0 0]', []), 0);
    expect(zero.entries.size).toBe(2);
  });

  it('refuses unsafe field values rather than silently rounding them', async () => {
    const bytes = stream('/Size 1 /W [1 8 0]', [1, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    await expect(parseXrefStream(bytes, 0)).rejects.toThrow(/xref.*integer/i);
  });

  it('propagates an excessive entry limit through the public PDF parser', async () => {
    const prefix = '%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
      '2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n';
    const body = `3 0 obj\n<< /Type /XRef /Root 1 0 R /Size 250001 /W [0 0 0] /Length 0 >>\nstream\n\nendstream\nendobj\nstartxref\n${prefix.length}\n%%EOF\n`;
    await expect(parsePDF(new TextEncoder().encode(prefix + body))).rejects.toThrow(/xref stream.*entry limit/i);
  });
});
