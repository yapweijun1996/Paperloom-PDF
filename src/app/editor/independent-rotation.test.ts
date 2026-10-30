import { expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as engine from '@/engine/browser-core';
import { rawPDF } from '@/engine/__tests__/audit-p1-fixtures';
import { parsePDF } from '@/engine/parser/parser';
import { serializeDocument } from '@/engine/writer/serializer';
import { DocumentSearchIndex, searchDocument } from './search-index';

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

const hasPoppler = spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status === 0;

it.skipIf(!hasPoppler).each([30, 90, 180, 270])('preserves single-run rotation during replace and independent text extraction at %s degrees', async angle => {
  const {doc,matches}=await find(fixture(angle),'Alpha');
  const match=matches[0], page=doc.pages[0];
  const bytes=engine.getPageContentBytes(page,doc.objects);
  const replaced=engine.findAndReplace(bytes,page,doc.objects,'Alpha','Omega',false,{runIndex:match.runIndex,start:match.start,end:match.end,runText:match.runText},new engine.OptionalContentVisibility(doc.catalog,doc.objects));
  expect(replaced.replacedCount).toBe(1);
  await engine.updatePageContent(page.contentRefs,replaced.newContentBytes,doc.objects);
  const output=await serializeDocument(doc);
  const directory=mkdtempSync(join(tmpdir(),'paperloom-rotate-edit-'));
  try {
    const file=join(directory,'out.pdf'); writeFileSync(file,output);
    expect(execFileSync('pdftotext',['-raw',file,'-'],{encoding:'utf8'}).trim()).toBe('OmegaBeta');
  } finally {rmSync(directory,{recursive:true,force:true});}
});

it.each([
  ['character spacing', '1 Tc', ''],
  ['different text rendering modes', '', '3 Tr'],
  ['different direction', '', '0 -1 1 0 150 136 Tm'],
])('does not join rotated runs with %s', async (_label, first, second) => {
  const body=`BT /F1 12 Tf ${first} 0 1 -1 0 150 100 Tm (Alpha) Tj /F2 12 Tf 0 1 -1 0 150 136 Tm ${second} (Beta) Tj ET`;
  const bytes=rawPDF(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`]);
  expect((await find(bytes)).matches).toHaveLength(0);
});
