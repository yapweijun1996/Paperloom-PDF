import { describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as engine from '@/engine/browser-core';
import { rawPDF } from '@/engine/__tests__/audit-p1-fixtures';
import { parsePDF } from '@/engine/parser/parser';
import { serializeDocument } from '@/engine/writer/serializer';
import { SessionDocumentEditor } from '@/engine/session/document-edit';
import { assertCurrentReplaceSupported, DocumentSearchIndex, replaceSearchMatches, searchDocument } from './search-index';

function stream(body: string, dict = ''): string {
  return `<< /Length ${body.length} ${dict} >>\nstream\n${body}\nendstream`;
}
function fixture(mode: 'form' | 'fonts', gap = 0, baseline = 0, suffix = ''): Uint8Array {
  const secondX = 46 + gap;
  const pageBody = mode === 'form'
    ? `BT /F1 12 Tf 1 0 0 1 10 100 Tm (Alpha) Tj ET /Outer Do ${suffix}`
    : `BT /F1 12 Tf 1 0 0 1 10 100 Tm (Alpha) Tj /F2 12 Tf 1 0 0 1 ${secondX} ${100 + baseline} Tm (Beta) Tj ET ${suffix}`;
  return rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /XObject << /Outer 4 0 R >> /Font << /F1 5 0 R /F2 7 0 R >> >> /Contents 6 0 R >>',
    stream(`BT /F1 12 Tf 1 0 0 1 ${secondX} ${100 + baseline} Tm (Beta) Tj ET`, '/Type /XObject /Subtype /Form /BBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >>'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>', stream(pageBody),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>',
  ]);
}
function overlapFixture(first: string, second: string, mode: 'fonts' | 'form' = 'fonts'): Uint8Array {
  const x = 10 + first.length * 7.2;
  const page = mode === 'fonts'
    ? `BT /F1 12 Tf 1 0 0 1 10 100 Tm (${first}) Tj /F2 12 Tf 1 0 0 1 ${x} 100 Tm (${second}) Tj ET`
    : `BT /F1 12 Tf 1 0 0 1 10 100 Tm (${first}) Tj ET /Outer Do`;
  return rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /XObject << /Outer 4 0 R >> /Font << /F1 5 0 R /F2 7 0 R >> >> /Contents 6 0 R >>',
    stream(`BT /F1 12 Tf 1 0 0 1 ${x} 100 Tm (${second}) Tj ET`, '/Type /XObject /Subtype /Form /BBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >>'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>', stream(page),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>',
  ]);
}
function spacingFixture(spacing: number): Uint8Array {
  const secondX = 10 + 5 * (7.2 + spacing) * 0.8;
  const body = `q 1.3 0 0 1.3 0 0 cm BT /F1 12 Tf ${spacing} Tc 80 Tz 3 Ts 1 0 0 1 10 100 Tm (Alpha) Tj /F2 12 Tf 1 0 0 1 ${secondX} 100 Tm (Beta) Tj ET Q`;
  return rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>', stream(body),
  ]);
}
function multiPageFixture(): Uint8Array {
  const body = 'BT /F1 12 Tf 1 0 0 1 10 100 Tm (Alpha) Tj /F2 12 Tf 1 0 0 1 46 100 Tm (Beta) Tj ET';
  return rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 8 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R /F2 7 0 R >> >> /Contents 9 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', stream(body), stream(body),
  ]);
}
async function find(doc: Awaited<ReturnType<typeof parsePDF>>, query: string, index = new DocumentSearchIndex()) {
  return searchDocument(doc, query, false, '1', index, engine, () => true);
}

