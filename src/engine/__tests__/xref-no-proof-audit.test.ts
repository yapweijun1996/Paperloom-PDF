import { PDFString } from '../types';
import { parsePDF } from '../parser/parser';
import { saveQuick } from '../writer/save-pipeline';
import { expect, it } from 'vitest';

/** A damaged hybrid xref whose missing supplement contains compressed 5 0. */
function damagedHybrid(): Uint8Array {
  const chunks: Buffer[] = [], offsets = new Map<number, number>();
  let position = 0;
  const add = (value: string | Buffer) => { const bytes = typeof value === 'string' ? Buffer.from(value, 'latin1') : value; chunks.push(bytes); position += bytes.length; };
  const object = (number: number, body: string) => { offsets.set(number, position); add(`${number} 0 obj\n${body}\nendobj\n`); };
  add('%PDF-1.5\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R /Custom 5 0 R >>');
  object(2, '<< /Type /Pages /Count 1 /Kids [3 0 R] >>');
  object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources <<>> >>');
  const packed = Buffer.from('5 0 (compressed value)');
  offsets.set(10, position); add(`10 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Length ${packed.length} >>\nstream\n`);
  add(packed); add('\nendstream\nendobj\n');
  offsets.set(11, position); const entry = Buffer.from([2, 0, 0, 0, 10, 0, 0]);
  add(`11 0 obj\n<< /Type /XRef /Size 12 /W [1 4 2] /Index [5 1] /Length ${entry.length} >>\nstream\n`);
  add(entry); add('\nendstream\nendobj\n');
  const xref = position; add('xref\n0 4\n0000000000 65535 f \n');
  for (let i = 1; i <= 3; i++) add(`${String(offsets.get(i)).padStart(10, '0')} 00000 n \n`);
  add('10 2\n');
  for (let i = 10; i <= 11; i++) add(`${String(offsets.get(i)).padStart(10, '0')} 00000 n \n`);
  add(`trailer\n<< /Size 12 /Root 1 0 R /XRefStm ${offsets.get(11)! + 1} >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

it('rejects new unknown objects when a legacy snapshot has no xref proof', async () => {
  const doc = await parsePDF(damagedHybrid());
  expect(doc.objects.has('5_0')).toBe(false);
  doc.xref.provenance = undefined;
  const raw = doc.rawBytes, before = new Uint8Array(raw);
  await expect(saveQuick(doc, undefined, new Map([['5_0', new PDFString('overwrite')]])))
    .rejects.toThrow(/conflicts|xref|unavailable|incomplete/i);
  expect(doc.rawBytes).toBe(raw);
  expect(new Uint8Array(raw)).toEqual(before);
});
