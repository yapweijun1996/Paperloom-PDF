import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as engine from '@/engine/browser-core';
import { rawPDF } from '@/engine/__tests__/audit-p1-fixtures';
import { parsePDF } from '@/engine/parser/parser';
import { serializeDocument } from '@/engine/writer/serializer';
import { DocumentSearchIndex, replaceSearchMatches, searchDocument } from './search-index';

function fixture(degrees: number, gap = 0, offset = 0, secondDegrees = degrees, clipped = false, prefix = ''): Uint8Array {
  const angle = degrees * Math.PI / 180, secondAngle = secondDegrees * Math.PI / 180;
  const c = Math.cos(angle), s = Math.sin(angle), c2 = Math.cos(secondAngle), s2 = Math.sin(secondAngle);
  const x = 150 + (36 + gap) * c - offset * s, y = 100 + (36 + gap) * s + offset * c;
  // Avoid scientific notation: PDF numbers do not support exponent syntax.
  const n = (value: number) => Math.abs(value) < 1e-10 ? '0' : value.toFixed(8);
  const body = `${prefix}${clipped ? 'q 0 0 300 300 re W n ' : ''}BT /F1 12 Tf ${n(c)} ${n(s)} ${n(-s)} ${n(c)} 150 100 Tm (Alpha) Tj /F2 12 Tf ${n(c2)} ${n(s2)} ${n(-s2)} ${n(c2)} ${n(x)} ${n(y)} Tm (Beta) Tj ET${clipped ? ' Q' : ''}`;
  return rawPDF(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`]);
}
async function find(bytes: Uint8Array, query = 'AlphaBeta') {
  const doc = await parsePDF(bytes);
  const matches = await searchDocument(doc, query, false, '1', new DocumentSearchIndex(), engine, () => true);
  return { doc, matches: matches! };
}

describe('rotated cross-run search', () => {
  it.each([90, 30, 180, 270])('finds adjacent rotated runs at %s degrees without drawing an unreliable highlight', async angle => {
    const bytes = fixture(angle), { matches } = await find(bytes);
    // 180-degree baselines are rotated too, even though their y component is zero.
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ matchedText: 'AlphaBeta', source: 'cross-run', highlightVisible: false });
    expect(matches[0].parts).toHaveLength(2);
    if (spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status === 0) {
      const directory = mkdtempSync(join(tmpdir(), 'paperloom-rotated-'));
      try {
        const path = join(directory, 'fixture.pdf'); writeFileSync(path, bytes);
        expect(execFileSync('pdftotext', ['-raw', path, '-'], { encoding: 'utf8' }).trim()).toBe('AlphaBeta');
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }
  });

  it('matches a substring across runs and suppresses a single-run rotated highlight too', async () => {
    const bytes = fixture(30);
    const cross = (await find(bytes, 'phaBe')).matches;
    expect(cross).toHaveLength(1);
    expect(cross[0]).toMatchObject({ matchedText: 'phaBe', highlightVisible: false });
    expect(cross[0].parts?.map(part => [part.start, part.end])).toEqual([[2, 5], [0, 2]]);
    const single = (await find(bytes, 'Alpha')).matches;
    expect(single).toHaveLength(1);
    expect(single[0]).toMatchObject({ source: 'page', highlightVisible: false });
  });

  it.each([
    ['gap', 2, 0, 30, false], ['offset baseline', 0, 2, 30, false],
    ['different orientation', 0, 0, 31, false], ['clipping', 0, 0, 30, true],
  ])('does not join runs with %s', async (_name, gap, offset, angle, clipped) => {
    expect((await find(fixture(30, gap, offset, angle, clipped))).matches).toHaveLength(0);
  });

  it('rejects rotated cross-run replacement before any mutation', async () => {
    const { doc, matches } = await find(fixture(90));
    const before = await serializeDocument(doc);
    await expect(replaceSearchMatches(doc, 'AlphaBeta', 'GammaZeta', false, engine, matches[0]))
      .rejects.toThrow('Replacing rotated text spanning multiple runs is not supported.');
    expect(await serializeDocument(doc)).toEqual(before);
    await expect(replaceSearchMatches(doc, 'AlphaBeta', 'GammaZeta', false, engine))
      .rejects.toThrow('Replacing rotated text spanning multiple runs is not supported.');
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('does not partially replace ordinary matches when replace all also includes rotated text', async () => {
    const prefix = 'BT /F1 12 Tf 1 0 0 1 10 25 Tm (AlphaBeta) Tj ET ';
    const { doc, matches } = await find(fixture(90, 0, 0, 90, false, prefix));
    expect(matches).toHaveLength(2);
    const before = await serializeDocument(doc);
    await expect(replaceSearchMatches(doc, 'AlphaBeta', 'GammaZeta', false, engine))
      .rejects.toThrow('Replacing rotated text spanning multiple runs is not supported.');
    expect(await serializeDocument(doc)).toEqual(before);
  });
});
