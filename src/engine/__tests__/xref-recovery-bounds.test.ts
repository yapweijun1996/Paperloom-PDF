import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

describe('xref recovery bounds', () => {
  it('handles large recovery maps and zero-count ranges within a memory and time limit', async () => {
    const execute = promisify(execFile);
    const result = await execute(process.execPath, [
      '--max-old-space-size=256', resolve('node_modules/vite-node/vite-node.mjs'),
      resolve('src/engine/__tests__/fixtures/xref-recovery-bounds-runner.ts'),
    ], { timeout: 15000, maxBuffer: 1024 * 1024 });
    expect(result.stdout).toContain('xref recovery bounds passed');
  }, 20000);
});
