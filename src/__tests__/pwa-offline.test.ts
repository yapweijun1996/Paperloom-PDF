import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
function prepareExport(root: string, basePath = '') {
  execFileSync(process.execPath, [join(process.cwd(), 'scripts/prepare-pwa.mjs')], {
    cwd: root, env: { ...process.env, NEXT_PUBLIC_BASE_PATH: basePath }, stdio: 'pipe',
  });
}
function makeExport(basePath = '') {
  const root = mkdtempSync(join(tmpdir(), 'paperloom-pwa-')); roots.push(root);
  for (const directory of ['scripts', 'out/editor', 'out/_next/static/chunks', 'out/fonts', 'out/ocr-assets']) mkdirSync(join(root, directory), { recursive: true });
  copyFileSync(join(process.cwd(), 'scripts/pwa-worker-template.js'), join(root, 'scripts/pwa-worker-template.js'));
  for (const [name, content] of Object.entries({
    'out/index.html': 'home', 'out/editor/index.html': 'editor', 'out/_next/static/chunks/editor.js': 'editor code',
    'out/fonts/test.ttf': 'font', 'out/icon-192.png': 'icon', 'out/icon-512.png': 'icon', 'out/icon.png': 'icon', 'out/apple-icon.png': 'apple icon',
    'out/ocr-assets/worker.min.js': 'worker', 'out/ocr-assets/eng.traineddata.gz': 'model',
    'out/ocr-assets/tesseract-core-lstm.wasm.js': 'core', 'out/ocr-assets/tesseract-core-simd-lstm.wasm.js': 'simd',
    'out/ocr-assets/tesseract-core-relaxedsimd-lstm.wasm.js': 'relaxed simd', 'out/ocr-assets/private.pdf': 'private',
    'out/private.pdf': 'not an application asset', 'out/fonts/private.pdf': 'never precache PDFs',
  })) writeFileSync(join(root, name), content);
  prepareExport(root, basePath);
  return root;
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('offline static export', () => {
  it('refuses to generate an incomplete offline OCR cache', () => {
    const root = makeExport();
    rmSync(join(root, 'out/ocr-assets/worker.min.js'));
    expect(() => prepareExport(root)).toThrow();
  });

  it('changes the cache version when built assets change and remains stable otherwise', () => {
    const root = makeExport();
    const worker = () => readFileSync(join(root, 'out/sw.js'), 'utf8');
    const original = worker();
    prepareExport(root);
    expect(worker()).toBe(original);
    writeFileSync(join(root, 'out/_next/static/chunks/editor.js'), 'changed editor code');
    prepareExport(root);
    expect(worker()).not.toBe(original);
    const updated = worker();
    writeFileSync(join(root, 'scripts/pwa-worker-template.js'), `${readFileSync(join(root, 'scripts/pwa-worker-template.js'), 'utf8')}\n// updated worker\n`);
    prepareExport(root);
    expect(worker().match(/const CACHE_NAME = ([^;]+);/)?.[1]).not.toBe(updated.match(/const CACHE_NAME = ([^;]+);/)?.[1]);
  });

  it('keeps the active cache if installation of an updated worker fails', async () => {
    const root = makeExport();
    const workerFile = join(root, 'out/sw.js');
    const cacheName = (source: string) => JSON.parse(source.match(/const CACHE_NAME = ([^;]+);/)![1]) as string;
    const original = cacheName(readFileSync(workerFile, 'utf8'));
    const templateFile = join(root, 'scripts/pwa-worker-template.js');
    writeFileSync(templateFile, `${readFileSync(templateFile, 'utf8')}\n// worker revision\n`);
    prepareExport(root);
    const updated = readFileSync(workerFile, 'utf8');
    expect(cacheName(updated)).not.toBe(original);
    const names = new Set([original]);
    const caches = {
      open: async (name: string) => { names.add(name); return { addAll: async () => { throw new Error('network failure'); } }; },
      delete: async (name: string) => names.delete(name),
    };
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const self = { addEventListener: (name: string, callback: (event: Record<string, unknown>) => void) => listeners.set(name, callback) };
    runInNewContext(updated, { self, caches, URL, Set });
    let installation: Promise<unknown> | undefined;
    listeners.get('install')!({ waitUntil: (promise: Promise<unknown>) => { installation = promise; } });
    await expect(installation).rejects.toThrow('network failure');
    expect([...names]).toEqual([original]);
  });

  it.each(['', '/Paperloom-PDF'])('generates an isolated manifest and offline app shell for %s', async base => {
    const root = makeExport(base);
    const manifest = JSON.parse(readFileSync(join(root, 'out/manifest.webmanifest'), 'utf8'));
    expect(manifest.scope).toBe(`${base}/`);
    expect(manifest.start_url).toBe(`${base}/`);
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const stored = new Map<string, unknown>();
    const cache = {
      addAll: async (paths: string[]) => { for (const path of paths) stored.set(path, `cached:${path}`); },
      match: async (path: string) => stored.get(path),
    };
    const caches = { open: async () => cache, keys: async () => [], delete: async () => true };
    const fallback = async () => 'network';
    const self = { location: { origin: 'https://example.test' }, clients: { claim: async () => {} }, addEventListener: (name: string, callback: (event: Record<string, unknown>) => void) => listeners.set(name, callback) };
    runInNewContext(readFileSync(join(root, 'out/sw.js'), 'utf8'), { self, caches, URL, fetch: fallback, Set });
    let installation: Promise<unknown> | undefined;
    listeners.get('install')!({ waitUntil: (promise: Promise<unknown>) => { installation = promise; } });
    await installation;
    expect(stored.has(`${base}/private.pdf`)).toBe(false);
    expect(stored.has(`${base}/fonts/private.pdf`)).toBe(false);
    expect(stored.has(`${base}/fonts/test.ttf`)).toBe(true);
    expect(stored.has(`${base}/ocr-assets/worker.min.js`)).toBe(true);
    expect(stored.has(`${base}/ocr-assets/eng.traineddata.gz`)).toBe(true);
    expect(stored.has(`${base}/ocr-assets/tesseract-core-lstm.wasm.js`)).toBe(true);
    expect(stored.has(`${base}/ocr-assets/tesseract-core-simd-lstm.wasm.js`)).toBe(true);
    expect(stored.has(`${base}/ocr-assets/tesseract-core-relaxedsimd-lstm.wasm.js`)).toBe(true);
    expect(stored.has(`${base}/ocr-assets/private.pdf`)).toBe(false);
    expect(stored.has(`${base}/apple-icon.png`)).toBe(true);
    expect(stored.has(`${base}/icon.png`)).toBe(true);
    let response: Promise<unknown> | undefined;
    listeners.get('fetch')!({ request: { method: 'GET', mode: 'navigate', url: `https://example.test${base}/editor/` }, respondWith: (promise: Promise<unknown>) => { response = promise; } });
    expect(await response).toBe(`cached:${base}/editor/index.html`);
    response = undefined;
    listeners.get('fetch')!({ request: { method: 'GET', mode: 'navigate', url: `https://example.test${base}/private.pdf` }, respondWith: (promise: Promise<unknown>) => { response = promise; } });
    expect(response).toBeUndefined();
    listeners.get('fetch')!({ request: { method: 'GET', mode: 'cors', url: 'https://external.test/private.pdf' }, respondWith: (promise: Promise<unknown>) => { response = promise; } });
    expect(response).toBeUndefined();
    expect(existsSync(join(root, 'out/sw.js'))).toBe(true);
  });
});
