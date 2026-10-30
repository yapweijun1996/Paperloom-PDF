// Local test-only server for the exported site. It does not proxy requests.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { readE2EConfig, verifyStaticExport } from './e2e-static-preflight.mjs';

const root = resolve('out');
const { basePath: prefix, port } = readE2EConfig();
verifyStaticExport(root, prefix);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };

createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400).end(); return; }
  if (prefix && pathname !== prefix && !pathname.startsWith(`${prefix}/`)) { res.writeHead(404).end(); return; }
  const relative = pathname.slice(prefix.length).replace(/^\/+/, '');
  let file = resolve(root, relative || 'index.html');
  if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!statSync(file).isFile()) throw new Error('not a file');
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(file).pipe(res);
  } catch { res.writeHead(404).end(); }
}).listen(port, '127.0.0.1', () => console.log(`Static test server listening on 127.0.0.1:${port}${prefix}/`));
