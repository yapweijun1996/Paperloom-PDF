/**
 * Browser save benchmark using synthetic data only. Examples:
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH='/path/to/chrome' node scripts/benchmark-save-browser.mjs
 *   node scripts/benchmark-save-browser.mjs --source-root /path/to/isolated/checkout --samples 1
 * The source checkout must have its dependencies installed. Results are JSON
 * lines; process RSS is a sampled sum and may double-count shared pages.
 */
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = { sourceRoot: projectRoot, sizeMiB: 20, samples: 3, mode: 'both', newObjects: false };
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--help') {
    process.stdout.write('Options: --source-root PATH --size-mib 1..32 --samples 1..10 --mode direct|worker|both --new-objects\nSet PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to use an installed Chrome.\n');
    process.exit(0);
  } else if (arg === '--new-objects') options.newObjects = true;
  else if (arg === '--source-root') options.sourceRoot = resolve(process.argv[++i] ?? '');
  else if (arg === '--size-mib') options.sizeMiB = Number(process.argv[++i]);
  else if (arg === '--samples') options.samples = Number(process.argv[++i]);
  else if (arg === '--mode') options.mode = process.argv[++i];
  else throw new Error(`Unknown argument: ${arg}`);
}
if (!Number.isInteger(options.sizeMiB) || options.sizeMiB < 1 || options.sizeMiB > 32 ||
    !Number.isInteger(options.samples) || options.samples < 1 || options.samples > 10 ||
    !['direct', 'worker', 'both'].includes(options.mode)) {
  throw new Error('Invalid benchmark options; use --help for supported limits.');
}
const importPath = path => JSON.stringify(join(options.sourceRoot, path));
const entry = `
import { PDFDocument, PDFName } from 'pdf-lib';
import { parsePDF } from ${importPath('src/engine/parser/parser.ts')};
import { saveQuick as directSave } from ${importPath('src/engine/writer/save-pipeline.ts')};
import { saveQuick as workerSave } from ${importPath('src/engine/worker/client.ts')};
import { PDFNumber } from ${importPath('src/engine/types.ts')};
window.runBenchmark = async (mode, sizeMiB, withNewObjects) => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([200, 200]);
  const content = new Uint8Array(sizeMiB * 1024 * 1024); content.fill(32);
  page.node.set(PDFName.of('Contents'), pdf.context.register(pdf.context.stream(content)));
  const input = await pdf.save({ useObjectStreams: false, updateFieldAppearances: false });
  const doc = await parsePDF(input);
  const ref = doc.pages[0].ref;
  doc.pages[0].dict.set('Rotate', new PDFNumber(90));
  let heartbeats = 0, last = performance.now(), maxHeartbeatGapMs = 0;
  const timer = setInterval(() => { const now = performance.now(); maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, now - last); last = now; heartbeats++; }, 5);
  const start = performance.now();
  let output, elapsedMs;
  try {
    const save = mode === 'direct' ? directSave : workerSave;
    output = await save(doc, new Set([ref.toKey()]), withNewObjects ? new Map([['999_0', new PDFNumber(123)]]) : undefined);
    elapsedMs = performance.now() - start;
    maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, performance.now() - last);
  } finally { clearInterval(timer); }
  const reopened = await PDFDocument.load(output, { updateMetadata: false });
  if (reopened.getPageCount() !== 1 || reopened.getPage(0).getRotation().angle !== 90) throw new Error('Saved PDF did not reopen with the edit');
  const parsed = await parsePDF(output);
  if (withNewObjects && !parsed.objects.has('999_0')) throw new Error('New object missing after reopening');
  return { mode, sizeMiB, withNewObjects, elapsedMs, maxHeartbeatGapMs, heartbeats,
    inputBytes: input.length, outputBytes: output.length,
    jsHeapUsedBytes: performance.memory?.usedJSHeapSize ?? null };
};`;
const temp = await mkdtemp(join(tmpdir(), 'paperloom-save-benchmark-'));
let server;
try {
  const common = { bundle: true, format: 'esm', platform: 'browser', logLevel: 'silent',
    external: ['module', 'crypto', 'fs', 'path'], define: { 'process.env.NEXT_PUBLIC_BASE_PATH': '""' } };
  await build({ ...common, stdin: { contents: entry, loader: 'js', resolveDir: options.sourceRoot }, outfile: join(temp, 'main.js') });
  await build({ ...common, entryPoints: [join(options.sourceRoot, 'src/engine/worker/pdf.worker.ts')], outfile: join(temp, 'pdf.worker.ts') });
  for (const name of ['harfbuzz.wasm', 'harfbuzz-subset.wasm']) {
    await cp(join(options.sourceRoot, 'node_modules/harfbuzzjs/dist', name), join(temp, name));
  }
  await writeFile(join(temp, 'index.html'), '<!doctype html><html><body><script type="module" src="/main.js"></script></body></html>');
  server = createServer(async (req, res) => {
    const paths = new Map([['/', 'index.html'], ['/main.js', 'main.js'], ['/pdf.worker.ts', 'pdf.worker.ts'],
      ['/harfbuzz.wasm', 'harfbuzz.wasm'], ['/harfbuzz-subset.wasm', 'harfbuzz-subset.wasm']]);
    const name = paths.get(req.url);
    if (!name) { res.writeHead(404).end(); return; }
    try {
      const content = await readFile(join(temp, name));
      res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : name.endsWith('.html') ? 'text/html' : 'application/javascript');
      res.end(content);
    } catch { res.writeHead(500).end(); }
  });
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const port = server.address().port;
  const modes = options.mode === 'both' ? ['direct', 'worker'] : [options.mode];
  for (let iteration = 0; iteration < options.samples; iteration++) for (const mode of modes) {
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    try {
      const page = await browser.newPage(); let workers = 0; const errors = [];
      page.on('worker', () => workers++); page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForFunction(() => typeof window.runBenchmark === 'function');
      const session = await browser.newBrowserCDPSession();
      let peakRssKiB = null;
      const sample = async () => {
        try {
          const { processInfo } = await session.send('SystemInfo.getProcessInfo');
          const ids = processInfo.map(process => process.id).filter(Number.isInteger).join(',');
          if (!ids) return null;
          const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', ids]);
          const rss = stdout.trim().split(/\s+/).reduce((sum, value) => sum + Number(value), 0);
          if (!Number.isFinite(rss)) return null;
          peakRssKiB = Math.max(peakRssKiB ?? 0, rss); return rss;
        } catch { return null; }
      };
      const baselineRssKiB = await sample();
      let sampling = false;
      const timer = setInterval(async () => {
        if (sampling) return; sampling = true;
        try { await sample(); } finally { sampling = false; }
      }, 150);
      let result;
      try { result = await page.evaluate(({ mode, sizeMiB, withNewObjects }) => window.runBenchmark(mode, sizeMiB, withNewObjects),
        { mode, sizeMiB: options.sizeMiB, withNewObjects: options.newObjects }); }
      finally { clearInterval(timer); }
      await sample();
      if (errors.length) throw new Error(`Browser page error: ${errors.join('; ')}`);
      if (mode === 'worker' && !workers) throw new Error('The worker benchmark did not create a real worker');
      process.stdout.write(`${JSON.stringify({ ...result, iteration: iteration + 1, workers, baselineRssKiB, peakRssKiB,
        rssNote: 'Sampled process RSS sum may double-count shared pages; includes fixture setup and reopen.',
        browser: browser.version(), platform: process.platform, node: process.version })}\n`);
    } finally { await browser.close(); }
  }
} finally {
  if (server?.listening) await new Promise(resolveClose => server.close(resolveClose));
  await rm(temp, { recursive: true, force: true });
}
