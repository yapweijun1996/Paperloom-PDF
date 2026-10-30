import { afterEach, describe, expect, it, vi } from 'vitest';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { applyFilters, MAX_DECODED_STREAM_BYTES } from '../parser/filters';
import { parsePDF } from '../parser/parser';
import { PDFDict, PDFNumber } from '../types';
import { PDFStream } from '../types';
import { encryptDocumentObjects } from '../security/encryption/encrypt-pipeline';
import { securityEngine } from '../security/security-engine';
import { serializeDocument } from '../writer/serializer';
import { saveQuick } from '../writer/save-pipeline';
import { dehydrateDocument } from '../worker/codec';

const encode = (s: string) => new TextEncoder().encode(s);
const limited = (data: Uint8Array, names: string[], params: (PDFDict | null)[] = []) =>
  applyFilters(data, names, params, { maxDecodedBytes: 128 });

function lzwCodes(codes: number[]): Uint8Array {
  const bits = codes.map(code => code.toString(2).padStart(9, '0')).join('');
  const padded = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
  return Uint8Array.from(padded.match(/.{8}/g) ?? [], byte => parseInt(byte, 2));
}

function hugePredictorPDF(): Uint8Array {
  const stream = Buffer.from(deflateSync(Uint8Array.of(0))).toString('latin1');
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, object] of [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>',
    `<< /Length ${stream.length} /Filter /FlateDecode /DecodeParms << /Predictor 15 /Columns 134217729 >> >>\nstream\n${stream}\nendstream`,
  ].entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += 'xref\n0 5\n0000000000 65535 f \n';
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

function hugePredictorXrefPDF(): Uint8Array {
  const stream = Buffer.from(deflateSync(Uint8Array.of(0))).toString('latin1');
  const header = '%PDF-1.5\n';
  const object = `1 0 obj\n<< /Type /XRef /Size 1 /Root 2 0 R /W [1 4 2] /Length ${stream.length} /Filter /FlateDecode /DecodeParms << /Predictor 15 /Columns 134217729 >> >>\nstream\n${stream}\nendstream\nendobj\n`;
  return new Uint8Array(Buffer.from(`${header}${object}startxref\n${header.length}\n%%EOF\n`, 'latin1'));
}

afterEach(() => vi.unstubAllGlobals());

