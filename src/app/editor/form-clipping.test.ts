import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as engine from '@/engine/browser-core';
import { rawPDF } from '@/engine/__tests__/audit-p1-fixtures';
import { PDFArray, PDFNumber, PDFRef, PDFStream } from '@/engine/types';
import { DocumentSearchIndex, searchDocument } from './search-index';

function stream(body: string, dictionary = ''): string {
  return `<< /Length ${body.length} ${dictionary} >>\nstream\n${body}\nendstream`;
}

function fixture(pageContent: string, formContent: string, bbox = '[0 0 100 60]',
  formMatrix = '[1 0 0 1 0 0]', nestedContent?: string): Uint8Array {
  return rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /XObject << /Outer 4 0 R >> /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    stream(formContent, `/Type /XObject /Subtype /Form /BBox ${bbox} /Matrix ${formMatrix} /Resources << /Font << /F1 5 0 R >> /XObject << /Inner 7 0 R >> >>`),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream(pageContent),
    stream(nestedContent ?? '', '/Type /XObject /Subtype /Form /BBox [0 0 20 30] /Matrix [1 0 0 1 40 50] /Resources << /Font << /F1 5 0 R >> >>'),
  ]);
}

async function extracted(bytes: Uint8Array) {
  const doc = await engine.parsePDF(bytes);
  const page = doc.pages[0];
  const visibility = new engine.OptionalContentVisibility(doc.catalog, doc.objects);
  const interpreted = engine.interpretPage(engine.getPageContentBytes(page, doc.objects), page, doc.objects, visibility);
  return engine.extractPageTextRuns(page, doc.objects, visibility, interpreted);
}

