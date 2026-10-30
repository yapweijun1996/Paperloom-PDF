import assert from 'node:assert/strict';
import { parseContentStream } from '../../content/operator-lexer';
import { parsePDF } from '../../parser/parser';
import { PDFLexer } from '../../parser/lexer';
import { parseObject } from '../../parser/xref';
import { PDFArray, PDFDict, PDFNumber } from '../../types';
import { parseDER, parseDERNode } from '../../signatures/crypto/signature-verify';
import { listRevisions } from '../../writer/revision-manager';

function rawPDF(objects: string[]): Uint8Array {
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(pdf, char => char.charCodeAt(0));
}

const bytes = (text: string) => new TextEncoder().encode(text);
for (const delimiter of [')', '{', '}']) {
  const dict = parseObject(new PDFLexer(bytes(`<< /Before 1 ${delimiter} /After 2 >>`)));
  assert.ok(dict instanceof PDFDict);
  assert.equal(dict.getNumber('After'), 2);
  const array = parseObject(new PDFLexer(bytes(`[1 ${delimiter} 2]`)));
  assert.ok(array instanceof PDFArray);
  assert.equal(array.length, 3);
  assert.ok(array.get(2) instanceof PDFNumber);
  const instructions = parseContentStream(bytes(`BT [(a) ${delimiter} q (b)] TJ ET`));
  assert.equal(instructions.at(-2)?.operator, 'TJ');
  assert.equal((instructions.at(-2)?.operands[0] as PDFArray).length, 2);

  const content = `BT [(a) ${delimiter} q (b)] TJ ET`;
  const document = await parsePDF(rawPDF([
    `<< /Type /Catalog ${delimiter} /Pages 2 0 R /Broken [1 ${delimiter} 2] >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]));
  assert.equal(document.pages.length, 1);
}

const pageCycleFixtures = [
  ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [2 0 R] /Count 1 >>'],
  ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Pages /Kids [2 0 R] /Count 1 >>'],
  ['<< /Type /Catalog /Pages 2 0 R >>', '3 0 R', '2 0 R'],
  ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 3 0 R] /Count 2 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>'],
];
for (const fixture of pageCycleFixtures) {
  await assert.rejects(parsePDF(rawPDF(fixture)), /cyclic|duplicate/i);
}
await assert.rejects(parsePDF(rawPDF([
  '<< /Type /Catalog /Pages 2 0 R >>',
  `<< /Type /Pages /Kids [${'3 0 R '.repeat(100_001)}] /Count 100001 >>`,
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>',
])), /page tree.*node limit/i);

// A long valid page tree must not overflow the JavaScript call stack.
const depth = 6000;
const deepTree = ['<< /Type /Catalog /Pages 2 0 R >>'];
for (let i = 0; i < depth; i++) {
  deepTree.push(`<< /Type /Pages /Kids [${i + 3} 0 R] /Count 1 >>`);
}
deepTree.push(`<< /Type /Page /Parent ${depth + 1} 0 R /MediaBox [0 0 100 100] >>`);
assert.equal((await parsePDF(rawPDF(deepTree))).pages.length, 1);

const refChain = ['<< /Type /Catalog /Pages 2 0 R >>'];
for (let i = 0; i < depth; i++) refChain.push(`${i + 3} 0 R`);
refChain.push('<< /Type /Pages /Kids [6003 0 R] /Count 1 >>');
refChain.push('<< /Type /Page /Parent 6002 0 R /MediaBox [0 0 100 100] >>');
assert.equal((await parsePDF(rawPDF(refChain))).pages.length, 1);

// Test self-referencing and mutually cyclic cross-reference revision links.
function cyclicXref(mutual: boolean): Uint8Array {
  let pdf = '%PDF-1.4\n';
  const offsets = [
    pdf.length,
  ];
  pdf += '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  offsets.push(pdf.length);
  pdf += '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';
  offsets.push(pdf.length);
  pdf += '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>\nendobj\n';
  const first = pdf.length;
  pdf += 'xref\n0 4\n0000000000 65535 f \n';
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += 'trailer\n<< /Size 4 /Root 1 0 R /Prev 9999999999 >>\n';
  if (mutual) {
    const second = pdf.length;
    pdf += `xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 4 /Root 1 0 R /Prev ${first} >>\nstartxref\n${second}\n%%EOF\n`;
    pdf = pdf.replace('9999999999', String(second).padStart(10, '0'));
  } else {
    pdf = pdf.replace('9999999999', String(first).padStart(10, '0'));
    pdf += `startxref\n${first}\n%%EOF\n`;
  }
  return bytes(pdf);
}
for (const mutual of [false, true]) {
  const pdf = cyclicXref(mutual);
  await assert.rejects(parsePDF(pdf), /cyclic.*xref/i);
  assert.throws(() => listRevisions(pdf), /cyclic.*xref/i);
}

function manyRevisions(count: number): Uint8Array {
  let pdf = '%PDF-1.4\n';
  let previous: number | undefined;
  for (let i = 0; i < count; i++) {
    const offset = pdf.length;
    pdf += `xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 /Root 1 0 R${previous === undefined ? '' : ` /Prev ${previous}`} >>\n`;
    previous = offset;
  }
  return bytes(`${pdf}startxref\n${previous}\n%%EOF\n`);
}
const tooManyRevisions = manyRevisions(10_001);
await assert.rejects(parsePDF(tooManyRevisions), /xref.*revision limit/i);
assert.throws(() => listRevisions(tooManyRevisions), /xref.*revision limit/i);

function validIncrementalPdf(): Uint8Array {
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, body] of [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>',
  ].entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const first = pdf.length;
  pdf += 'xref\n0 4\n0000000000 65535 f \n';
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += 'trailer\n<< /Size 4 /Root 1 0 R >>\n';
  const updatedPage = pdf.length;
  pdf += '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 150 100] >>\nendobj\n';
  const last = pdf.length;
  pdf += `xref\n3 1\n${String(updatedPage).padStart(10, '0')} 00000 n \ntrailer\n<< /Size 4 /Root 1 0 R /Prev ${first} >>\nstartxref\n${last}\n%%EOF\n`;
  return bytes(pdf);
}
assert.equal((await parsePDF(validIncrementalPdf())).pages[0].mediaBox.width, 150);
assert.equal(listRevisions(validIncrementalPdf()).revisions.length, 2);

const invalid = [
  [0x30, 6, 0x04, 0x84, 0xff, 0xff, 0xff, 0xfa], // signed overflow formerly produced a zero-sized child
  [0x30, 0x84, 0x80, 0, 0, 0],
  [0x30, 0x82, 0x01], // truncated long-form length
  [0x30, 0x80, 0, 0], // indefinite length is not DER
  [0x30, 2, 0x04, 3, 0x61, 0x62, 0x63], // child crosses parent boundary
  [0x1f, 0x81], // truncated high tag
];
for (const input of invalid) assert.throws(() => parseDERNode(Uint8Array.from(input)));
for (const offset of [-1, 3, 0.5, Number.NaN]) assert.throws(() => parseDERNode(Uint8Array.of(0x05, 0), offset));
const encodeLength = (n: number): number[] => n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
let nested: number[] = [0x05, 0];
for (let i = 0; i < 140; i++) nested = [0x30, ...encodeLength(nested.length), ...nested];
assert.throws(() => parseDERNode(Uint8Array.from(nested)), /nesting/i);
const valid = parseDER(Uint8Array.of(0x30, 6, 0x02, 1, 5, 0x04, 1, 65));
assert.equal(valid.children?.length, 2);
assert.deepEqual([...valid.children![1].content], [65]);
console.log('termination checks passed');
