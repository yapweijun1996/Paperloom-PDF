import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readE2EConfig, verifyStaticExport } from './e2e-static-preflight.mjs';

function fixture(t, homePrefix = '', editorPrefix = homePrefix) {
  const root = mkdtempSync(join(tmpdir(), 'paperloom-preflight-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, value] of [['index.html', homePrefix], ['editor/index.html', editorPrefix]]) {
    const path = join(root, name); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `<link rel="preload" href="/brand/example.svg"><script async src="${value}/_next/static/chunks/runtime.js"></script><script defer="" src='${value}/_next/static/chunks/app.js'></script>`);
  }
  mkdirSync(join(root, '_next/static/chunks'), { recursive: true });
  writeFileSync(join(root, '_next/static/chunks/runtime.js'), '/* bootstrap */');
  writeFileSync(join(root, '_next/static/chunks/app.js'), '/* bootstrap */');
  return root;
}

test('normalizes root and one trailing slash, and validates the shared port', () => {
  assert.deepEqual(readE2EConfig({}), { basePath: '', port: 4179 });
  assert.deepEqual(readE2EConfig({ NEXT_PUBLIC_BASE_PATH: '/', PAPERLOOM_E2E_PORT: '4241' }), { basePath: '', port: 4241 });
  assert.deepEqual(readE2EConfig({ NEXT_PUBLIC_BASE_PATH: '/one/sub.path/' }), { basePath: '/one/sub.path', port: 4179 });
  for (const value of ['relative', '//foo', '/a//b', '/a/../b', '/a/./b', '/a?b', '/a#b', '/a%2Fb', 'https://host/x', '/a//']) {
    assert.throws(() => readE2EConfig({ NEXT_PUBLIC_BASE_PATH: value }), /base path/i, value);
  }
  for (const value of ['0', '65536', '-1', '1e2', '4.2', 'abc', ' 42']) {
    assert.throws(() => readE2EConfig({ PAPERLOOM_E2E_PORT: value }), /port/i, value);
  }
});

test('accepts complete copied root and nested-subpath exports independently of asset order', t => {
  for (const base of ['', '/Paperloom-PDF', '/one/sub.path']) verifyStaticExport(fixture(t, base), base);
});

test('fails both directions of a build and test base-path mismatch', t => {
  assert.throws(() => verifyStaticExport(fixture(t, ''), '/Paperloom-PDF'), /base path/i);
  assert.throws(() => verifyStaticExport(fixture(t, '/Paperloom-PDF'), ''), /base path/i);
});

test('rejects different prefixes between pages and mixed scripts within a page', t => {
  assert.throws(() => verifyStaticExport(fixture(t, '', '/app'), ''), /base path/i);
  const root = fixture(t, '/app');
  writeFileSync(join(root, 'index.html'), '<script src="/app/_next/static/chunks/runtime.js"></script><script src="/_next/static/chunks/app.js"></script>');
  assert.throws(() => verifyStaticExport(root, '/app'), /base path/i);
});

test('rejects missing page, bootstrap scripts, and referenced chunks', t => {
  const root = fixture(t); rmSync(join(root, 'editor/index.html'));
  assert.throws(() => verifyStaticExport(root, ''), /editor\/index\.html/i);
  const noScripts = fixture(t); writeFileSync(join(noScripts, 'index.html'), `<script data-src="/_next/static/chunks/runtime.js"></script><script data-example=" src='/_next/static/chunks/runtime.js'"></script><script>const fake = "<script src='/_next/static/chunks/runtime.js'>";</script><script src="/brand/other.js"></script>`);
  assert.throws(() => verifyStaticExport(noScripts, ''), /bootstrap/i);
  const missing = fixture(t); rmSync(join(missing, '_next/static/chunks/app.js'));
  assert.throws(() => verifyStaticExport(missing, ''), /chunk|asset/i);
  assert.throws(() => verifyStaticExport(join(root, 'absent'), ''), /index\.html/i);
});

test('does not accept a remote or protocol-relative Next bootstrap', t => {
  const root = fixture(t);
  for (const url of ['https://example.com/_next/static/chunks/app.js', '//example.com/_next/static/chunks/app.js']) {
    writeFileSync(join(root, 'index.html'), `<script src="${url}"></script>`);
    assert.throws(() => verifyStaticExport(root, ''), /bootstrap|asset|base path/i);
  }
});


test('rejects an empty referenced bootstrap file', t => {
  const root = fixture(t);
  writeFileSync(join(root, '_next/static/chunks/app.js'), '');
  assert.throws(() => verifyStaticExport(root, ''), /empty|asset/i);
});

test('ignores inert scripts in templates, noscript and non-executable script types', t => {
  for (const element of [
    '<template><script src="/_next/static/chunks/app.js"></script></template>',
    '<noscript><script src="/_next/static/chunks/app.js"></script></noscript>',
    '<script type="application/json" src="/_next/static/chunks/app.js"></script>',
    '<script nomodule src="/_next/static/chunks/app.js"></script>',
  ]) {
    const root = fixture(t);
    writeFileSync(join(root, 'index.html'), element);
    assert.throws(() => verifyStaticExport(root, ''), /bootstrap/i, element);
  }
});

test('accepts standard executable javascript and module scripts', t => {
  const root = fixture(t);
  writeFileSync(join(root, 'index.html'), '<script type="text/javascript" src="/_next/static/chunks/app.js"></script><script type="module" src="/_next/static/chunks/runtime.js"></script>');
  verifyStaticExport(root, '');
});
