import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = join(process.cwd(), 'scripts/prepare-ocr-assets.mjs');
const original = join(process.cwd(), 'assets/ocr/eng.traineddata.gz');

describe('offline OCR assets', () => {
  it('copies the pinned model and worker variants, and refuses a changed model', () => {
    const root = mkdtempSync(join(tmpdir(), 'paperloom-ocr-assets-'));
    try {
      mkdirSync(join(root, 'assets/ocr'), { recursive: true });
      copyFileSync(original, join(root, 'assets/ocr/eng.traineddata.gz'));
      execFileSync(process.execPath, [script], { cwd: root, stdio: 'pipe' });
      const output = join(root, 'public/ocr-assets');
      expect(createHash('sha256').update(readFileSync(join(output, 'eng.traineddata.gz'))).digest('hex'))
        .toBe('45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91');
      for (const name of ['worker.min.js', 'tesseract-core-lstm.wasm.js',
        'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js']) {
        expect(readFileSync(join(output, name)).length).toBeGreaterThan(1_000);
      }
      writeFileSync(join(root, 'assets/ocr/eng.traineddata.gz'), 'wrong model');
      expect(() => execFileSync(process.execPath, [script], { cwd: root, stdio: 'pipe' })).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
