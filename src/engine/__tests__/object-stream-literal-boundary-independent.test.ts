import { describe, expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';
import { PDFArray, PDFString } from '../types';

function fixture(options: { index5?: number; index6?: number; header?: string; first?: number;
  count?: number; type?: string; container?: number; firstBody?: string; secondBody?: string } = {}): Uint8Array {
  let text = '%PDF-1.7\n';
  const offsets: number[] = [];
  const object = (num: number, body: string) => { offsets[num] = text.length; text += `${num} 0 obj\n${body}\nendobj\n`; };
  object(1, '<< /Type /Catalog /Pages 2 0 R /Custom 5 0 R >>');
  object(2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>');
  object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> >>');
  const first = options.firstBody ?? '(ALPHA) ', second = options.secondBody ?? '(BRAVO)';
  const header = options.header ?? `5 0 6 ${first.length} `, stream = header + first + second;
  object(4, `<< /Type /${options.type ?? 'ObjStm'} /N ${options.count ?? 2} /First ${options.first ?? header.length} /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  const xrefOffset = text.length;
  offsets[7] = xrefOffset;
  const data = new Uint8Array(8 * 7);
  const xref = (obj: number, type: number, value: number, extra: number) => {
    const p = obj * 7; data[p] = type; data[p + 1] = value >>> 24; data[p + 2] = value >>> 16;
    data[p + 3] = value >>> 8; data[p + 4] = value; data[p + 5] = extra >>> 8; data[p + 6] = extra;
  };
  xref(0, 0, 0, 65535);
  for (const i of [1, 2, 3, 4, 7]) xref(i, 1, offsets[i], 0);
  xref(5, 2, options.container ?? 4, options.index5 ?? 0);
  xref(6, 2, 4, options.index6 ?? 1);
  const prefix = Buffer.from(text + `7 0 obj\n<< /Type /XRef /Size 8 /Root 1 0 R /W [1 4 2] /Length ${data.length} >>\nstream\n`, 'latin1');
  const suffix = Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1');
  return new Uint8Array(Buffer.concat([prefix, data, suffix]));
}



describe('object stream literal string boundaries', () => {
  it.each([
    ['CRLF continuation', 'a\\\r\nb', 'ab'],
    ['CR continuation', 'a\\\rb', 'ab'],
    ['LF continuation', 'a\\\nb', 'ab'],
    ['one-digit octal', 'a\\1b', 'a\x01b'],
    ['two-digit octal', 'a\\12b', 'a\x0ab'],
    ['three-digit octal and escaped brackets', 'a\\050b\\051', 'a(b)'],
    ['three-digit maximum octal', 'a\\377b', 'a\xffb'],
  ])('reads %s without crossing into the next member', async (_name, literal, expected) => {
    const source = fixture({ firstBody: `[(${literal})] ` });
    const doc = await parsePDF(source);
    const first = doc.objects.get('5_0') as PDFArray;
    expect(first.items).toHaveLength(1);
    expect((first.items[0] as PDFString).value).toBe(expected);
    expect((doc.objects.get('6_0') as PDFString).value).toBe('BRAVO');
  });
});
