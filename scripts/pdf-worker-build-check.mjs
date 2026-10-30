import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

const requiredCommands = ['PARSE_PDF', 'SAVE_PDF', 'OPTIMIZE_PDF'];

/** Find the worker referenced by a client chunk actually loaded by the editor. */
export function findBuiltWorker(root) {
  const out = join(root, 'out');
  const html = readFileSync(join(out, 'editor', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)]
    .map(match => match[1]);
  const files = scripts.map(source => {
    const url = new URL(source, 'https://paperloom.invalid');
    const marker = '/_next/static/chunks/';
    const at = url.pathname.indexOf(marker);
    if (url.origin !== 'https://paperloom.invalid' || at < 0) return null;
    return { source, path: join(out, url.pathname.slice(at + 1)), prefix: url.pathname.slice(0, at) };
  }).filter(Boolean);
  const runtime = files.filter(file => /\/webpack-[^/]+\.js$/.test(file.path));
  if (!runtime.length) throw new Error('editor export does not load a webpack runtime');
  const runtimes = runtime.map(file => readFileSync(file.path, 'utf8'));
  const candidates = [];
  for (const file of files) {
    const text = readFileSync(file.path, 'utf8');
    if (!requiredCommands.every(command => text.includes(command))) continue;
    // Next's webpack worker loader constructs a chunk URL through p + u(id).
    const regex = /new\s+Worker\(\s*(?:[\w$]+\.tu\()?new\s+URL\(\s*([\w$]+)\.p\s*\+\s*\1\.u\((\d+)\)\s*,\s*\1\.b\s*\)/g;
    for (const match of text.matchAll(regex)) {
      const id = match[2];
      const name = new RegExp(`^${id}\\.([a-fA-F0-9]+)\\.js$`);
      const dir = join(out, '_next', 'static', 'chunks');
      for (const filename of readdirSync(dir)) {
        const hash = filename.match(name)?.[1];
        if (!hash) continue;
        const entry = new RegExp(`(?:^|[,{])${id}:["']${hash}["']`);
        if (runtimes.some(runtimeText => entry.test(runtimeText))) {
          candidates.push({ path: join(dir, filename), publicPath: `${file.prefix}/_next/static/chunks/${filename}` });
        }
      }
    }
  }
  if (candidates.length !== 1) throw new Error(`editor must reference exactly one compiled PDF worker; found ${candidates.length}`);
  return candidates[0];
}

function samplePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += 'xref\n0 4\n0000000000 65535 f \n';
  pdf += offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

/** Execute webpack's emitted worker with local importScripts and test its protocol.
 * This is a Node simulation, not a substitute for a real browser worker check. */
export async function smokeBuiltWorker(root, worker) {
  const origin = 'https://paperloom.invalid';
  const posts = [];
  const sandbox = {
    console, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView, URL,
    Blob, Response, Request, Headers, crypto: webcrypto, performance,
    setTimeout, clearTimeout, queueMicrotask, atob, btoa, AbortController,
    ReadableStream, TransformStream,
    location: { href: origin + worker.publicPath },
    postMessage: value => posts.push(value),
    fetch: () => { throw new Error('network access is unavailable in the PDF worker smoke test'); },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const context = createContext(sandbox);
  sandbox.importScripts = (...urls) => {
    for (const url of urls) {
      const parsed = new URL(url, sandbox.location.href);
      const marker = '/_next/static/';
      const at = parsed.pathname.indexOf(marker);
      if (parsed.origin !== origin || at < 0) throw new Error('worker imports a non-local static asset');
      const file = join(root, 'out', parsed.pathname.slice(at + 1));
      runInContext(readFileSync(file, 'utf8'), context, { filename: file, timeout: 1000 });
    }
  };
  runInContext(readFileSync(worker.path, 'utf8'), context, { filename: worker.path, timeout: 1000 });
  // Webpack can register the handler after asynchronously loading its chunks.
  const deadline = Date.now() + 3000;
  while (typeof sandbox.onmessage !== 'function') {
    if (Date.now() >= deadline) throw new Error('compiled PDF worker did not register a message handler');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  async function send(command) {
    sandbox.testCommand = command;
    const promise = runInContext('self.onmessage({data: testCommand})', context, { timeout: 1000 });
    let timer;
    try {
      await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('compiled PDF worker command timed out')), 3000); })]);
    } finally { clearTimeout(timer); }
    const response = posts.shift();
    if (!response || response.requestId !== command.requestId) throw new Error('compiled PDF worker returned no matching response');
    return response;
  }
  const invalid = await send({ type: 'INVALID_COMMAND', requestId: 1 });
  if (invalid.type !== 'ERROR' || !/Unknown PDF worker command/.test(invalid.error?.message ?? '')) throw new Error('compiled PDF worker does not reject unknown commands');
  const parsed = await send({ type: 'PARSE_PDF', requestId: 2, bytes: samplePdf() });
  if (parsed.type !== 'RESULT' || parsed.document?.pages?.length !== 1) throw new Error('compiled PDF worker could not parse the smoke fixture');
  const saved = await send({ type: 'SAVE_PDF', requestId: 3, document: parsed.document });
  if (saved.type !== 'RESULT' || !saved.bytes?.length) throw new Error('compiled PDF worker could not save the smoke fixture');
  const reopened = await send({ type: 'PARSE_PDF', requestId: 4, bytes: saved.bytes });
  if (reopened.type !== 'RESULT' || reopened.document?.pages?.length !== 1) throw new Error('compiled PDF worker could not reopen the saved fixture');
  const optimized = await send({ type: 'OPTIMIZE_PDF', requestId: 5, document: parsed.document });
  if (optimized.type !== 'RESULT' || !optimized.bytes?.length) throw new Error('compiled PDF worker could not optimize the smoke fixture');
  const reoptimized = await send({ type: 'PARSE_PDF', requestId: 6, bytes: optimized.bytes });
  if (reoptimized.type !== 'RESULT' || reoptimized.document?.pages?.length !== 1) throw new Error('compiled PDF worker could not reopen the optimized fixture');
}
