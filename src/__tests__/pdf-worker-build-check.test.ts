import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { findBuiltWorker, smokeBuiltWorker } from '../../scripts/pdf-worker-build-check.mjs';

let root: string | undefined;
function write(relative: string, content: string) {
  const file = join(root!, 'out', relative);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
}
function editorFixture({ worker = 'self.onmessage = () => {};', base = '' }: { worker?: string; base?: string } = {}) {
  root = mkdtempSync(join(tmpdir(), 'paperloom-worker-guard-'));
  write('editor/index.html', `<script src="${base}/_next/static/chunks/webpack-abc.js"></script><script src="${base}/_next/static/chunks/client.js"></script>`);
  write('_next/static/chunks/webpack-abc.js', 'const hashes={495:"aabbcc"};');
  write('_next/static/chunks/client.js', 'new Worker(r.tu(new URL(r.p+r.u(495),r.b)),{}); "PARSE_PDF SAVE_PDF OPTIMIZE_PDF";');
  write('_next/static/chunks/495.aabbcc.js', worker);
}
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

describe('built PDF worker guard', () => {
  it('rejects a fake, unreferenced file containing the old markers', () => {
    root = mkdtempSync(join(tmpdir(), 'paperloom-worker-guard-'));
    write('fake.js', 'PARSE_PDF self.onmessage');
    expect(() => findBuiltWorker(root!)).toThrow();
  });

  it('fails the real CI guard when out contains only a two-marker fake', () => {
    const project = process.cwd();
    root = mkdtempSync(join(tmpdir(), 'paperloom-worker-guard-'));
    for (const file of ['package.json', 'docs/PDF_WORKER.md', 'src/engine/browser-core.ts',
      'src/engine/worker/codec.ts', 'src/engine/worker/protocol.ts', 'src/engine/worker/pdf.worker.ts',
      'src/engine/worker/client.ts', 'src/engine/worker/handler.ts']) {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(project, file), target);
    }
    write('fake.js', 'PARSE_PDF self.onmessage');
    const result = spawnSync(process.execPath, [join(project, 'scripts/verify-pdf-worker.mjs')], {
      cwd: root, env: { ...process.env, CI: 'true' }, encoding: 'utf8', timeout: 5000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/editor|ENOENT/i);
  });

  it('rejects a worker chunk not referenced by the editor runtime', () => {
    editorFixture();
    write('_next/static/chunks/webpack-abc.js', 'const hashes={495:"another"};');
    expect(() => findBuiltWorker(root!)).toThrow(/exactly one/);
  });

  it('rejects a worker which contains markers but cannot parse a PDF', async () => {
    editorFixture({ worker: `// PARSE_PDF self.onmessage
      self.onmessage = async e => self.postMessage({type:'ERROR', requestId:e.data.requestId,
        error:{message:'Unknown PDF worker command'}});` });
    const worker = findBuiltWorker(root!);
    await expect(smokeBuiltWorker(root!, worker)).rejects.toThrow(/could not parse/);
  });

  it('rejects a worker with a missing imported dependency', async () => {
    editorFixture({ worker: 'importScripts("/_next/static/chunks/missing.js");' });
    await expect(smokeBuiltWorker(root!, findBuiltWorker(root!))).rejects.toThrow();
  });

  it('resolves the worker under a non-root base path', () => {
    editorFixture({ base: '/paperloom' });
    expect(findBuiltWorker(root!).publicPath).toBe('/paperloom/_next/static/chunks/495.aabbcc.js');
  });
});
