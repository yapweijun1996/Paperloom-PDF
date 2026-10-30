/** Compare cooperative search with a forced synchronous fallback on a synthetic scan PDF. */
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);
let pages = 40, samples = 3;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--pages') pages = Number(process.argv[++i]);
  else if (process.argv[i] === '--samples') samples = Number(process.argv[++i]);
  else if (process.argv[i] === '--help') {
    process.stdout.write('Options: --pages 1..40 --samples 1..5\nSet PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH for installed Chrome.\n');
    process.exit(0);
  } else throw new Error(`Unknown option: ${process.argv[i]}`);
}
if (!Number.isInteger(pages) || pages < 1 || pages > 40 || !Number.isInteger(samples) || samples < 1 || samples > 5) {
  throw new Error('Invalid benchmark options; use --help for limits.');
}

const entry = `
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as engine from ${JSON.stringify(join(root, 'src/engine/browser-core.ts'))};
import { parsePDF } from ${JSON.stringify(join(root, 'src/engine/parser/parser.ts'))};
import { DocumentSearchIndex, searchDocument } from ${JSON.stringify(join(root, 'src/app/editor/search-index.ts'))};
window.runBenchmark = async (pages, samples) => {
  const scan = new Uint8Array(await (await fetch('/scan.jpg')).arrayBuffer());
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = pdf.addPage([612, 792]);
    page.drawImage(await pdf.embedJpg(scan), { x: 320, y: 30, width: 180, height: 270 });
    for (let n = 0; n < 16; n++) page.drawText(\`Page \${i + 1} line \${n + 1}: needle quick brown fox\`,
      { x: 20, y: 750 - n * 30, size: 11, font });
  }
  const bytes = await pdf.save({ useObjectStreams: false });
  const doc = await parsePDF(bytes);
  // The unused oversized file key forces this candidate's synchronous fallback.
  // The page data is identical; this is not a historical build.
  const syncDoc = { ...doc, encryptionFileKey: new Uint8Array(8 * 1024 * 1024 + 1) };
  const runs = [];
  let expected;
  for (let i = 0; i < samples; i++) {
    for (const mode of i % 2 ? ['cooperative', 'forced-sync'] : ['forced-sync', 'cooperative']) {
      const index = new DocumentSearchIndex();
      for (const phase of ['cold', 'warm']) {
        await new Promise(resolve => setTimeout(resolve, 30));
        const start = performance.now(); let last = start, maxGap = 0, ticks = 0;
        const interval = setInterval(() => {
          const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; ticks++;
        }, 0);
        let matches;
        try { matches = await searchDocument(mode === 'forced-sync' ? syncDoc : doc, 'needle', false, '1', index, engine, () => true); }
        finally { clearInterval(interval); }
        const end = performance.now(); maxGap = Math.max(maxGap, end - last);
        if (!matches || matches.length !== pages * 16) throw new Error('Search result count differs from fixture');
        const signature = JSON.stringify(matches.map(({ id, ...match }) => match));
        if (expected === undefined) expected = signature;
        else if (expected !== signature) throw new Error('Search result data differs between modes');
        const indexBytes = index.getCachedBytes();
        if (mode === 'forced-sync' && indexBytes !== 0) throw new Error('Synchronous fallback unexpectedly cached results');
        runs.push({ mode, phase, elapsedMs: end - start, maxGapMs: maxGap, ticks, matches: matches.length, indexBytes });
      }
    }
  }
  return { pages, inputBytes: bytes.length, runs, jsHeapUsedBytes: performance.memory?.usedJSHeapSize ?? null };
};`;
const temp = await mkdtemp(join(tmpdir(), 'paperloom-search-benchmark-'));
let server;
try {
  await build({ bundle: true, format: 'esm', platform: 'browser', logLevel: 'silent',
    stdin: { contents: entry, loader: 'js', resolveDir: root }, outfile: join(temp, 'main.js'),
    alias: { '@': join(root, 'src') }, external: ['module', 'crypto', 'fs', 'path'],
    define: { 'process.env.NEXT_PUBLIC_BASE_PATH': '""', 'process.env.NODE_ENV': '"production"' } });
  for (const name of ['harfbuzz.wasm', 'harfbuzz-subset.wasm']) {
    await cp(join(root, 'node_modules/harfbuzzjs/dist', name), join(temp, name));
  }
  await cp(join(root, 'src/engine/__tests__/golden/fixtures/nara-amendment-24-scan.jpg'), join(temp, 'scan.jpg'));
  await writeFile(join(temp, 'index.html'), '<!doctype html><html><body><script type="module" src="/main.js"></script></body></html>');
  server = createServer(async (req, res) => {
    const paths = new Map([['/', 'index.html'], ['/main.js', 'main.js'], ['/scan.jpg', 'scan.jpg'],
      ['/harfbuzz.wasm', 'harfbuzz.wasm'], ['/harfbuzz-subset.wasm', 'harfbuzz-subset.wasm']]);
    const name = paths.get(req.url);
    if (!name) { res.writeHead(404).end(); return; }
    try {
      const content = await readFile(join(temp, name));
      res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : name.endsWith('.jpg') ? 'image/jpeg' :
        name.endsWith('.html') ? 'text/html' : 'application/javascript');
      res.end(content);
    } catch { res.writeHead(500).end(); }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => typeof window.runBenchmark === 'function');
    const cdp = await browser.newBrowserCDPSession(); let peakRssKiB = null;
    const sample = async () => {
      try {
        const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
        const ids = processInfo.map(item => item.id).filter(Number.isInteger).join(',');
        if (!ids) return null;
        const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', ids]);
        const rss = stdout.trim().split(/\s+/).reduce((sum, value) => sum + Number(value), 0);
        if (!Number.isFinite(rss)) return null;
        peakRssKiB = Math.max(peakRssKiB ?? 0, rss); return rss;
      } catch { return null; }
    };
    const baselineRssKiB = await sample(); let sampling = false;
    const timer = setInterval(async () => { if (sampling) return; sampling = true;
      try { await sample(); } finally { sampling = false; } }, 150);
    let result;
    try { result = await page.evaluate(({ pages, samples }) => window.runBenchmark(pages, samples), { pages, samples }); }
    finally { clearInterval(timer); }
    await sample();
    if (errors.length) throw new Error(`Browser page error: ${errors.join('; ')}`);
    process.stdout.write(`${JSON.stringify({ ...result, baselineRssKiB, peakRssKiB,
      rssNote: 'Combined process RSS includes both modes and fixture setup, may double-count shared pages, and cannot compare modes.',
      browser: browser.version(), platform: process.platform, node: process.version })}\n`);
  } finally { await browser.close(); }
} finally {
  if (server?.listening) await new Promise(done => server.close(done));
  await rm(temp, { recursive: true, force: true });
}
