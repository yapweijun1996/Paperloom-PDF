import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { rawPDF } from './audit-p1-fixtures';
import { getPageContentBytes, parsePDF } from '../parser/parser';
import { encryptDocumentObjects } from '../security/encryption/encrypt-pipeline';
import { computeObjectKey, encryptBytes } from '../security/encryption/object-cipher';
import { PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, PDFString } from '../types';
import { buildXRefStream } from '../optimize/object-streams';
import { concatBytes, serializeIndirectObject } from '../editor/stream-compiler';
import { securityEngine } from '../security/security-engine';
import { dehydrateDocument, hydrateDocument } from '../worker/codec';
import { saveDocument } from '../writer/save-pipeline';
import { rotatePageBy } from '../writer/page-operations';

/** Generate encrypted object-stream data while leaving the xref stream clear. */
async function encryptedObjectStreamFixture(algorithm: 'RC4-128' | 'AES-128' | 'AES-256', malformedHeader = false, packedCatalog = false, extraStreams: 'none' | 'unreferenced' | 'referenced' = 'none', options: { compressedLength?: boolean; uncompressedLength?: boolean; cyclicLength?: boolean; embeddedMarker?: boolean; nestedLength?: boolean; lengthDelta?: number; infoBody?: string; headerSuffix?: string } = {}): Promise<Uint8Array> {
  const contents = '0 0 0 rg 10 10 20 20 re f';
  const pageTree = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  const page = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 4 0 R /Lang (en-GB) >>';
  const doc = await parsePDF(rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>', pageTree, page,
    `<< /Length ${contents.length} >>\nstream\n${contents}\nendstream`,
  ]));
  const sourceStream = doc.objects.get('4_0') as PDFStream;
  sourceStream.dict.set('FixtureLabel', new PDFString('source-secret'));
  sourceStream.dict.set('O', new PDFString('ordinary-O-value'));
  const ctx = await encryptDocumentObjects(doc, { algorithm, userPassword: 'reader', ownerPassword: 'owner' });
  const encryptRef = doc.xref.trailerDict.getRef('Encrypt')!;
  const containerNum = encryptRef.objNum + 1;
  const infoNum = containerNum + 1;
  const lengthNum = infoNum + 1;
  const otherLengthNum = infoNum + 2;
  const otherContainerNum = infoNum + 3;
  const xrefNum = extraStreams === 'none' ? infoNum + (options.nestedLength ? 4 : options.compressedLength || options.uncompressedLength ? 2 : 1) : 300;
  const info = options.infoBody ?? '<< /Title (Encrypted object info) >>';
  const packed: Array<[number, string]> = [[malformedHeader ? 42 : 2, pageTree], [3, page], [infoNum, info]];
  if (packedCatalog) packed.unshift([1, '<< /Type /Catalog /Pages 2 0 R >>']);
  if (options.compressedLength || options.uncompressedLength) {
    const encryptedPage = doc.objects.get('4_0') as PDFStream;
    if (options.embeddedMarker) {
      if (algorithm !== 'RC4-128') throw new Error('Marker fixture requires RC4-128');
      const plain = Buffer.from('% '.padEnd(44, 'A') + '\n' + contents, 'ascii');
      const streamKey = computeObjectKey(ctx.fileKey!, 4, 0, ctx.algorithm);
      const keyStream = await encryptBytes(new Uint8Array(plain.length), streamKey, ctx.algorithm);
      const marker = Buffer.from('endstream', 'ascii');
      let inserted = false;
      for (let start = 2; start <= 30 && !inserted; start++) {
        const replacement = marker.map((byte, index) => byte ^ keyStream[start + index]);
        if ([...replacement].some(byte => byte === 10 || byte === 13)) continue;
        plain.set(replacement, start); inserted = true;
      }
      if (!inserted) throw new Error('Could not construct marker fixture');
      encryptedPage.rawBytes = await encryptBytes(plain, streamKey, ctx.algorithm);
      if (!Buffer.from(encryptedPage.rawBytes).includes(marker)) throw new Error('Missing ciphertext marker');
    }
    if (options.compressedLength) packed.push([lengthNum, String(encryptedPage.rawBytes.length + (options.lengthDelta ?? 0))]);
    encryptedPage.dict.set('Length', new PDFRef(lengthNum, 0));
  }
  let position = 0;
  const prefix = packed.map(([num, obj]) => { const entry = `${num} ${position}`; position += obj.length + 1; return entry; }).join(' ') + ' ' + (options.headerSuffix ?? '');
  const compressed = deflateSync(Buffer.from(prefix + packed.map(([, object]) => object).join(' '), 'ascii'));
  const key = computeObjectKey(ctx.fileKey!, containerNum, 0, ctx.algorithm);
  const encrypted = await encryptBytes(compressed, key, ctx.algorithm);
  const dict = new PDFDict([
    ['Type', new PDFName('ObjStm')], ['N', new PDFNumber(packed.length)], ['First', new PDFNumber(prefix.length)],
    ['Length', new PDFNumber(encrypted.length)], ['Filter', new PDFName('FlateDecode')],
  ]);
  if (options.cyclicLength) dict.set('Length', new PDFRef(lengthNum, 0));
  if (options.nestedLength) dict.set('Length', new PDFRef(otherLengthNum, 0));
  const objects = [[4, doc.objects.get('4_0')!], [encryptRef.objNum, doc.objects.get(encryptRef.toKey())!], [containerNum, new PDFStream(dict, encrypted, null)]] as Array<readonly [number, import('../types').PDFObject]>;
  if (options.uncompressedLength) objects.push([lengthNum, new PDFNumber((doc.objects.get('4_0') as PDFStream).rawBytes.length)]);
  const extraMap = new Map<number, { containerObjNum: number; index: number }>();
  if (options.nestedLength) {
    const header = `${otherLengthNum} 0 `;
    const payload = deflateSync(Buffer.from(`${header}${encrypted.length}`, 'ascii'));
    const cipher = await encryptBytes(payload, computeObjectKey(ctx.fileKey!, otherContainerNum, 0, ctx.algorithm), ctx.algorithm);
    objects.push([otherContainerNum, new PDFStream(new PDFDict([['Type', new PDFName('ObjStm')], ['N', new PDFNumber(1)], ['First', new PDFNumber(header.length)], ['Length', new PDFNumber(cipher.length)], ['Filter', new PDFName('FlateDecode')]]), cipher, null)]);
    extraMap.set(otherLengthNum, { containerObjNum: otherContainerNum, index: 0 });
  }
  if (extraStreams !== 'none') {
    const count = extraStreams === 'unreferenced' ? 9 : 33;
    for (let i = 0; i < count; i++) {
      const num = infoNum + 1 + i;
      const objNum = 200 + i;
      const header = extraStreams === 'referenced' ? `${objNum} 0 ` : '';
      const plain = Buffer.from(header + (extraStreams === 'referenced' ? `(${'x'.repeat(1024 * 1024)})` : ' '.repeat(1024 * 1024)), 'ascii');
      const encoded = deflateSync(plain);
      const cipher = await encryptBytes(encoded, computeObjectKey(ctx.fileKey!, num, 0, ctx.algorithm), ctx.algorithm);
      objects.push([num, new PDFStream(new PDFDict([['Type', new PDFName('ObjStm')], ['N', new PDFNumber(extraStreams === 'referenced' ? 1 : 0)], ['First', new PDFNumber(header.length)], ['Length', new PDFNumber(cipher.length)], ['Filter', new PDFName('FlateDecode')]]), cipher, null)]);
      if (extraStreams === 'referenced') extraMap.set(objNum, { containerObjNum: num, index: 0 });
    }
  }
  if (!packedCatalog) objects.unshift([1, doc.objects.get('1_0')!]);
  const chunks: Uint8Array[] = [Buffer.from(algorithm === 'AES-256' ? '%PDF-1.7\n' : algorithm === 'AES-128' ? '%PDF-1.6\n' : '%PDF-1.5\n', 'ascii')];
  const offsets = new Map<number, { offset: number; genNum: number }>();
  let offset = chunks[0].length;
  for (const [num, obj] of objects) {
    offsets.set(num, { offset, genNum: 0 });
    const bytes = serializeIndirectObject(num, 0, obj); chunks.push(bytes); offset += bytes.length;
  }
  offsets.set(xrefNum, { offset, genNum: 0 });
  const packMap = new Map(packed.map(([number], index) => [number === 42 ? 2 : number, { containerObjNum: containerNum, index }]));
  for (const [key, entry] of extraMap) packMap.set(key, entry);
  const xref = await buildXRefStream(offsets, packMap, xrefNum, xrefNum, {
    root: new PDFRef(1, 0), info: new PDFRef(infoNum, 0), encrypt: encryptRef, id: doc.xref.trailerDict.get('ID'), size: xrefNum + 1,
  });
  chunks.push(xref.bytes, Buffer.from(`startxref\n${offset}\n%%EOF\n`, 'ascii'));
  return concatBytes(...chunks);
}

