import { readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { parse } from 'parse5';

/** Keep the browser URL and the static server on the same validated settings. */
export function readE2EConfig(env = process.env) {
  const raw = env.NEXT_PUBLIC_BASE_PATH ?? '';
  const basePath = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  if (basePath && (!/^\/(?:[A-Za-z0-9._~-]+)(?:\/[A-Za-z0-9._~-]+)*$/.test(basePath) ||
      basePath.split('/').some(part => part === '.' || part === '..'))) {
    throw new Error('Invalid E2E base path (NEXT_PUBLIC_BASE_PATH): expected an absolute URL path.');
  }
  const portText = env.PAPERLOOM_E2E_PORT || '4179';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid PAPERLOOM_E2E_PORT: expected an integer from 1 to 65535.');
  }
  return { basePath, port };
}

// Templates and noscript content are inert in the browser; parse5 keeps their
// content out of ordinary child nodes when scripting is enabled.
function executableScriptSources(node, sources = []) {
  if (node.tagName === 'script') {
    const attrs = new Map(node.attrs.map(({ name, value }) => [name, value]));
    const type = (attrs.get('type') ?? '').trim().toLowerCase();
    const javascript = type === '' || type === 'module' || /^(?:text|application)\/(?:x-)?(?:javascript|ecmascript)(?:\s*;.*)?$/.test(type);
    if (javascript && !attrs.has('nomodule') && attrs.has('src')) sources.push(attrs.get('src'));
  }
  for (const child of node.childNodes ?? []) executableScriptSources(child, sources);
  return sources;
}

/** Check the actual Next bootstrap references, not a separately generated manifest. */
export function verifyStaticExport(output, basePath) {
  const root = resolve(output);
  for (const page of ['index.html', 'editor/index.html']) {
    let html;
    try { html = readFileSync(resolve(root, page), 'utf8'); }
    catch { throw new Error(`E2E static export is missing ${page}; rebuild with the same NEXT_PUBLIC_BASE_PATH used for tests.`); }
    let count = 0;
    for (const src of executableScriptSources(parse(html))) {
      let url;
      try { url = new URL(src, 'http://127.0.0.1'); } catch { continue; }
      const marker = '/_next/static/';
      const at = url.pathname.indexOf(marker);
      if (at < 0) continue;
      if (!src.startsWith('/') || src.startsWith('//') || url.origin !== 'http://127.0.0.1' || url.pathname.slice(0, at) !== basePath) {
        throw new Error(`E2E static export base path mismatch in ${page}; rebuild with the same NEXT_PUBLIC_BASE_PATH used for tests.`);
      }
      const path = resolve(root, url.pathname.slice(basePath.length + 1));
      if (!path.startsWith(root + sep)) throw new Error(`Invalid E2E bootstrap asset in ${page}.`);
      let asset;
      try { asset = statSync(path); }
      catch { throw new Error(`E2E bootstrap asset is missing in ${page}; rebuild the static export.`); }
      if (!asset.isFile()) throw new Error(`E2E bootstrap asset is not a file in ${page}; rebuild the static export.`);
      if (asset.size === 0) throw new Error(`E2E bootstrap asset is empty in ${page}; rebuild the static export.`);
      count++;
    }
    if (!count) throw new Error(`E2E static export has no Next bootstrap scripts in ${page}; rebuild the static export.`);
  }
}
