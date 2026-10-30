import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const output = join(process.cwd(), 'out');
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');
if (basePath && (!/^\/(?:[A-Za-z0-9._~-]+\/?)+$/.test(basePath) || basePath.split('/').some(part => part === '.' || part === '..'))) {
  throw new Error('Invalid NEXT_PUBLIC_BASE_PATH for offline export');
}
for (const name of ['index.html', 'editor/index.html']) {
  if (!existsSync(join(output, name))) throw new Error(`Missing static export ${name}`);
}
for (const name of [
  'worker.min.js', 'eng.traineddata.gz', 'tesseract-core-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js',
]) {
  if (!existsSync(join(output, 'ocr-assets', name))) throw new Error(`Missing offline OCR asset ${name}`);
}
const manifest = {
  name: 'Paperloom PDF', short_name: 'Paperloom', description: 'Edit PDFs in your browser',
  id: `${basePath}/`, start_url: `${basePath}/`, scope: `${basePath}/`, display: 'standalone',
  background_color: '#ffffff', theme_color: '#ffffff',
  icons: [192, 512].map(size => ({ src: `${basePath}/icon-${size}.png`, sizes: `${size}x${size}`, type: 'image/png' })),
};
writeFileSync(join(output, 'manifest.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`);
const assets = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile()) {
      const name = relative(output, path).split('\\').join('/');
      // Only build artifacts and known bundled assets are eligible. Never cache
      // user-selected PDFs or arbitrary requests made after installation.
      if (/^_next\/static\//.test(name) || /^(?:editor\/)?(?:index\.(?:html|txt)|__next[^/]*\.txt)$/.test(name) ||
          /^fonts\/[^/]+\.(?:ttf|otf|woff2?)$/i.test(name) || /^brand\/[^/]+\.(?:svg|png|webp)$/i.test(name) ||
          /^ocr-assets\/(?:eng\.traineddata\.gz|worker\.min\.js|tesseract-core-(?:relaxedsimd-|simd-)?lstm\.wasm\.js)$/.test(name) ||
          /^(?:icon-(?:192|512)\.png|(?:apple-)?icon\.png|favicon\.ico|manifest\.webmanifest)$/.test(name)) {
        assets.push(name);
      }
    }
  }
}
walk(output);
assets.sort();
const template = readFileSync(join(process.cwd(), 'scripts/pwa-worker-template.js'), 'utf8');
const hash = createHash('sha256');
hash.update(template);
hash.update('\0');
for (const name of assets) { hash.update(name); hash.update('\0'); hash.update(readFileSync(join(output, name))); }
const version = hash.digest('hex').slice(0, 20);
const prefix = `paperloom-offline:${basePath || '/'}:`;
const worker = template
  .replace('__PAPERLOOM_CACHE_NAME__', JSON.stringify(prefix + version))
  .replace('__PAPERLOOM_CACHE_PREFIX__', JSON.stringify(prefix))
  .replace('__PAPERLOOM_BASE_PATH__', JSON.stringify(basePath))
  .replace('__PAPERLOOM_PRECACHE__', JSON.stringify(assets.map(asset => `${basePath}/${asset}`)));
writeFileSync(join(output, 'sw.js'), worker);
console.log(`Offline export prepared: ${assets.length} application assets (${version})`);
