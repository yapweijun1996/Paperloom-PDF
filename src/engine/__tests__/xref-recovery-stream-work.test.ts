import { expect, it, vi } from 'vitest';
import { deflateSync } from 'node:zlib';
import { buildFullXref, parseXrefStream } from '../parser/xref';

function overlappingCandidates(type: string, count: number): Uint8Array {
  const objects = Array.from({ length: count }, (_, i) =>
    `${i + 1} 0 obj\n<< /Type /${type} /W [-1 0 0] /Length 500000 >>\nstream\n`).join('');
  return new TextEncoder().encode(`%PDF-1.7\n${objects}${' '.repeat(500100)}\nstartxref\n999999999\n%%EOF\n`);
}

it.each(['Other', 'XRef'])('does not repeatedly copy overlapping %s streams during recovery', async type => {
  const bytes = overlappingCandidates(type, 10);
  const original = Uint8Array.prototype.slice;
  let copied = 0;
  const spy = vi.spyOn(Uint8Array.prototype, 'slice').mockImplementation(function (this: Uint8Array, start?: number, end?: number) {
    const result = original.call(this, start, end);
    if (result.length >= 100_000) copied += result.length;
    return result;
  });
  try {
    await expect(buildFullXref(bytes)).rejects.toThrow();
    expect(copied).toBeLessThanOrEqual(bytes.length * 2);
  } finally { spy.mockRestore(); }
});

it('rejects repeated malformed xref candidates before their total stream work grows unbounded', async () => {
  await expect(buildFullXref(overlappingCandidates('XRef', 70))).rejects.toThrow(/byte work limit/i);
});

it('still decodes a valid compressed xref stream', async () => {
  const compressed = deflateSync(Buffer.from([1, 7, 0]));
  const pdf = Buffer.concat([
    Buffer.from(`1 0 obj\n<< /Type /XRef /Size 1 /W [1 1 1] /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`),
    compressed, Buffer.from('\nendstream\nendobj\n'),
  ]);
  expect((await parseXrefStream(pdf, 0)).entries.get('0_0')?.offset).toBe(7);
});

it.each([
  ['PNG predictor', Buffer.from([0, 1, 7, 0]), '/Filter /FlateDecode /DecodeParms << /Predictor 15 /Columns 3 >>'],
  ['multiple filters', Buffer.from('010700>'), '/Filter [/FlateDecode /ASCIIHexDecode]'],
])('preserves valid %s xref streams', async (_name, contents, settings) => {
  const compressed = deflateSync(contents);
  const pdf = Buffer.concat([
    Buffer.from(`1 0 obj\n<< /Type /XRef /Size 1 /W [1 1 1] ${settings} /Length ${compressed.length} >>\nstream\n`),
    compressed, Buffer.from('\nendstream\nendobj\n'),
  ]);
  expect((await parseXrefStream(pdf, 0)).entries.get('0_0')?.offset).toBe(7);
});

it.each(['plain', 'predictor', 'multiple filters'] as const)(
  'bounds cumulative decompression before %s output can discard intermediate bytes', async mode => {
    const contents = Buffer.alloc(1024 * 1024, mode === 'multiple filters' ? 32 : 0);
    const compressed = deflateSync(contents);
    const settings = mode === 'multiple filters' ? '/Filter [/FlateDecode /ASCIIHexDecode]'
      : mode === 'predictor' ? '/Filter /FlateDecode /DecodeParms << /Predictor 15 /Columns 1048577 >>'
        : '/Filter /FlateDecode';
    const chunks: Buffer[] = [Buffer.from('%PDF-1.7\n')];
    let offset = chunks[0].length;
    let previous: number | undefined;
    for (let i = 0; i < 40; i++) {
      const object = Buffer.concat([
        Buffer.from(`${i + 1} 0 obj\n<< /Type /XRef /Size 1 /W [0 0 0] ${settings} /Length ${compressed.length}${previous === undefined ? '' : ` /Prev ${previous}`} >>\nstream\n`),
        compressed, Buffer.from('\nendstream\nendobj\n'),
      ]);
      chunks.push(object);
      previous = offset;
      offset += object.length;
    }
    chunks.push(Buffer.from(`startxref\n${previous}\n%%EOF\n`));
    await expect(buildFullXref(Buffer.concat(chunks))).rejects.toThrow(/decoded.*limit|byte work limit/i);
  },
);

function recoveryWithTruncatedFlate(failures: number): Uint8Array {
  const packed = deflateSync(Buffer.alloc(1024 * 1024, 65));
  const damaged = packed.subarray(0, Math.floor(packed.length * 0.9));
  const valid = deflateSync(Buffer.from([0, 0, 0]));
  const objects: Buffer[] = [Buffer.from('%PDF-1.7\n')];
  for (let i = 0; i < failures; i++) objects.push(Buffer.concat([
    Buffer.from(`${i + 1} 0 obj\n<< /Type /XRef /Size 1 /W [0 0 0] /Filter /FlateDecode /Length ${damaged.length} >>\nstream\n`),
    damaged, Buffer.from('\nendstream\nendobj\n'),
  ]));
  objects.push(Buffer.concat([
    Buffer.from(`${failures + 1} 0 obj\n<< /Type /XRef /Size 1 /W [1 1 1] /Filter /FlateDecode /Length ${valid.length} >>\nstream\n`),
    valid, Buffer.from('\nendstream\nendobj\nstartxref\n0\n%%EOF\n'),
  ]));
  return Buffer.concat(objects);
}

it('continues recovery after a truncated stream while charging its failed decode', async () => {
  vi.stubGlobal('DecompressionStream', undefined);
  const originalSet = Uint8Array.prototype.set;
  let copied = 0;
  const spy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (this: Uint8Array, source: ArrayLike<number>, offset?: number) {
    if (source.length >= 4096) copied += source.length;
    return originalSet.call(this, source, offset);
  });
  try {
    const result = await buildFullXref(recoveryWithTruncatedFlate(1));
    expect(copied).toBeGreaterThan(100_000);
    expect(result.trailerDict.getName('Type')).toBe('XRef');
    expect(result.trailerDict.getArray('W')?.asNumbers()).toEqual([1, 1, 1]);
  } finally { spy.mockRestore(); vi.unstubAllGlobals(); }
});

it('stops repeated failed decompression before their discarded work exceeds the budget', async () => {
  vi.stubGlobal('DecompressionStream', undefined);
  try {
    await expect(buildFullXref(recoveryWithTruncatedFlate(2))).rejects.toThrow(/byte work limit/i);
  } finally { vi.unstubAllGlobals(); }
});