describe('cross-run search', () => {
  it('replaces a selected simple cross-run match and preserves undo, redo, fonts and positions', async () => {
    const doc = await parsePDF(fixture('fonts'));
    const selected = (await find(doc, 'phaBe'))![0];
    const initial = await serializeDocument(doc);
    const page = doc.pages[0];
    const original = engine.interpretPage(engine.getPageContentBytes(page, doc.objects), page, doc.objects).textRuns;
    const editor = new SessionDocumentEditor();
    let replaced = 0;
    await editor.edit(doc, 'replace-current', async staged => {
      replaced = await replaceSearchMatches(staged, 'phaBe', '12345', true, engine, selected);
    });
    expect(replaced).toBe(1);
    let runs = engine.interpretPage(engine.getPageContentBytes(doc.pages[0], doc.objects), doc.pages[0], doc.objects).textRuns;
    expect(runs.map(run => run.text)).toEqual(['Al123', '45ta']);
    expect(runs.map(run => run.fontName)).toEqual(original.map(run => run.fontName));
    expect(runs.map(run => [run.x, run.y, run.width])).toEqual(original.map(run => [run.x, run.y, run.width]));
    const saved = await serializeDocument(doc);
    const reopened = await parsePDF(saved);
    runs = engine.interpretPage(engine.getPageContentBytes(reopened.pages[0], reopened.objects), reopened.pages[0], reopened.objects).textRuns;
    expect(runs.map(run => run.text)).toEqual(['Al123', '45ta']);
    if (spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status === 0) {
      const dir = mkdtempSync(join(tmpdir(), 'paperloom-cross-replace-'));
      try {
        const path = join(dir, 'output.pdf'); writeFileSync(path, saved);
        expect(execFileSync('pdftotext', ['-raw', path, '-'], { encoding: 'utf8' }).trim()).toBe('Al12345ta');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    expect(await editor.undo(doc)).toBe(true);
    expect(await serializeDocument(doc)).toEqual(initial);
    expect(await editor.redo(doc)).toBe(true);
    expect(engine.interpretPage(engine.getPageContentBytes(doc.pages[0], doc.objects), doc.pages[0], doc.objects).textRuns.map(run => run.text))
      .toEqual(['Al123', '45ta']);
  });

  it('replaces cross-run and single-run matches together in a single transaction', async () => {
    const doc = await parsePDF(fixture('fonts', 0, 0, 'BT /F1 12 Tf 1 0 0 1 10 30 Tm (AlphaBeta) Tj ET'));
    const editor = new SessionDocumentEditor();
    let count = 0;
    await editor.edit(doc, 'replace-all', async staged => {
      count = await replaceSearchMatches(staged, 'AlphaBeta', 'GammaZeta', false, engine);
    });
    expect(count).toBe(2);
    const page = doc.pages[0];
    expect(engine.interpretPage(engine.getPageContentBytes(page, doc.objects), page, doc.objects).textRuns.map(run => run.text))
      .toEqual(['Gamma', 'Zeta', 'GammaZeta']);
    expect(await editor.undo(doc)).toBe(true);
    expect(await find(doc, 'AlphaBeta')).toHaveLength(2);
  });

  it('preserves glyph positions with character spacing, horizontal scaling, text rise and a page transform', async () => {
    const doc = await parsePDF(spacingFixture(0.1));
    const page = doc.pages[0];
    const before = engine.interpretPage(engine.getPageContentBytes(page, doc.objects), page, doc.objects).textRuns;
    const selected = (await find(doc, 'AlphaBeta'))![0];
    expect(selected.source).toBe('cross-run');
    await new SessionDocumentEditor().edit(doc, 'replace-current', async staged => {
      await replaceSearchMatches(staged, 'AlphaBeta', 'GammaZeta', true, engine, selected);
    });
    const after = engine.interpretPage(engine.getPageContentBytes(doc.pages[0], doc.objects), doc.pages[0], doc.objects).textRuns;
    expect(after.map(run => run.text)).toEqual(['Gamma', 'Zeta']);
    expect(after.flatMap(run => run.glyphs.map(g => [g.x, g.y, g.width])))
      .toEqual(before.flatMap(run => run.glyphs.map(g => [g.x, g.y, g.width])));
    const widerSpacing = await parsePDF(spacingFixture(2));
    expect(await find(widerSpacing, 'AlphaBeta')).toEqual([]);
  });

  it('rejects a later unsupported page before writing any earlier page', async () => {
    const doc = await parsePDF(multiPageFixture());
    const before = await serializeDocument(doc);
    let writes = 0;
    const wrapped = { ...engine, updatePageContent: async (...args: Parameters<typeof engine.updatePageContent>) => {
      writes++;
      return engine.updatePageContent(...args);
    } };
    await expect(new SessionDocumentEditor().edit(doc, 'replace-all', async staged => {
      await replaceSearchMatches(staged, 'AlphaBeta', 'GammaZeta', true, wrapped);
    })).rejects.toThrow(/standard Courier/);
    expect(writes).toBe(0);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('rolls back a failed second page write without publishing the first page', async () => {
    const doc = await parsePDF(multiPageFixture());
    const secondFont = doc.objects.get('7_0') as import('@/engine/types').PDFDict;
    secondFont.set('BaseFont', new engine.PDFName('Courier-Bold'));
    const before = await serializeDocument(doc);
    let writes = 0;
    const wrapped = { ...engine, updatePageContent: async (...args: Parameters<typeof engine.updatePageContent>) => {
      if (++writes === 2) throw new Error('Injected second-page write failure');
      return engine.updatePageContent(...args);
    } };
    const editor = new SessionDocumentEditor();
    await expect(editor.edit(doc, 'replace-all', async staged => {
      await replaceSearchMatches(staged, 'AlphaBeta', 'GammaZeta', true, wrapped);
    })).rejects.toThrow(/Injected second-page/);
    expect(writes).toBe(2);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(editor.canUndo).toBe(false);
  });

  it.each(['form', 'length', 'font', 'stale'] as const)('rejects unsafe %s cross-run replacements before changing bytes', async kind => {
    const doc = await parsePDF(fixture(kind === 'form' ? 'form' : 'fonts'));
    const selected = (await find(doc, 'phaBe'))![0];
    if (kind === 'font') {
      const fonts = doc.pages[0].resources.getDict('Font')!;
      const ref = fonts.getRef('F2')!;
      const font = doc.objects.get(ref.toKey()) as import('@/engine/types').PDFDict;
      font.set('BaseFont', new engine.PDFName('Helvetica'));
    }
    if (kind === 'stale') selected.parts![0].runText = 'changed';
    const before = await serializeDocument(doc);
    const editor = new SessionDocumentEditor();
    await expect(editor.edit(doc, 'replace-current', async staged => {
      await replaceSearchMatches(staged, 'phaBe', kind === 'length' ? 'shorter' : '12345', true, engine, selected);
    })).rejects.toThrow();
    expect(await serializeDocument(doc)).toEqual(before);
  });
  it.each(['fonts', 'form'] as const)('finds and accurately highlights contiguous %s text', async mode => {
    const bytes = fixture(mode), doc = await parsePDF(bytes);
    const index = new DocumentSearchIndex();
    const matches = await find(doc, 'pHaBe', index);
    expect(matches).toHaveLength(1);
    const match = matches![0];
    expect(match).toMatchObject({ matchedText: 'phaBe', source: 'cross-run', runIndex: -1 });
    expect(match.pdfX).toBeCloseTo(24.4, 3);
    expect(match.pdfWidth).toBeCloseTo(36, 3);
    expect(match.pdfY).toBeLessThanOrEqual(100);
    expect(match.pdfY + match.pdfHeight).toBeGreaterThan(100);
    if (mode === 'form') {
      await expect(replaceSearchMatches(doc, 'pHaBe', '12345', false, engine)).rejects.toThrow(/Form XObject/);
    }
    expect(await find(doc, 'AlphaBeta', index)).toHaveLength(1);
    if (spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status === 0) {
      const dir = mkdtempSync(join(tmpdir(), 'paperloom-cross-run-'));
      try {
        const path = join(dir, 'fixture.pdf'); writeFileSync(path, bytes);
        expect(execFileSync('pdftotext', ['-raw', path, '-'], { encoding: 'utf8' }).trim()).toBe('AlphaBeta');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it.each([[1, 0], [-2, 0], [0, 2]])('does not join runs with a gap, overlap or different baseline (%s, %s)', async (gap, baseline) => {
    const doc = await parsePDF(fixture('fonts', gap, baseline));
    expect(await find(doc, 'AlphaBeta')).toEqual([]);
    expect(await replaceSearchMatches(doc, 'AlphaBeta', 'GammaZeta', false, engine)).toBe(0);
  });

  it('keeps separately clipped cross-run highlights out of a narrow gap', async () => {
    const doc = await parsePDF(fixture('fonts', 0.1));
    const wrapped = { ...engine, extractPageTextRuns: (...args: Parameters<typeof engine.extractPageTextRuns>) =>
      engine.extractPageTextRuns(...args).map(entry => ({ ...entry, highlightClip: {
        x: entry.run.x, y: entry.run.y, width: entry.run.width, height: entry.run.height,
      } })) };
    const matches = await searchDocument(doc, 'AlphaBeta', false, '1', new DocumentSearchIndex(), wrapped, () => true);
    expect(matches).toHaveLength(1);
    const match = matches![0];
    expect(match).toMatchObject({ source: 'cross-run', highlightVisible: true, highlightClipped: true });
    expect(match.highlightRects).toHaveLength(2);
    const [first, second] = match.highlightRects!;
    expect(first.x + first.width).toBeLessThan(second.x);
    expect(second.x - (first.x + first.width)).toBeCloseTo(0.1, 4);
  });

  it('uses JavaScript Unicode case folding while retaining UTF-16 match offsets', async () => {
    const doc = await parsePDF(fixture('fonts'));
    const wrapped = { ...engine, extractPageTextRuns: (...args: Parameters<typeof engine.extractPageTextRuns>) => {
      const runs = engine.extractPageTextRuns(...args);
      runs[0] = { ...runs[0], run: { ...runs[0].run, text: 'ſlpha',
        glyphs: runs[0].run.glyphs.map((glyph, i) => i ? glyph : { ...glyph, unicode: 'ſ' }) } };
      return runs;
    } };
    const matches = await searchDocument(doc, 'sLPhAbE', false, '1', new DocumentSearchIndex(), wrapped, () => true);
    expect(matches?.map(match => [match.matchedText, match.start, match.end, match.source])).toEqual([['ſlphaBe', 0, 7, 'cross-run']]);
    await expect(replaceSearchMatches(doc, 'sLPhAbE', '1234567', false, wrapped)).rejects.toThrow(/simple letters or numbers/);
  });

  it('rejects an unsupported cross-run replacement before any staged page write', async () => {
    const doc = await parsePDF(fixture('fonts', 0, 0, 'BT /F1 12 Tf 1 0 0 1 10 30 Tm (AlphaBeta) Tj ET'));
    const before = await serializeDocument(doc);
    let writes = 0;
    const wrapped = { ...engine, updatePageContent: async (...args: Parameters<typeof engine.updatePageContent>) => {
      writes++;
      return engine.updatePageContent(...args);
    } };
    await expect(new SessionDocumentEditor().edit(doc, 'replace-all', async staged => {
      await replaceSearchMatches(staged, 'AlphaBeta', 'short', false, wrapped);
    })).rejects.toThrow(/same length/);
    expect(writes).toBe(0);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it.each(['fonts', 'form'] as const)('keeps the first non-overlapping in-run match for aa+a (%s)', async mode => {
    const doc = await parsePDF(overlapFixture('aa', 'a', mode));
    const matches = await find(doc, 'aa');
    expect(matches?.map(match => [match.source, match.start, match.end])).toEqual([['page', 0, 2]]);
    expect(() => assertCurrentReplaceSupported(matches![0])).not.toThrow();
    let changed = 0;
    await new SessionDocumentEditor().edit(doc, 'replace-all', async staged => {
      changed = await replaceSearchMatches(staged, 'aa', 'Z', false, engine);
    });
    expect(changed).toBe(1);
  });

  it.each(['fonts', 'form'] as const)('keeps a first crossing match and skips overlapping later matches for a+aa (%s)', async mode => {
    const doc = await parsePDF(overlapFixture('a', 'aa', mode));
    const before = await serializeDocument(doc);
    const matches = await find(doc, 'aa');
    expect(matches?.map(match => match.source)).toEqual(['cross-run']);
    if (mode === 'form') {
      await expect(new SessionDocumentEditor().edit(doc, 'replace-all', async staged => {
        await replaceSearchMatches(staged, 'aa', 'ZZ', false, engine);
      })).rejects.toThrow(/Form XObject/);
      expect(await serializeDocument(doc)).toEqual(before);
    } else {
      let changed = 0;
      await new SessionDocumentEditor().edit(doc, 'replace-all', async staged => {
        changed = await replaceSearchMatches(staged, 'aa', 'ZZ', false, engine);
      });
      expect(changed).toBe(1);
      expect((await find(doc, 'ZZ'))).toHaveLength(1);
    }
  });

  it('refuses oversized cross-run queries rather than silently returning partial matches', async () => {
    const doc = await parsePDF(fixture('fonts'));
    await expect(find(doc, 'x'.repeat(1025))).rejects.toThrow(/supported length/);
    await expect(replaceSearchMatches(doc, 'x'.repeat(1025), 'y', false, engine)).rejects.toThrow(/supported length/);
  });

  it('fails without publishing when a long contiguous scan exceeds its work budget', async () => {
    const doc = await parsePDF(fixture('fonts'));
    const wrapped = { ...engine, extractPageTextRuns: (...args: Parameters<typeof engine.extractPageTextRuns>) => {
      const runs = engine.extractPageTextRuns(...args);
      return runs.map((entry, index) => {
        const x = 10 + index * 9000 * 7.2;
        const glyphs = Array.from({ length: 9000 }, (_, i) => ({ ...entry.run.glyphs[0],
          unicode: index ? 'b' : 'a', x: x + i * 7.2, width: 7.2 }));
        return { ...entry, run: { ...entry.run, text: (index ? 'b' : 'a').repeat(9000),
          x, width: 9000 * 7.2, glyphs } };
      });
    } };
    const publish = vi.fn();
    await expect(searchDocument(doc, 'x'.repeat(1024), false, '1', new DocumentSearchIndex(), wrapped,
      () => true, undefined, undefined, publish)).rejects.toThrow(/safely inspect page/);
    expect(publish).not.toHaveBeenCalled();
    await expect(replaceSearchMatches(doc, 'x'.repeat(1024), 'y', false, wrapped)).rejects.toThrow(/inspection limit/);
  });
});