describe('Form text highlight clipping', () => {
  it.skipIf(spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status !== 0 ||
      spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status !== 0).each(['bbox', 'page clip'])(
    'keeps clipped text searchable while constraining highlights using %s', async kind => {
      const bytes = fixture(kind === 'bbox' ? '/Outer Do' : 'q 0 0 100 60 re W n /Outer Do Q',
        'BT /F1 12 Tf 1 0 0 1 10 20 Tm (VISIBLE) Tj 1 0 0 1 10 100 Tm (HIDDEN) Tj ET',
        kind === 'bbox' ? '[0 0 100 60]' : '[0 0 300 300]');
      const runs = await extracted(bytes);
      expect(runs.map(entry => entry.run.text)).toEqual(['VISIBLE', 'HIDDEN']);
      expect(runs.map(entry => entry.highlightClip)).toEqual([
        { x: 0, y: 0, width: 100, height: 60 }, { x: 0, y: 0, width: 100, height: 60 },
      ]);
      const dir = mkdtempSync(join(tmpdir(), 'paperloom-form-bbox-'));
      try {
        const input = join(dir, 'fixture.pdf'), output = join(dir, 'page');
        writeFileSync(input, bytes);
        const text = execFileSync('pdftotext', ['-raw', input, '-'], { encoding: 'utf8' });
        expect(text).toContain('VISIBLE');
        expect(text).toContain('HIDDEN');
        execFileSync('pdftoppm', ['-r', '72', '-singlefile', input, output]);
        const ppm = readFileSync(`${output}.ppm`);
        const header = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(ppm.toString('ascii', 0, 128));
        if (!header) throw new Error('Unsupported Poppler output');
        const width = Number(header[1]), height = Number(header[2]), data = ppm.subarray(header[0].length);
        const hasInk = (low: number, high: number) => {
          for (let py = height - high; py < height - low; py++) for (let px = 0; px < 100; px++) {
            const offset = (py * width + px) * 3;
            if (data[offset] < 240 || data[offset + 1] < 240 || data[offset + 2] < 240) return true;
          }
          return false;
        };
        expect(hasInk(10, 40)).toBe(true);
        expect(hasInk(90, 130)).toBe(false);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
  );

  it('intersects page clipping and nested transformed Form bounds in page coordinates', async () => {
    const bytes = fixture('q 0 0 150 160 re W n 2 0 0 2 10 20 cm /Outer Do Q',
      'BT /F1 12 Tf 1 0 0 1 10 10 Tm (Outer) Tj ET /Inner Do', '[0 0 100 100]', '[1 0 0 1 5 7]',
      'BT /F1 10 Tf 1 0 0 1 1 2 Tm (Inner) Tj ET');
    const runs = await extracted(bytes);
    expect(runs.map(entry => entry.run.text)).toEqual(['Outer', 'Inner']);
    expect(runs[0].highlightClip).toEqual({ x: 20, y: 34, width: 130, height: 126 });
    expect(runs[1].highlightClip).toEqual({ x: 100, y: 134, width: 40, height: 26 });
  });

  it('handles a right-angle rotation but suppresses ambiguous sheared bounds', async () => {
    const form = 'BT /F1 12 Tf 1 0 0 1 10 20 Tm (Text) Tj ET';
    const rotated = await extracted(fixture('q 0 1 -1 0 200 0 cm /Outer Do Q', form,
      '[0 0 100 100]', '[1 0 0 1 5 7]'));
    expect(rotated[0].highlightClip).toEqual({ x: 93, y: 5, width: 100, height: 100 });
    const sheared = await extracted(fixture('q 1 0.3 0 1 0 0 cm /Outer Do Q', form));
    expect(sheared[0].run.text).toBe('Text');
    expect(sheared[0].highlightClip).toBeNull();
  });

  it('tracks a rectangular clip in a Form and restores the parent bounds after Q', async () => {
    const runs = await extracted(fixture('/Outer Do',
      'q 0 0 30 30 re W n BT /F1 12 Tf 1 0 0 1 10 10 Tm (First) Tj ET Q BT /F1 12 Tf 1 0 0 1 10 40 Tm (Second) Tj ET'));
    expect(runs.map(entry => entry.highlightClip)).toEqual([
      { x: 0, y: 0, width: 30, height: 30 }, { x: 0, y: 0, width: 100, height: 60 },
    ]);
  });

  it('applies a pending W only after path termination and restores committed clips at Q', async () => {
    const runs = await extracted(fixture('q 0 0 30 30 re W /Outer Do n /Outer Do Q /Outer Do',
      'BT /F1 12 Tf 1 0 0 1 10 10 Tm (Text) Tj ET'));
    expect(runs.map(entry => entry.run.text)).toEqual(['Text', 'Text', 'Text']);
    expect(runs.map(entry => entry.highlightClip)).toEqual([
      { x: 0, y: 0, width: 100, height: 60 },
      { x: 0, y: 0, width: 30, height: 30 },
      { x: 0, y: 0, width: 100, height: 60 },
    ]);
  });

  it.each(['n', 'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*'])(
    'commits a pending clip on path-ending operator %s', async endPath => {
      const runs = await extracted(fixture(`q 0 0 30 30 re W ${endPath} /Outer Do Q`,
        'BT /F1 12 Tf 1 0 0 1 10 10 Tm (Text) Tj ET'));
      expect(runs[0].highlightClip).toEqual({ x: 0, y: 0, width: 30, height: 30 });
    },
  );

  it('keeps the pending clip and path across q/Q while restoring committed clip state', async () => {
    const runs = await extracted(fixture('q 0 0 80 50 re W n q 0 0 20 20 re W Q n /Outer Do Q',
      'BT /F1 12 Tf 1 0 0 1 10 10 Tm (Text) Tj ET'));
    expect(runs[0].highlightClip).toEqual({ x: 0, y: 0, width: 20, height: 20 });
  });

  it('treats empty W n as a no-op but retains an unsafe zero-area path', async () => {
    const runs = await extracted(fixture('q W n /Outer Do Q q 0 0 0 10 re W n /Outer Do Q',
      'BT /F1 12 Tf 1 0 0 1 10 10 Tm (Text) Tj ET'));
    expect(runs.map(entry => entry.highlightClip)).toEqual([
      { x: 0, y: 0, width: 100, height: 60 }, null,
    ]);
  });

  it('uses only the last pending W or W* before the path ends', async () => {
    const runs = await extracted(fixture('q 0 0 30 30 re W W* n /Outer Do Q',
      'BT /F1 12 Tf 1 0 0 1 10 10 Tm (Text) Tj ET'));
    expect(runs[0].highlightClip).toEqual({ x: 0, y: 0, width: 30, height: 30 });
  });

  it.skipIf(spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status !== 0)(
    'matches Poppler when a Form is invoked before or after the clipping path ends', async () => {
      const form = 'BT /F1 12 Tf 1 0 0 1 40 10 Tm (Outside) Tj ET';
      const before = fixture('q 0 0 30 30 re W /Outer Do n Q', form);
      const after = fixture('q 0 0 30 30 re W n /Outer Do Q', form);
      const dir = mkdtempSync(join(tmpdir(), 'paperloom-form-clip-timing-'));
      try {
        const ink = (bytes: Uint8Array, name: string) => {
          const input = join(dir, `${name}.pdf`), prefix = join(dir, name);
          writeFileSync(input, bytes);
          execFileSync('pdftoppm', ['-r', '72', '-singlefile', input, prefix]);
          const ppm = readFileSync(`${prefix}.ppm`);
          const header = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(ppm.toString('ascii', 0, 128));
          if (!header) throw new Error('Unsupported Poppler output');
          const width = Number(header[1]), height = Number(header[2]);
          const data = ppm.subarray(header[0].length);
          let count = 0;
          for (let py = height - 30; py < height - 5; py++) for (let px = 40; px < 100; px++) {
            const offset = (py * width + px) * 3;
            if (data[offset] < 240 || data[offset + 1] < 240 || data[offset + 2] < 240) count++;
          }
          return count;
        };
        expect(ink(before, 'before')).toBeGreaterThan(0);
        expect(ink(after, 'after')).toBe(0);
        expect((await extracted(before))[0].highlightClip).toEqual({ x: 0, y: 0, width: 100, height: 60 });
        expect((await extracted(after))[0].highlightClip).toEqual({ x: 0, y: 0, width: 30, height: 30 });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
  );

  it.each([
    'q 0 0 0 0 re W n /Outer Do Q',
    'q 0 0 m 50 0 l 25 50 l h W n /Outer Do Q',
  ])('retains text but suppresses an unsafe highlight for ambiguous clipping', async pageContent => {
    const runs = await extracted(fixture(pageContent, 'BT /F1 12 Tf 1 0 0 1 10 20 Tm (Text) Tj ET'));
    expect(runs.map(entry => entry.run.text)).toEqual(['Text']);
    expect(runs[0].highlightClip).toBeNull();
  });

  it.each([4, 5, 6, 7])('suppresses Form highlights after text clipping mode %s until Q restores state', async mode => {
    const runs = await extracted(fixture(
      `q BT /F1 12 Tf ${mode} Tr 1 0 0 1 10 10 Tm (Mask) Tj ET 0 Tr /Outer Do Q /Outer Do`,
      'BT /F1 12 Tf 1 0 0 1 10 20 Tm (Text) Tj ET'));
    expect(runs.filter(entry => entry.source === 'form').map(entry => entry.highlightClip)).toEqual([
      null, { x: 0, y: 0, width: 100, height: 60 },
    ]);
  });

  it('suppresses a combined ActualText highlight when page and Form clips differ', async () => {
    const runs = await extracted(fixture('/Span << /ActualText (Logical) >> BDC BT /F1 12 Tf 1 0 0 1 10 260 Tm (Page) Tj ET /Outer Do EMC',
      'BT /F1 12 Tf 1 0 0 1 10 20 Tm (Form) Tj ET'));
    expect(runs.map(entry => entry.run.text)).toEqual(['Logical']);
    expect(runs[0].highlightClip).toBeNull();
  });

  it.each(['null', '[0 0 0 0]', '[0 0 100]'])('retains text but does not guess an invalid BBox %s', async bbox => {
    const runs = await extracted(fixture('/Outer Do', 'BT /F1 12 Tf 1 0 0 1 10 20 Tm (Text) Tj ET', bbox));
    expect(runs[0].run.text).toBe('Text');
    expect(runs[0].highlightClip).toBeNull();
  });

  it.each(['Matrix', 'BBox'] as const)('resolves indirect Form %s for highlight clipping', async key => {
    const bytes = fixture('/Outer Do', 'BT /F1 12 Tf 1 0 0 1 10 20 Tm (Text) Tj ET');
    const doc = await engine.parsePDF(bytes), page = doc.pages[0];
    const form = doc.objects.get('4_0') as PDFStream;
    const values = key === 'Matrix' ? [1, 0, 0, 1, 30, 40] : [0, 0, 100, 60];
    doc.objects.set('90_0', new PDFArray(values.map(value => new PDFNumber(value))));
    form.dict.set(key, new PDFRef(90, 0));
    const visibility = new engine.OptionalContentVisibility(doc.catalog, doc.objects);
    const interpreted = engine.interpretPage(engine.getPageContentBytes(page, doc.objects), page, doc.objects, visibility);
    const runs = engine.extractPageTextRuns(page, doc.objects, visibility, interpreted);
    expect(runs[0].run.text).toBe('Text');
    expect(runs[0].highlightClip).toEqual(key === 'Matrix'
      ? { x: 30, y: 40, width: 100, height: 60 }
      : { x: 0, y: 0, width: 100, height: 60 });
    if (key === 'Matrix') expect(runs[0].run.x).toBe(40);
  });

  it('resolves indirect geometry numbers for highlight clipping', async () => {
    const bytes = fixture('/Outer Do', 'BT /F1 12 Tf 1 0 0 1 10 20 Tm (Text) Tj ET');
    const doc = await engine.parsePDF(bytes), page = doc.pages[0];
    const form = doc.objects.get('4_0') as PDFStream;
    doc.objects.set('91_0', new PDFNumber(100));
    form.dict.set('BBox', new PDFArray([new PDFNumber(0), new PDFNumber(0), new PDFRef(91, 0), new PDFNumber(60)]));
    const visibility = new engine.OptionalContentVisibility(doc.catalog, doc.objects);
    const interpreted = engine.interpretPage(engine.getPageContentBytes(page, doc.objects), page, doc.objects, visibility);
    const runs = engine.extractPageTextRuns(page, doc.objects, visibility, interpreted);
    expect(runs[0].highlightClip).toEqual({ x: 0, y: 0, width: 100, height: 60 });
  });

  it('propagates an invalid indirect Form Matrix as an asynchronous search error', async () => {
    const bytes = fixture('/Outer Do', 'BT /F1 12 Tf 1 0 0 1 10 20 Tm (Text) Tj ET');
    const doc = await engine.parsePDF(bytes), form = doc.objects.get('4_0') as PDFStream;
    doc.objects.set('90_0', new PDFRef(90, 0));
    form.dict.set('Matrix', new PDFRef(90, 0));
    await expect(searchDocument(doc, 'Text', false, '1', new DocumentSearchIndex(), engine, () => true))
      .rejects.toThrow(/safely inspect page 1/i);
  });

  it('keeps text searchable but does not position a highlight for a cyclic Form BBox', async () => {
    const bytes = fixture('/Outer Do', 'BT /F1 12 Tf 1 0 0 1 10 20 Tm (Text) Tj ET');
    const doc = await engine.parsePDF(bytes), page = doc.pages[0], form = doc.objects.get('4_0') as PDFStream;
    doc.objects.set('90_0', new PDFRef(90, 0));
    form.dict.set('BBox', new PDFRef(90, 0));
    const visibility = new engine.OptionalContentVisibility(doc.catalog, doc.objects);
    const interpreted = engine.interpretPage(engine.getPageContentBytes(page, doc.objects), page, doc.objects, visibility);
    const entries = engine.extractPageTextRuns(page, doc.objects, visibility, interpreted);
    expect(entries[0].run.text).toBe('Text');
    expect(entries[0].highlightClip).toBeNull();
  });
});
