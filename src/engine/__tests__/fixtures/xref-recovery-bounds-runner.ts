import assert from 'node:assert/strict';
import { buildFullXref, MAX_XREF_RANGES } from '../../parser/xref';

// More objects than JavaScript engines commonly permit as function arguments.
const objectCount = 150_000;
let pdf = '%PDF-1.7\n';
for (let i = 1; i <= objectCount; i++) pdf += `${i} 0 obj\nendobj\n`;
pdf += 'trailer\n<< >>\nstartxref\n0\n%%EOF\n';
const recovered = await buildFullXref(new TextEncoder().encode(pdf));
assert.equal(recovered.entries.size, objectCount);
assert.equal(recovered.trailerDict.getNumber('Size'), objectCount + 1);

// Both individual array allocation and total work across /Prev revisions are
// bounded even when every subsection has a zero count.
const section = (n: number, prev?: number) => `1 0 obj\n<< /Type /XRef /Size 1 /W [0 0 0] /Index [${'0 0 '.repeat(n)}] /Length 0${prev === undefined ? '' : ` /Prev ${prev}`} >>\nstream\n\nendstream\nendobj\n`;
const header = '%PDF-1.7\n';
const one = section(MAX_XREF_RANGES + 1);
await assert.rejects(buildFullXref(new TextEncoder().encode(`${header}${one}startxref\n${header.length}\n%%EOF\n`)), /range limit/i);
const first = section(MAX_XREF_RANGES / 2 + 1);
const second = section(MAX_XREF_RANGES / 2, header.length);
await assert.rejects(buildFullXref(new TextEncoder().encode(`${header}${first}${second}startxref\n${header.length + first.length}\n%%EOF\n`)), /range limit/i);
console.log('xref recovery bounds passed');
