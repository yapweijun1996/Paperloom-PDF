import assert from 'node:assert/strict';
import { parseXrefStream } from '../../parser/xref';

const bytes = (dict: string, data = '') => new TextEncoder().encode(
  `1 0 obj\n<< /Type /XRef ${dict} /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj\n`,
);

const invalid = [
  '/Size 1 /W [999999999999999 0 0]',
  '/Size 999999999999999 /W [0 0 0]',
  '/Size 2 /W [1 1 1] /Index [0 2]',
  '/Size 1 /W [-1 1 1]',
  '/Size 1 /W [1 1]',
  '/Size 1 /W [1 1 1] /Index [0]',
  '/Size 1 /W [1 1 1] /Index [-1 1]',
];
for (const dict of invalid) await assert.rejects(parseXrefStream(bytes(dict), 0), /xref/i);
console.log('xref stream bounds passed');
