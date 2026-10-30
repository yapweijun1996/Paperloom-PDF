import { expect, it } from 'vitest';
import { rawPDF } from '@/engine/__tests__/audit-p1-fixtures';
import { parsePDF } from '@/engine/parser/parser';
import * as engine from '@/engine/browser-core';
import { DocumentSearchIndex, searchDocument } from './search-index';

it('does not restore an unsafe highlight for horizontally set text rotated by a Form matrix', async () => {
  const body = 'BT /F1 12 Tf 1 0 0 1 20 100 Tm (Alpha) Tj ET';
  const pageBody = 'q /Fm Do Q';
  const data = rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /XObject << /Fm 6 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    `<< /Length ${pageBody.length} >>\nstream\n${pageBody}\nendstream`,
    `<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] /Matrix [0 1 -1 0 200 0] /Resources << /Font << /F1 4 0 R >> >> /Length ${body.length} >>\nstream\n${body}\nendstream`,
  ]);
  const doc = await parsePDF(data);
  const matches = await searchDocument(doc, 'Alpha', false, '1', new DocumentSearchIndex(), engine, () => true);
  expect(matches).toHaveLength(1);
  expect(matches![0]).toMatchObject({ source: 'form', highlightVisible: false });
});