const hasPoppler = spawnSync('pdfinfo', ['-v'], { stdio: 'ignore' }).status === 0;
const hasQpdf = spawnSync('qpdf', ['--version'], { stdio: 'ignore' }).status === 0;

describe('encrypted object streams', () => {
  it.skipIf(!hasPoppler).each(['RC4-128', 'AES-128', 'AES-256'] as const)('opens %s content with length stored in an encrypted object stream', async algorithm => {
    const bytes = await encryptedObjectStreamFixture(algorithm, false, false, 'none', { compressedLength: true });
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-encrypted-length-'));
    try {
      const file = join(dir, 'source.pdf'); writeFileSync(file, bytes);
      expect(execFileSync('pdfinfo', ['-upw', 'reader', file], { encoding: 'utf8' })).toMatch(/Pages:\s+1/);
      if (hasQpdf) execFileSync('qpdf', ['--password=reader', '--check', file], { stdio: 'pipe' });
      const doc = await parsePDF(bytes);
      const before = dehydrateDocument(doc);
      await expect(securityEngine.open(doc, 'wrong')).rejects.toThrow(/password/i);
      expect(dehydrateDocument(doc)).toEqual(before);
      const opened = await securityEngine.open(doc, 'reader');
      expect(new TextDecoder().decode(getPageContentBytes(opened.doc.pages[0], opened.doc.objects))).toContain('10 10 20 20 re f');
      const saved = await saveDocument(opened.doc); writeFileSync(join(dir, 'saved.pdf'), saved);
      expect(execFileSync('pdfinfo', ['-upw', 'reader', join(dir, 'saved.pdf')], { encoding: 'utf8' })).toMatch(/Pages:\s+1/);
      if (hasQpdf) execFileSync('qpdf', ['--password=reader', '--check', join(dir, 'saved.pdf')], { stdio: 'pipe' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  it.skipIf(!hasPoppler)('uses the resolved length when ciphertext contains an endstream marker', async () => {
    const bytes = await encryptedObjectStreamFixture('RC4-128', false, false, 'none', { compressedLength: true, embeddedMarker: true });
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-encrypted-marker-'));
    try {
      const file = join(dir, 'source.pdf'); writeFileSync(file, bytes);
      if (hasQpdf) execFileSync('qpdf', ['--password=reader', '--check', file], { stdio: 'pipe' });
      execFileSync('pdftoppm', ['-upw', 'reader', '-singlefile', '-r', '72', file, join(dir, 'source')], { stdio: 'pipe' });
      const ppm = readFileSync(join(dir, 'source.ppm'));
      const header = /^P6\s+100\s+100\s+255\s/.exec(ppm.toString('latin1', 0, 64));
      if (!header) throw new Error('Unexpected Poppler output');
      const position = header[0].length + ((99 - 20) * 100 + 20) * 3;
      expect([...ppm.subarray(position, position + 3)]).toEqual([0, 0, 0]);
      const doc = await parsePDF(bytes);
      const opened = await securityEngine.open(doc, 'reader');
      expect(new TextDecoder('latin1').decode(getPageContentBytes(opened.doc.pages[0], opened.doc.objects))).toContain('10 10 20 20 re f');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('preserves an already resolved indirect length when ciphertext contains an endstream marker', async () => {
    const bytes = await encryptedObjectStreamFixture('RC4-128', false, false, 'none', { uncompressedLength: true, embeddedMarker: true });
    const doc = await parsePDF(bytes);
    expect(Buffer.from((doc.objects.get('4_0') as PDFStream).rawBytes).includes(Buffer.from('endstream'))).toBe(true);
    const opened = await securityEngine.open(doc, 'reader');
    expect(new TextDecoder('latin1').decode(getPageContentBytes(opened.doc.pages[0], opened.doc.objects))).toContain('10 10 20 20 re f');
  });

  it.skipIf(!hasPoppler)('resolves a chain of encrypted object streams through a worker snapshot', async () => {
    const bytes = await encryptedObjectStreamFixture('AES-128', false, false, 'none', { compressedLength: true, nestedLength: true });
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-encrypted-chain-'));
    try {
      const file = join(dir, 'source.pdf'); writeFileSync(file, bytes);
      expect(execFileSync('pdfinfo', ['-upw', 'reader', file], { encoding: 'utf8' })).toMatch(/Pages:\s+1/);
      if (hasQpdf) execFileSync('qpdf', ['--password=reader', '--check', file], { stdio: 'pipe' });
      const shell = hydrateDocument(dehydrateDocument(await parsePDF(bytes)));
      const doc = (await securityEngine.open(shell, 'reader')).doc;
      expect(new TextDecoder().decode(getPageContentBytes(doc.pages[0], doc.objects))).toContain('10 10 20 20 re f');
      const output = join(dir, 'saved.pdf'); writeFileSync(output, await saveDocument(doc));
      if (hasQpdf) execFileSync('qpdf', ['--password=reader', '--check', output], { stdio: 'pipe' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([-1, 1, 2])('rejects an incorrect compressed length (%i) without publishing', async lengthDelta => {
    const bytes = await encryptedObjectStreamFixture('AES-128', false, false, 'none', { compressedLength: true, lengthDelta });
    const doc = await parsePDF(bytes), before = dehydrateDocument(doc);
    await expect(securityEngine.open(doc, 'reader')).rejects.toThrow(/stream length/i);
    expect(dehydrateDocument(doc)).toEqual(before);
  });

  it('does not discard pre-authentication stream mutations', async () => {
    const bytes = await encryptedObjectStreamFixture('AES-128', false, false, 'none', { compressedLength: true });
    const doc = await parsePDF(bytes);
    (doc.objects.get('4_0') as PDFStream).rawBytes[0] ^= 1;
    const before = dehydrateDocument(doc);
    await expect(securityEngine.open(doc, 'reader')).rejects.toThrow(/changed before length resolution/i);
    expect(dehydrateDocument(doc)).toEqual(before);
  });

  it('rejects replacement of an unresolved length with the provisional slice length', async () => {
    const bytes = await encryptedObjectStreamFixture('RC4-128', false, false, 'none', { compressedLength: true, embeddedMarker: true });
    const doc = await parsePDF(bytes);
    const stream = doc.objects.get('4_0') as PDFStream;
    stream.dict.set('Length', new PDFNumber(stream.rawBytes.length));
    const before = dehydrateDocument(doc);
    await expect(securityEngine.open(doc, 'reader')).rejects.toThrow(/changed before length resolution/i);
    expect(dehydrateDocument(doc)).toEqual(before);
  });

  it.each(['indirect', 'direct'] as const)('rejects pre-authentication %s stream metadata changes', async lengthType => {
    const bytes = await encryptedObjectStreamFixture('AES-128', false, false, 'none', { compressedLength: lengthType === 'indirect' });
    const doc = await parsePDF(bytes);
    (doc.objects.get('4_0') as PDFStream).dict.set('Filter', new PDFName('FlateDecode'));
    const before = dehydrateDocument(doc);
    await expect(securityEngine.open(doc, 'reader')).rejects.toThrow(/changed before length resolution/i);
    expect(dehydrateDocument(doc)).toEqual(before);
  });

  it('rejects pre-authentication direct stream content changes', async () => {
    const doc = await parsePDF(await encryptedObjectStreamFixture('AES-128'));
    (doc.objects.get('4_0') as PDFStream).rawBytes[0] ^= 1;
    const before = dehydrateDocument(doc);
    await expect(securityEngine.open(doc, 'reader')).rejects.toThrow(/changed before length resolution/i);
    expect(dehydrateDocument(doc)).toEqual(before);
  });

  it('rejects an object stream whose own length depends on itself without mutation', async () => {
    const bytes = await encryptedObjectStreamFixture('AES-128', false, false, 'none', { compressedLength: true, cyclicLength: true });
    const doc = await parsePDF(bytes), before = dehydrateDocument(doc);
    await expect(securityEngine.open(doc, 'reader')).rejects.toThrow(/length|object.stream/i);
    expect(dehydrateDocument(doc)).toEqual(before);
  });
  it('does not inflate unreferenced object streams', async () => {
    const parsed = await parsePDF(await encryptedObjectStreamFixture('AES-128', false, false, 'unreferenced'));
    const opened = await securityEngine.open(parsed, 'reader');
    const streams = [...opened.doc.objects.values()].filter((object): object is PDFStream => object instanceof PDFStream && object.dict.getName('Type') === 'ObjStm');
    expect(streams.filter(stream => stream.decodedBytes !== null)).toHaveLength(1);
  });

  it('rejects excessive cumulative object stream expansion without publishing changes', async () => {
    const parsed = await parsePDF(await encryptedObjectStreamFixture('AES-128', false, false, 'referenced'));
    const original = dehydrateDocument(parsed);
    await expect(securityEngine.open(parsed, 'reader')).rejects.toThrow(/decoded.*limit/i);
    expect(dehydrateDocument(parsed)).toEqual(original);
  }, 30_000);

  it('rejects inconsistent object stream headers without publishing decrypted objects', async () => {
    const parsed = await parsePDF(await encryptedObjectStreamFixture('AES-128', true));
    const original = dehydrateDocument(parsed);
    await expect(securityEngine.open(parsed, 'reader')).rejects.toThrow(/object stream reference/i);
    expect(dehydrateDocument(parsed)).toEqual(original);
    expect(parsed.pages).toHaveLength(0);
  });

  it.each(['99 0 ', '% comment\n/Extra '])('rejects extra encrypted header tokens without publishing changes: %s', async headerSuffix => {
    const parsed = await parsePDF(await encryptedObjectStreamFixture('AES-128', false, false, 'none', { headerSuffix }));
    const original = dehydrateDocument(parsed);
    await expect(securityEngine.open(parsed, 'reader')).rejects.toThrow(/object stream header/i);
    expect(dehydrateDocument(parsed)).toEqual(original);
    expect(parsed.pages).toHaveLength(0);
  });

  it('accepts whitespace and comments after an encrypted object stream index', async () => {
    const parsed = await parsePDF(await encryptedObjectStreamFixture('AES-128', false, false, 'none', { headerSuffix: '% comment\n\t' }));
    await securityEngine.open(parsed, 'reader');
    expect(parsed.pages).toHaveLength(1);
  });

  it.each([
    ['truncated dictionary', '<< /Title (secret)'],
    ['extra object', '<< /Title (secret) >> (extra)'],
    ['unterminated string', '<< /Title (secret\\)'],
  ])('rejects an encrypted object stream containing a %s without publishing decrypted objects', async (_name, infoBody) => {
    const parsed = await parsePDF(await encryptedObjectStreamFixture('AES-128', false, false, 'none', { infoBody }));
    const original = dehydrateDocument(parsed);
    await expect(securityEngine.open(parsed, 'reader')).rejects.toThrow(/object stream member/i);
    expect(dehydrateDocument(parsed)).toEqual(original);
    expect(parsed.pages).toHaveLength(0);
  });

  it.skipIf(!hasPoppler).each([
    ['RC4-128', false], ['AES-128', false], ['AES-256', false], ['AES-128', true],
  ] as const)('authenticates, saves and reopens %s compressed page dictionaries (catalog packed: %s)', async (algorithm, packedCatalog) => {
    const bytes = await encryptedObjectStreamFixture(algorithm, false, packedCatalog);
    expect(Buffer.from(bytes).includes(Buffer.from('source-secret'))).toBe(false);
    const directory = mkdtempSync(join(tmpdir(), 'paperloom-encrypted-objstm-'));
    try {
      const file = join(directory, 'fixture.pdf'); writeFileSync(file, bytes);
      const originalInfo = execFileSync('pdfinfo', ['-upw', 'reader', file], { encoding: 'utf8' });
      expect(originalInfo).toMatch(/Pages:\s+1/);
      expect(originalInfo).toMatch(/Title:\s+Encrypted object info/);
      const parsed = await parsePDF(bytes);
      const original = dehydrateDocument(parsed);
      await expect(securityEngine.open(parsed, 'wrong')).rejects.toThrow(/password/i);
      expect(dehydrateDocument(parsed)).toEqual(original);
      const opened = await securityEngine.open(parsed, 'reader');
      expect(opened.doc.pages).toHaveLength(1);
      expect(opened.doc.info.title).toBe('Encrypted object info');
      expect(opened.doc.pages[0].dict.getString('Lang')).toBe('en-GB');
      expect((opened.doc.objects.get('4_0') as PDFStream).dict.getString('FixtureLabel')).toBe('source-secret');
      expect((opened.doc.objects.get('4_0') as PDFStream).dict.getString('O')).toBe('ordinary-O-value');
      expect(new TextDecoder().decode(getPageContentBytes(opened.doc.pages[0], opened.doc.objects))).toContain('10 10 20 20 re');
      rotatePageBy(opened.doc, 0, 90);
      (opened.doc.objects.get('4_0') as PDFStream).dict.set('FixtureLabel', new PDFString('edited-secret'));
      const saved = await saveDocument(opened.doc);
      const output = join(directory, 'saved.pdf'); writeFileSync(output, saved);
      const savedInfo = execFileSync('pdfinfo', ['-upw', 'reader', output], { encoding: 'utf8' });
      expect(savedInfo).toMatch(/Pages:\s+1/);
      expect(savedInfo).toMatch(/Title:\s+Encrypted object info/);
      expect(savedInfo).toMatch(/Page rot:\s+90/);
      const reopened = await securityEngine.open(await parsePDF(saved), 'reader');
      expect(reopened.doc.pages[0].dict.getString('Lang')).toBe('en-GB');
      expect((reopened.doc.objects.get('4_0') as PDFStream).dict.getString('FixtureLabel')).toBe('edited-secret');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);
});
