import { describe, expect, it } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rawPDF } from '@/engine/__tests__/audit-p1-fixtures';
import { parsePDF } from '@/engine/parser/parser';
import * as engine from '@/engine/browser-core';
import { DocumentSearchIndex, searchDocument } from './search-index';

const font = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>';
function pageFixture(body: string, form = false): Uint8Array {
  const content = form ? 'q /Fm Do Q' : body;
  const resources = form ? '/Font << /F1 4 0 R >> /XObject << /Fm 6 0 R >>' : '/Font << /F1 4 0 R >>';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << ${resources} >> /Contents 5 0 R >>`,
    font, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  if (form) objects.push(`<< /Type /XObject /Subtype /Form /BBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Length ${body.length} >>\nstream\n${body}\nendstream`);
  return rawPDF(objects);
}
function logicalFixture(): Uint8Array {
  const body = 'BT /F1 12 Tf 0 1 -1 0 150 100 Tm (Apha) Tj ET';
  const cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Test def /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <41> <0041006c> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end';
  return rawPDF(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /ToUnicode 6 0 R >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`, `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`]);
}
async function query(data: Uint8Array) {
  const doc = await parsePDF(data);
  return (await searchDocument(doc, 'Alpha', false, '1', new DocumentSearchIndex(), engine, () => true))!;
}
const vertical = 'BT /F1 12 Tf 2 Tc 0 1 -1 0 150 100 Tm (Alpha) Tj ET';

describe('search highlight geometry safety', () => {
  it('suppresses the wrong horizontal highlight for spaced vertical text, whose bbox Poppler verifies', async () => {
    const data = pageFixture(vertical), hits = await query(data);
    expect(hits).toHaveLength(1);
    expect(hits[0].highlightVisible).toBe(false);
    if (spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status === 0) {
      const dir = mkdtempSync(join(tmpdir(), 'rotation-highlight-'));
      try {
        const path = join(dir, 'page.pdf'); writeFileSync(path, data);
        const bbox = execFileSync('pdftotext', ['-bbox', path, '-'], { encoding: 'utf8' });
        const word = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">Alpha<\/word>/.exec(bbox);
        expect(word).not.toBeNull();
        expect(300 - Number(word![2])).toBeGreaterThan(hits[0].pdfY + hits[0].pdfHeight + 20);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
  it.each([
    ['rotation in a clipped page', pageFixture(`q 0 0 300 300 re W n ${vertical} Q`)],
    ['rotation inside a Form with a valid clip', pageFixture(vertical, true)],
    ['multiple Unicode characters from one glyph', logicalFixture()],
    ['a reflected baseline', pageFixture('BT /F1 12 Tf 2 Tc -1 0 0 -1 150 100 Tm (Alpha) Tj ET')],
    ['sheared text', pageFixture('BT /F1 12 Tf 1 0.3 0 1 150 100 Tm (Alpha) Tj ET')],
  ])('does not report an unsafe axis-aligned highlight for %s', async (_name, data) => {
    const hits = await query(data);
    expect(hits).toHaveLength(1);
    expect(hits[0].highlightVisible).toBe(false);
  });
  it('preserves normal horizontal highlights when text has character spacing', async () => {
    const hits = await query(pageFixture('BT /F1 12 Tf 2 Tc 1 0 0 1 20 100 Tm (Alpha) Tj ET'));
    expect(hits).toHaveLength(1);
    expect(hits[0].highlightVisible).not.toBe(false);
    expect(hits[0].pdfWidth).toBeGreaterThan(30);
  });
});
