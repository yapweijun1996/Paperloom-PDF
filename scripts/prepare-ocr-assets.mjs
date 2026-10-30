import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = process.cwd();
const output = join(root, 'public', 'ocr-assets');
const model = join(root, 'assets', 'ocr', 'eng.traineddata.gz');
const expected = '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91';
if (createHash('sha256').update(readFileSync(model)).digest('hex') !== expected) {
  throw new Error('The bundled OCR language model failed its integrity check.');
}
const tesseract = dirname(require.resolve('tesseract.js/package.json'));
const tesseractRequire = createRequire(join(tesseract, 'package.json'));
const core = dirname(tesseractRequire.resolve('tesseract.js-core/package.json'));
mkdirSync(output, { recursive: true });
copyFileSync(model, join(output, 'eng.traineddata.gz'));
copyFileSync(join(tesseract, 'dist', 'worker.min.js'), join(output, 'worker.min.js'));
for (const name of [
  'tesseract-core-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-relaxedsimd-lstm.wasm.js',
]) copyFileSync(join(core, name), join(output, name));
