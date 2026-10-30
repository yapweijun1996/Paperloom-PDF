import { describe, expect, it } from 'vitest';
import { buildFullXref, MAX_XREF_STREAM_ENTRIES } from '../parser/xref';

function chain(sections: Array<{ index: string; data: string; widths: string }>): Uint8Array {
  let pdf = '%PDF-1.7\n';
  let previous: number | undefined;
  sections.forEach((section, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n<< /Type /XRef /Size 250001 /W [${section.widths}] /Index [${section.index}] /Length ${section.data.length}${previous === undefined ? '' : ` /Prev ${previous}`} >>\nstream\n${section.data}\nendstream\nendobj\n`;
    previous = offset;
  });
  pdf += `startxref\n${previous}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

describe('cumulative xref work limits', () => {
  it('rejects total work across multiple zero-byte streams, including duplicate object indices', async () => {
    const half = Math.floor(MAX_XREF_STREAM_ENTRIES / 2);
    const pdf = chain([
      { index: `0 ${half}`, data: '', widths: '0 0 0' },
      { index: `0 ${half + 1}`, data: '', widths: '0 0 0' },
    ]);
    await expect(buildFullXref(pdf)).rejects.toThrow(/xref.*entry limit/i);
  });

  it('keeps separate legitimate revisions when their combined work fits', async () => {
    const pdf = chain([
      { index: '0 1', data: '\0', widths: '1 0 0' },
      { index: '1 1', data: '\0', widths: '1 0 0' },
    ]);
    const xref = await buildFullXref(pdf);
    expect(xref.entries.size).toBe(2);
    expect([...xref.entries.values()].every(entry => entry.type === 'f')).toBe(true);
  });

  it('does not bypass the bound through repeated subsection declarations', async () => {
    const half = Math.floor(MAX_XREF_STREAM_ENTRIES / 2);
    const pdf = chain([{ index: `0 ${half} 0 ${half + 1}`, data: '', widths: '0 0 0' }]);
    await expect(buildFullXref(pdf)).rejects.toThrow(/xref.*entry limit/i);
  });

  it('bounds recovery scans even when the same object is declared repeatedly', async () => {
    const objects = '1 0 obj\nendobj\n'.repeat(MAX_XREF_STREAM_ENTRIES + 1);
    const pdf = new TextEncoder().encode(`%PDF-1.7\n${objects}trailer\n<< /Size 2 >>\nstartxref\n0\n%%EOF\n`);
    await expect(buildFullXref(pdf)).rejects.toThrow(/xref recovery scan.*entry limit/i);
  });

  it('does not fall back to scanning after an excessive traditional table', async () => {
    const prefix = '%PDF-1.7\n';
    const pdf = new TextEncoder().encode(`${prefix}xref\n0 ${MAX_XREF_STREAM_ENTRIES + 1}\ntrailer\n<< /Size 1 >>\nstartxref\n${prefix.length}\n%%EOF\n`);
    await expect(buildFullXref(pdf)).rejects.toThrow(/xref table.*entry limit/i);
  });

  it('bounds accumulated work across malformed recovery candidates', async () => {
    const count = Math.floor(MAX_XREF_STREAM_ENTRIES / 2) + 1;
    const object = (i: number) => `${i} 0 obj\n<< /Type /XRef /Size ${count} /W [1 0 0] /Length 0 >>\nstream\n\nendstream\nendobj\n`;
    const pdf = new TextEncoder().encode(`%PDF-1.7\n${object(1)}${object(2)}startxref\n0\n%%EOF\n`);
    await expect(buildFullXref(pdf)).rejects.toThrow(/xref stream.*entry limit/i);
  });

  it('does not charge ordinary non-xref streams as recovery candidates', async () => {
    const ordinary = `1 0 obj\n<< /Type /Other /Size ${MAX_XREF_STREAM_ENTRIES + 1} /W [0 0 0] /Length 0 >>\nstream\n\nendstream\nendobj\n`;
    const xref = '2 0 obj\n<< /Type /XRef /Size 1 /W [1 0 0] /Index [0 1] /Length 1 >>\nstream\n\0\nendstream\nendobj\n';
    const pdf = new TextEncoder().encode(`%PDF-1.7\n${ordinary}${xref}startxref\n0\n%%EOF\n`);
    expect((await buildFullXref(pdf)).trailerDict.getName('Type')).toBe('XRef');
  });
});
