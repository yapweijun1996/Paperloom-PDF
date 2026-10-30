import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { findBuiltWorker, smokeBuiltWorker } from './pdf-worker-build-check.mjs';

const root = process.cwd();
if ((process.env.CI === 'true' || process.env.CI === '1') && !existsSync(join(root, 'out'))) {
  throw new Error('missing out/ in CI; run npm run build before verifying the PDF worker');
}
const required = ['src/engine/worker/codec.ts', 'src/engine/worker/protocol.ts', 'src/engine/worker/pdf.worker.ts', 'src/engine/worker/client.ts', 'docs/PDF_WORKER.md'];
for (const file of required) if (!existsSync(join(root, file))) throw new Error(`missing ${file}`);
const core = readFileSync(join(root, 'src/engine/browser-core.ts'), 'utf8');
if (!core.includes("'./worker/client'")) throw new Error('browser-core does not route through worker/client');
if (core.includes("parsePDF } from './parser/parser'") || core.includes("saveQuick, saveOptimized, saveDocument } from './writer/save-pipeline'")) throw new Error('direct parse/save boundary remains');
const protocol = readFileSync(join(root, 'src/engine/worker/protocol.ts'), 'utf8');
for (const command of ['PARSE_PDF', 'SAVE_PDF', 'OPTIMIZE_PDF']) if (!protocol.includes(command)) throw new Error(`missing ${command}`);
if (protocol.includes('newObjects?: WireDocument')) throw new Error('newObjects must use keys on the combined graph');
const worker = readFileSync(join(root, 'src/engine/worker/pdf.worker.ts'), 'utf8');
if (worker.includes('save-pipeline.ts\nexport') || worker.includes('parser.ts\nexport')) throw new Error('implementation fork detected');
const handler = readFileSync(join(root, 'src/engine/worker/handler.ts'), 'utf8');
for (const command of ['PARSE_PDF', 'SAVE_PDF', 'OPTIMIZE_PDF']) if (!handler.includes(`command.type === '${command}'`)) throw new Error(`worker does not explicitly handle ${command}`);
if (!handler.includes('Unknown PDF worker command')) throw new Error('worker does not reject unknown commands');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!String(packageJson.scripts?.build ?? '').includes('--webpack')) throw new Error('production build must use --webpack for the PDF worker');
if (existsSync(join(root, 'out'))) {
  const files = [];
  const walk = (dir) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else files.push(path); } };
  walk(join(root, 'out'));
  if (files.some((file) => /pdf\.worker.*\.ts$/.test(file))) throw new Error('static export contains a raw pdf.worker TypeScript asset');
  const worker = findBuiltWorker(root);
  await smokeBuiltWorker(root, worker);
  console.log(`compiled PDF worker: ${worker.path.replace(`${root}/`, '')} (parse, save, optimize and reopen passed)`);
}
console.log('pdf-worker guard PASS');
