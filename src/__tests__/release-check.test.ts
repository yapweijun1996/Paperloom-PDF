import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe.skipIf(process.platform === 'win32')('release check orchestration', () => {
  it.each([false, true])('propagates the base path and stops at a failing check: %s', fail => {
    const directory = mkdtempSync(join(tmpdir(), 'paperloom-release-test-'));
    const log = join(directory, 'commands');
    try {
      const npm = join(directory, 'npm');
      writeFileSync(npm, '#!/bin/sh\nprintf "%s|%s\\n" "$*" "$NEXT_PUBLIC_BASE_PATH" >> "$PAPERLOOM_CHECK_LOG"\nif [ "$PAPERLOOM_FAIL_CHECK" = yes ] && [ "$*" = "run lint" ]; then exit 9; fi\n');
      chmodSync(npm, 0o755);
      const result = spawnSync(process.execPath, ['scripts/verify-release.mjs'], {
        cwd: process.cwd(), encoding: 'utf8',
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, NEXT_PUBLIC_BASE_PATH: '/fixture', PAPERLOOM_CHECK_LOG: log, PAPERLOOM_FAIL_CHECK: fail ? 'yes' : 'no' },
      });
      const commands = readFileSync(log, 'utf8').trim().split('\n');
      expect(result.status).toBe(fail ? 9 : 0);
      expect(commands.every(command => command.endsWith('|/fixture'))).toBe(true);
      expect(commands.slice(0, 2)).toEqual(['test|/fixture', 'run lint|/fixture']);
      if (fail) expect(commands).toHaveLength(2);
      else expect(commands.at(-1)).toBe('run verify:browser-core|/fixture');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