describe('bounded PDF stream decoding', () => {
  it.each(['native', 'manual'])('rejects a Flate expansion using %s decompression', async mode => {
    if (mode === 'manual') vi.stubGlobal('DecompressionStream', undefined);
    await expect(limited(deflateSync(Buffer.alloc(4096, 65)), ['FlateDecode'])).rejects.toThrow(/decoded.*limit/i);
  });

  it('decodes normal zlib and raw-deflate streams and allows the exact limit', async () => {
    const data = encode('hello bounded world');
    expect(await limited(deflateSync(data), ['FlateDecode'])).toEqual(data);
    expect(await limited(deflateRawSync(data), ['FlateDecode'])).toEqual(data);
    expect(await applyFilters(deflateSync(data), ['FlateDecode'], [], { maxDecodedBytes: data.length })).toEqual(data);
  });

  it.each(['native', 'manual'])('preserves a larger ordinary stream through %s decompression', async mode => {
    if (mode === 'manual') vi.stubGlobal('DecompressionStream', undefined);
    const original = Uint8Array.from({ length: 1_000_000 }, (_, index) => index % 251);
    const decoded = await applyFilters(deflateSync(original), ['FlateDecode'], []);
    expect(Buffer.compare(Buffer.from(decoded), Buffer.from(original))).toBe(0);
  });

  it('cancels native decoding on limit instead of retrying another decoder', async () => {
    const cancel = vi.fn();
    const create = vi.fn().mockImplementation(() => ({
      readable: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(129)); }, cancel }),
      writable: new WritableStream<Uint8Array>(),
    }));
    vi.stubGlobal('DecompressionStream', create);
    await expect(limited(Uint8Array.of(0), ['FlateDecode'])).rejects.toThrow(/decoded.*limit/i);
    expect(create).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not allow a caller to raise the global ceiling', async () => {
    await expect(applyFilters(Uint8Array.of(), [], [], { maxDecodedBytes: MAX_DECODED_STREAM_BYTES + 1 }))
      .rejects.toThrow(/invalid.*limit/i);
  });

  it('preserves normal non-Flate decoders at the exact size limit', async () => {
    const bytes = encode('AAA');
    const cases: [string, Uint8Array][] = [
      ['RunLengthDecode', Uint8Array.of(254, 65, 128)],
      ['ASCIIHexDecode', encode('414141>')],
      ['ASCII85Decode', encode('5s[d~>')],
      ['LZWDecode', lzwCodes([256, 65, 65, 65, 257])],
    ];
    for (const [name, input] of cases) {
      expect(await applyFilters(input, [name], [], { maxDecodedBytes: 3 })).toEqual(bytes);
    }
  });

  it.each([
    { name: 'RunLengthDecode', data: () => Uint8Array.from([...Array(2)].flatMap(() => [129, 65]).concat([128])) },
    { name: 'ASCII85Decode', data: () => encode('z'.repeat(33) + '~>') },
    { name: 'ASCIIHexDecode', data: () => encode('ab'.repeat(129) + '>') },
    { name: 'LZWDecode', data: () => lzwCodes([256, ...Array(129).fill(65), 257]) },
  ])('bounds $name output before allocation grows beyond the limit', async ({ name, data }) => {
    await expect(limited(data(), [name])).rejects.toThrow(/decoded.*limit/i);
  });

  it('bounds each intermediate filter result and predictor rows', async () => {
    await expect(limited(deflateSync(encode('z'.repeat(33) + '~>')), ['FlateDecode', 'ASCII85Decode']))
      .rejects.toThrow(/decoded.*limit/i);
    const params = new PDFDict([['Predictor', new PDFNumber(15)], ['Columns', new PDFNumber(129)]]);
    await expect(limited(deflateSync(Uint8Array.of(0)), ['FlateDecode'], [params])).rejects.toThrow(/decoded.*limit/i);
  });

  it('propagates predictor allocation errors through PDF parsing', async () => {
    await expect(parsePDF(hugePredictorPDF())).rejects.toThrow(/decoded.*limit/i);
  });

  it('does not bypass a cross-reference stream limit by rebuilding the xref', async () => {
    await expect(parsePDF(hugePredictorXrefPDF())).rejects.toThrow(/decoded.*limit/i);
  });

  it('propagates predictor allocation errors after decrypting a protected PDF', async () => {
    const safeFixture = Buffer.from(hugePredictorPDF()).toString('latin1')
      .replace('/Columns 134217729', '/Columns 000000001');
    const doc = await parsePDF(new Uint8Array(Buffer.from(safeFixture, 'latin1')));
    const stream = doc.objects.get('4_0');
    expect(stream).toBeInstanceOf(PDFStream);
    (stream as PDFStream).dict.getDict('DecodeParms')!.set('Columns', new PDFNumber(MAX_DECODED_STREAM_BYTES + 1));
    await encryptDocumentObjects(doc, { algorithm: 'AES-128', userPassword: 'fixture-open', ownerPassword: 'fixture-owner' });
    const encrypted = await parsePDF(await serializeDocument(doc));
    const before = dehydrateDocument(encrypted);
    await expect(securityEngine.open(encrypted, 'fixture-open')).rejects.toThrow(/decoded.*limit/i);
    expect(dehydrateDocument(encrypted)).toEqual(before);
  });

  it('still opens, saves and reopens a protected PDF whose decoded stream is within the limit', async () => {
    const safeFixture = Buffer.from(hugePredictorPDF()).toString('latin1')
      .replace('/Columns 134217729', '/Columns 000000001');
    const doc = await parsePDF(new Uint8Array(Buffer.from(safeFixture, 'latin1')));
    await encryptDocumentObjects(doc, { algorithm: 'AES-128', userPassword: 'fixture-open', ownerPassword: 'fixture-owner' });
    const protectedDoc = await parsePDF(await serializeDocument(doc));
    await securityEngine.open(protectedDoc, 'fixture-open');
    const reopened = await parsePDF(await saveQuick(protectedDoc));
    expect(securityEngine.isEncrypted(reopened)).toBe(true);
    await securityEngine.open(reopened, 'fixture-open');
    expect(reopened.pages).toHaveLength(1);
    expect((reopened.objects.get('4_0') as PDFStream).decodedBytes).toEqual(new Uint8Array());
  });
});
