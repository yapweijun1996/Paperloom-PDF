import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { parsePDF, getPageContentBytes } from '../parser/parser';
import { updatePageContent } from '../editor/stream-compiler';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, PDFString } from '../types';
import { serializeDocument, serializeDocumentCompact } from '../writer/serializer';
import { appendIncrementalUpdate } from '../writer/incremental-writer';
import { saveQuick } from '../writer/save-pipeline';
import { saveQuick as saveQuickWorker } from '../worker/client';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { preparePartialGraphicsRedaction, PartialGraphicsRedactionUnsupportedError } from '../security/redaction/partial-graphics-redaction';

async function fixture(content = 'q 20 0 0 20 10 10 cm /Im0 Do Q\n1 0 0 rg 15 15 5 5 re f\n0 0 1 rg 100 100 10 10 re f') {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Retained info');
  pdf.addPage([200, 200]);
  pdf.addPage([200, 200]);
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  const imageRef = new PDFRef(900, 0);
  const maskRef = new PDFRef(901, 0);
  const image = new TextEncoder().encode('PRIVATE_IMAGE_DATA');
  const mask = new TextEncoder().encode('PRIVATE_IMAGE_MASK');
  doc.objects.set(maskRef.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(mask.length)]]), mask, mask));
  doc.objects.set(imageRef.toKey(), new PDFStream(new PDFDict([
    ['Subtype', new PDFName('Image')], ['Length', new PDFNumber(image.length)], ['SMask', maskRef],
  ]), image, image));
  doc.pages[0].resources = content.includes('/Im0')
    ? new PDFDict([['XObject', new PDFDict([['Im0', imageRef]])]]) : new PDFDict();
  doc.pages[0].dict.set('Resources', doc.pages[0].resources);
  await updatePageContent(doc.pages[0].contentRefs, new TextEncoder().encode(content), doc.objects, false);
  return parsePDF(await serializeDocument(doc));
}
function mark(doc: Awaited<ReturnType<typeof parsePDF>>, rect = { x: 5, y: 5, width: 30, height: 30 }) {
  return redactionEngine.markRegion(doc, 0, rect);
}
function compressContent(doc: Awaited<ReturnType<typeof parsePDF>>, filter = 'FlateDecode'): PDFStream {
  const stream = doc.objects.get(doc.pages[0].contentRefs[0].toKey()) as PDFStream;
  stream.rawBytes = new Uint8Array(deflateSync(stream.rawBytes));
  stream.decodedBytes = null;
  stream.dict.set('Length', new PDFNumber(stream.rawBytes.length));
  stream.dict.set('Filter', new PDFName(filter));
  return stream;
}

describe('partial image safety boundaries', () => {
  it.each([
    ['39 0 0 43 10 10', { x: 19.75, y: 31.5, width: 9.75, height: 10.75 }],
    ['34 0 0 26 10 10', { x: 18.5, y: 16.5, width: 8.5, height: 6.5 }],
    ['-40 0 0 40 50 10', { x: 10, y: 40, width: 10, height: 10 }],
    ['40 0 0 -40 10 50', { x: 10, y: 40, width: 10, height: 10 }],
  ])('refuses partial coverage at raster-sensitive image boundaries: %s', async (matrix, rect) => {
    const doc = await fixture(`q ${matrix} cm /Im0 Do Q`);
    const pixels = Uint8Array.from({ length: 48 }, (_, index) => 41 + index * 3);
    doc.objects.set('900_0', new PDFStream(new PDFDict([
      ['Type', new PDFName('XObject')], ['Subtype', new PDFName('Image')],
      ['Width', new PDFNumber(4)], ['Height', new PDFNumber(4)],
      ['BitsPerComponent', new PDFNumber(8)], ['ColorSpace', new PDFName('DeviceRGB')],
      ['Length', new PDFNumber(pixels.length)],
    ]), pixels));
    mark(doc, rect);
    const before = await serializeDocument(doc);
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/partially intersects/);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });
});

describe('partial graphics redaction', () => {
  it.each(['S', 'B', 'B*', 's', 'b', 'b*'])('removes a fully covered stroked rectangle painted with %s', async operator => {
    const doc = await fixture(`4 w 1 0 0 RG 1 0 0 rg 20 20 10 10 re ${operator}\n0 0 1 rg 100 100 10 12 re f`);
    mark(doc, { x: 15, y: 15, width: 20, height: 20 });
    expect((await redactionEngine.applySecureRedactions(doc)).pathOperatorsRemoved).toBe(1);
    const output = await saveQuick(doc);
    const reopened = await parsePDF(output);
    const content = new TextDecoder().decode(getPageContentBytes(reopened.pages[0], reopened.objects));
    expect(content).not.toContain('20 20 10 10 re');
    expect(content).toContain('100 100 10 12 re');
    expect((await PDFDocument.load(output)).getPageCount()).toBe(2);
  });

  it('rejects a partially covered stroke and zero-width hairline before mutation', async () => {
    for (const [width, area] of [[4, { x: 19, y: 19, width: 12, height: 12 }], [0, { x: 10, y: 10, width: 30, height: 30 }]] as const) {
      const doc = await fixture(`${width} w 20 20 10 10 re S`);
      mark(doc, area);
      const before = await serializeDocument(doc);
      expect(() => preparePartialGraphicsRedaction(doc)).toThrow(PartialGraphicsRedactionUnsupportedError);
      expect(await serializeDocument(doc)).toEqual(before);
      expect(doc.requiresFullRewrite).toBeUndefined();
    }
  });

  it('restores line width after a nested graphics state', async () => {
    const doc = await fixture('q 40 w Q 20 20 10 10 re S');
    mark(doc, { x: 18, y: 18, width: 14, height: 14 });
    expect((await redactionEngine.applySecureRedactions(doc)).pathOperatorsRemoved).toBe(1);
  });

  it('rejects a retained duplicate stroked rectangle before mutation', async () => {
    const doc = await fixture('2 w 20 20 10 10 re S 100 100 10 10 re S');
    mark(doc, { x: 15, y: 15, width: 20, height: 20 });
    const before = await serializeDocument(doc);
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/duplicates removed vector/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it.each([
    '% comment\n2 w 100 100 10 10 re S',
    '100 100 m 110 100 l 110 110 l 100 110 l h S',
    'BT (retained data) Tj ET 100 100 10 10 re S',
    'BI /W 1 /H 1 /BPC 8 /CS /G ID x EI 100 100 10 10 re S',
  ])('refuses retained streams whose syntax prevents duplicate checks without mutation: %s', async retained => {
    const doc = await fixture('2 w 20 20 10 10 re S');
    await updatePageContent(doc.pages[1].contentRefs, new TextEncoder().encode(retained), doc.objects, false);
    mark(doc, { x: 15, y: 15, width: 20, height: 20 });
    const before = await serializeDocument(doc);
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/cannot be checked/);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('checks retained raw stream bytes instead of a stale decoded cache', async () => {
    const doc = await fixture('2 w 20 20 10 10 re S');
    await updatePageContent(doc.pages[1].contentRefs, new TextEncoder().encode('100 100 10 10 re S'), doc.objects, false);
    const stream = doc.objects.get(doc.pages[1].contentRefs[0].toKey()) as PDFStream;
    stream.decodedBytes = new TextEncoder().encode('100 100 20 20 re S');
    mark(doc, { x: 15, y: 15, width: 20, height: 20 });
    const before = await serializeDocument(doc);
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/duplicates removed vector/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('rejects a duplicate rectangle in a multi-rectangle retained path', async () => {
    const doc = await fixture('2 w 20 20 10 10 re S');
    await updatePageContent(doc.pages[1].contentRefs, new TextEncoder().encode('100 100 10 10 re 140 140 12 12 re S'), doc.objects, false);
    mark(doc, { x: 15, y: 15, width: 20, height: 20 });
    const before = await serializeDocument(doc);
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/duplicates removed vector/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it.each([
    ['2 w 20 20 10 10 re S', 'q 2 0 0 2 100 100 cm 0 0 5 5 re S Q'],
    ['q 2 0 0 2 0 0 cm 10 10 5 5 re S Q', '100 100 10 10 re S'],
    ['q 0 1 -1 0 30 20 cm 0 0 10 5 re S Q', '100 100 5 10 re S'],
  ])('rejects a geometrically equivalent rectangle under a different CTM', async (removed, retained) => {
    const doc = await fixture(removed);
    await updatePageContent(doc.pages[1].contentRefs, new TextEncoder().encode(retained), doc.objects, false);
    mark(doc, { x: 15, y: 15, width: 20, height: 20 });
    const before = await serializeDocument(doc);
    await expect(redactionEngine.applySecureRedactions(doc)).rejects.toThrow(/duplicates removed vector/);
    expect(await serializeDocument(doc)).toEqual(before);
    const reopened = await parsePDF(before);
    expect(new TextDecoder().decode(getPageContentBytes(reopened.pages[1], reopened.objects))).toContain(retained);
  });

  it('refuses an unverifiable retained binary resource when removing vector geometry', async () => {
    const doc = await fixture('20 20 10 10 re S');
    const ref = new PDFRef(990, 0);
    const data = new Uint8Array([0x80, 0xff]);
    doc.objects.set(ref.toKey(), new PDFStream(new PDFDict(), data, data));
    doc.catalog.set('RetainedResource', ref);
    mark(doc, { x: 15, y: 15, width: 20, height: 20 });
    const before = await serializeDocument(doc);
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/cannot be checked/);
    expect(await serializeDocument(doc)).toEqual(before);
  });
  it.each([false, true])('removes distinct graphics under multiple marks (compressed: %s)', async compressed => {
    const doc = await fixture('1 0 0 rg 15 15 5 5 re f\n0 1 0 rg 55 55 9 7 re f\n0 0 1 rg 100 100 10 10 re f');
    if (compressed) compressContent(doc);
    mark(doc);
    mark(doc, { x: 50, y: 50, width: 20, height: 20 });
    const result = await redactionEngine.applySecureRedactions(doc);
    expect(result).toMatchObject({ pagesProcessed: 1, pathOperatorsRemoved: 2, annotationsRemoved: 2 });
    const output = await saveQuick(doc);
    const reopened = await parsePDF(output);
    const content = new TextDecoder().decode(getPageContentBytes(reopened.pages[0], reopened.objects));
    expect(content).not.toContain('15 15 5 5 re');
    expect(content).not.toContain('55 55 9 7 re');
    expect(content).toContain('100 100 10 10 re');
    expect(reopened.pages[0].dict.has('Annots')).toBe(false);
    expect((await PDFDocument.load(output)).getPageCount()).toBe(2);
  });

  it('rejects a partial or empty mark in a multi-mark operation without mutation', async () => {
    for (const rect of [{ x: 60, y: 55, width: 10, height: 10 }, { x: 140, y: 140, width: 10, height: 10 }]) {
      const doc = await fixture('15 15 5 5 re f 55 55 9 7 re f');
      mark(doc);
      mark(doc, rect);
      const before = await serializeDocument(doc);
      expect(() => preparePartialGraphicsRedaction(doc)).toThrow(PartialGraphicsRedactionUnsupportedError);
      expect(await serializeDocument(doc)).toEqual(before);
      expect(doc.requiresFullRewrite).toBeUndefined();
    }
  });

  it('allows overlapping marks when one fully contains the object', async () => {
    const doc = await fixture('15 15 5 5 re f 100 100 10 10 re f');
    mark(doc);
    mark(doc, { x: 18, y: 18, width: 10, height: 10 });
    expect((await redactionEngine.applySecureRedactions(doc))).toMatchObject({ annotationsRemoved: 2, pathOperatorsRemoved: 1 });
    const reopened = await parsePDF(await saveQuick(doc));
    expect(new TextDecoder().decode(getPageContentBytes(reopened.pages[0], reopened.objects))).not.toContain('15 15 5 5 re');
  });

  it.each([false, true])('removes a rectangle covered by a union of four marks (compressed: %s)', async compressed => {
    const doc = await fixture('1 0 0 rg 15 15 10 10 re f 0 0 1 rg 100 100 10 12 re f');
    if (compressed) compressContent(doc);
    for (const area of [
      { x: 14, y: 14, width: 6, height: 6 }, { x: 20, y: 14, width: 6, height: 6 },
      { x: 14, y: 20, width: 6, height: 6 }, { x: 20, y: 20, width: 6, height: 6 },
    ]) mark(doc, area);
    expect(await redactionEngine.applySecureRedactions(doc)).toMatchObject({ annotationsRemoved: 4, pathOperatorsRemoved: 1 });
    const output = await saveQuick(doc);
    const reopened = await parsePDF(output);
    const content = new TextDecoder().decode(getPageContentBytes(reopened.pages[0], reopened.objects));
    expect(content).not.toContain('15 15 10 10 re');
    expect(content).toContain('100 100 10 12 re');
    expect(reopened.pages[0].dict.has('Annots')).toBe(false);
    expect((await PDFDocument.load(output)).getPageCount()).toBe(2);
  });

  it('removes an image covered by adjacent marks', async () => {
    const doc = await fixture('q 20 0 0 20 10 10 cm /Im0 Do Q');
    mark(doc, { x: 9, y: 9, width: 11, height: 22 });
    mark(doc, { x: 20, y: 9, width: 11, height: 22 });
    expect(await redactionEngine.applySecureRedactions(doc)).toMatchObject({ annotationsRemoved: 2, imageOperatorsRemoved: 1 });
    const output = await saveQuick(doc);
    expect(new TextDecoder().decode(output)).not.toContain('PRIVATE_IMAGE_DATA');
    const reopened = await parsePDF(output);
    expect(new TextDecoder().decode(getPageContentBytes(reopened.pages[0], reopened.objects))).not.toContain('/Im0 Do');
    expect((await PDFDocument.load(output)).getPageCount()).toBe(2);
  });

  it.each([
    [[{ x: 14, y: 14, width: 6, height: 12 }, { x: 20.000001, y: 14, width: 6, height: 12 }]],
    [[{ x: 14, y: 14, width: 12, height: 5 }, { x: 14, y: 21, width: 12, height: 5 }]],
    [[{ x: 14, y: 14, width: 6, height: 12 }, { x: 20, y: 14, width: 6, height: 5 }, { x: 20, y: 21, width: 6, height: 5 }]],
  ])('rejects a gap in the union before mutation', async areas => {
    const doc = await fixture('15 15 10 10 re f');
    for (const area of areas) mark(doc, area);
    const before = await serializeDocument(doc);
    await expect(redactionEngine.applySecureRedactions(doc)).rejects.toThrow(/partially intersects/);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it.each(['dictionary', 'byte range'] as const)('rejects a signed document with %s before mutation even when multiple marks cover the object', async signature => {
    const doc = await fixture('15 15 10 10 re f');
    if (signature === 'dictionary') doc.catalog.set('Nested', new PDFDict([['Item', new PDFDict([['Type', new PDFName('Sig')]])]]));
    else doc.rawBytes = new TextEncoder().encode('%PDF-1.7\n/ByteRange [0 10 20 10] /Contents <01020304>');
    mark(doc, { x: 14, y: 14, width: 6, height: 12 });
    mark(doc, { x: 20, y: 14, width: 6, height: 12 });
    const before = await serializeDocument(doc);
    await expect(redactionEngine.applySecureRedactions(doc)).rejects.toThrow(/signed PDFs/);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('does not count a mark touching only an object edge as a successful redaction', async () => {
    const doc = await fixture('15 15 5 5 re f 100 100 10 10 re f');
    mark(doc);
    mark(doc, { x: 20, y: 15, width: 10, height: 5 });
    const before = await serializeDocument(doc);
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/does not contain/);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('still rejects an object touching an otherwise unsupported mark', async () => {
    const doc = await fixture('15 15 5 5 re f');
    mark(doc, { x: 20, y: 15, width: 10, height: 5 });
    const before = await serializeDocument(doc);
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/partially intersects/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('rejects duplicated annotation references and unrelated annotations without mutation', async () => {
    for (const duplicate of [true, false]) {
      const doc = await fixture('15 15 5 5 re f');
      const ref = mark(doc);
      const list = doc.pages[0].dict.getArray('Annots')!;
      list.push(duplicate ? ref : new PDFDict([['Subtype', new PDFName('Text')]]));
      const before = await serializeDocument(doc);
      expect(() => preparePartialGraphicsRedaction(doc)).toThrow(PartialGraphicsRedactionUnsupportedError);
      expect(await serializeDocument(doc)).toEqual(before);
    }
  });

  it('bounds the number of marks on one page before modification', async () => {
    const doc = await fixture('15 15 5 5 re f');
    for (let i = 0; i < 65; i++) mark(doc);
    const before = await serializeDocument(doc);
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/at most 64/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it.each(['FlateDecode', 'Fl'])('removes covered graphics from verified %s content and rewrites the original stream', async filter => {
    const doc = await fixture('1 0 0 rg 15 15 5 5 re f\n0 0 1 rg 100 100 10 10 re f');
    const oldContent = doc.pages[0].contentRefs[0].toKey();
    const stream = compressContent(doc, filter);
    const compressed = stream.rawBytes.slice();
    mark(doc);
    expect((await redactionEngine.applySecureRedactions(doc)).pathOperatorsRemoved).toBe(1);
    expect(doc.objects.has(oldContent)).toBe(false);
    expect(() => appendIncrementalUpdate(doc, new Set())).toThrow(/full rewrite/);
    const output = await saveQuick(doc);
    expect(Buffer.from(output).includes(Buffer.from(compressed))).toBe(false);
    const independentlyRead = await PDFDocument.load(output);
    expect(independentlyRead.getPageCount()).toBe(2);
    const reopened = await parsePDF(output);
    const content = new TextDecoder().decode(getPageContentBytes(reopened.pages[0], reopened.objects));
    expect(content).not.toContain('15 15 5 5 re');
    expect(content).toContain('100 100 10 10 re');
  });

  it.each(['bad checksum', 'trailing bytes', 'stale cache', 'decoded limit', 'unknown filter', 'filter array', 'decode parameters'] as const)(
    'refuses compressed content with %s before mutation', async kind => {
      const doc = await fixture('15 15 5 5 re f 100 100 10 10 re f');
      const stream = compressContent(doc, kind === 'unknown filter' ? 'UnknownDecode' : 'FlateDecode');
      if (kind === 'bad checksum') stream.rawBytes[stream.rawBytes.length - 1] ^= 1;
      if (kind === 'trailing bytes') stream.rawBytes = new Uint8Array([...stream.rawBytes, 0]);
      if (kind === 'stale cache') stream.decodedBytes = new TextEncoder().encode('100 100 10 10 re f');
      if (kind === 'decoded limit') stream.rawBytes = new Uint8Array(deflateSync(Buffer.alloc(65_537, 32)));
      if (kind === 'filter array') stream.dict.set('Filter', new PDFArray([new PDFName('FlateDecode')]));
      if (kind === 'decode parameters') stream.dict.set('DecodeParms', new PDFDict());
      stream.dict.set('Length', new PDFNumber(stream.rawBytes.length));
      mark(doc);
      const before = await serializeDocument(doc);
      expect(() => preparePartialGraphicsRedaction(doc)).toThrow(PartialGraphicsRedactionUnsupportedError);
      expect(await serializeDocument(doc)).toEqual(before);
      expect(doc.requiresFullRewrite).toBeUndefined();
    },
  );

  it('rejects a retained uncompressed copy of the removed compressed content', async () => {
    const doc = await fixture('15 15 5 5 re f 100 100 10 10 re f');
    const stream = compressContent(doc);
    const decoded = new Uint8Array(inflateSync(stream.rawBytes));
    const ref = new PDFRef(990, 0);
    doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(decoded.length)]]), decoded, null));
    doc.catalog.set('RetainedCopy', ref);
    mark(doc);
    const before = await serializeDocument(doc);
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/duplicates removed data/);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('rejects signed documents before removing compressed content', async () => {
    const doc = await fixture('15 15 5 5 re f 100 100 10 10 re f');
    compressContent(doc);
    doc.catalog.set('Nested', new PDFDict([['Item', new PDFDict([['Type', new PDFName('Sig')]])]]));
    mark(doc);
    const before = await serializeDocument(doc);
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/signed PDFs/);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('removes a fully covered image, mask and vector while preserving a disjoint vector and document data', async () => {
    const doc = await fixture();
    const oldContent = doc.pages[0].contentRefs[0].toKey();
    const second = getPageContentBytes(doc.pages[1], doc.objects).slice();
    const oldRaw = doc.rawBytes.slice();
    const title = doc.info.title;
    const action = new PDFDict([['S', new PDFName('URI')], ['URI', new PDFString('https://example.test')]]);
    doc.catalog.set('OpenAction', action);
    mark(doc);
    const op = preparePartialGraphicsRedaction(doc);
    expect(doc.objects.has('900_0')).toBe(true);
    expect(op.commit()).toMatchObject({ pagesProcessed: 1, imageOperatorsRemoved: 1, pathOperatorsRemoved: 1 });
    expect(doc.objects.has('900_0')).toBe(false);
    expect(doc.objects.has('901_0')).toBe(false);
    expect(doc.objects.has(oldContent)).toBe(false);
    expect(doc.rawBytes).toEqual(oldRaw);
    expect(() => appendIncrementalUpdate(doc, new Set())).toThrow(/full rewrite/);
    for (const save of [saveQuick, serializeDocumentCompact, saveQuickWorker]) {
      const bytes = await save(doc);
      const raw = new TextDecoder().decode(bytes);
      expect(raw).not.toContain('PRIVATE_IMAGE_DATA');
      expect(raw).not.toContain('PRIVATE_IMAGE_MASK');
      const reopened = await parsePDF(bytes);
      const content = new TextDecoder().decode(getPageContentBytes(reopened.pages[0], reopened.objects));
      expect(content).not.toContain('Do');
      expect(content).not.toContain('15 15 5 5 re');
      expect(content).toContain('100 100 10 10 re');
      expect(getPageContentBytes(reopened.pages[1], reopened.objects)).toEqual(second);
      expect(reopened.info.title).toBe(title);
      expect(reopened.catalog.getDict('OpenAction')?.getString('URI')).toBe('https://example.test');
    }
  });

  it('checks all four transformed image corners and refuses partial intersection', async () => {
    const doc = await fixture('q 1 1 -1 1 10 10 cm /Im0 Do Q');
    mark(doc, { x: 9.5, y: 9, width: 1, height: 4 });
    const before = await serializeDocument(doc);
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/partially intersects/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('removes a rotated image when the full transformed extent is covered', async () => {
    const doc = await fixture('q 0 20 -10 0 30 10 cm /Im0 Do Q');
    mark(doc, { x: 19, y: 9, width: 12, height: 22 });
    expect(preparePartialGraphicsRedaction(doc).commit().imageOperatorsRemoved).toBe(1);
    expect(doc.objects.has('900_0')).toBe(false);
  });

  it('rejects an image used outside the marked region and shared images on another page', async () => {
    const repeated = await fixture('q 20 0 0 20 10 10 cm /Im0 Do Q\nq 20 0 0 20 100 100 cm /Im0 Do Q');
    mark(repeated);
    const before = await serializeDocument(repeated);
    expect(() => preparePartialGraphicsRedaction(repeated)).toThrow(/used outside/);
    expect(await serializeDocument(repeated)).toEqual(before);

    const shared = await fixture();
    shared.pages[1].resources.set('XObject', new PDFDict([['Other', new PDFRef(900, 0)]]));
    mark(shared);
    const beforeShared = await serializeDocument(shared);
    expect(() => preparePartialGraphicsRedaction(shared)).toThrow(/shared/);
    expect(await serializeDocument(shared)).toEqual(beforeShared);
  });

  it.each(['image', 'mask', 'old content'] as const)(
    'rejects a separately referenced stream duplicating removed %s data', async kind => {
      const doc = await fixture();
      const original = kind === 'image' ? doc.objects.get('900_0') as PDFStream
        : kind === 'mask' ? doc.objects.get('901_0') as PDFStream
          : doc.objects.get(doc.pages[0].contentRefs[0].toKey()) as PDFStream;
      const ref = new PDFRef(990, 0);
      doc.objects.set(ref.toKey(), new PDFStream(new PDFDict(), original.rawBytes.slice(), original.decodedBytes?.slice() ?? null));
      doc.catalog.set('RetainedDuplicate', ref);
      mark(doc);
      const before = await serializeDocument(doc);
      expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/duplicates removed data/);
      expect(await serializeDocument(doc)).toEqual(before);
    },
  );

  it('rejects duplicated removed vector geometry on the target page or another page', async () => {
    const samePage = await fixture('15 15 5 5 re f 100 100 5 5 re f');
    mark(samePage);
    expect(() => preparePartialGraphicsRedaction(samePage)).toThrow(/duplicates removed vector/);
    const otherPage = await fixture('15 15 5 5 re f');
    await updatePageContent(otherPage.pages[1].contentRefs, new TextEncoder().encode('100 100 5 5 re f'), otherPage.objects, false);
    mark(otherPage);
    expect(() => preparePartialGraphicsRedaction(otherPage)).toThrow(/duplicates removed vector/);
  });

  it('rejects a separately encoded retained copy of a removed image', async () => {
    const doc = await fixture();
    const image = doc.objects.get('900_0') as PDFStream;
    const compressed = deflateSync(image.rawBytes);
    const ref = new PDFRef(990, 0);
    doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([
      ['Length', new PDFNumber(compressed.length)], ['Filter', new PDFName('FlateDecode')],
    ]), compressed, null));
    doc.catalog.set('RetainedDuplicate', ref);
    mark(doc);
    const before = await serializeDocument(doc);
    expect(inflateSync(compressed)).toEqual(Buffer.from(image.rawBytes));
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/retained encoded streams/);
    await expect(redactionEngine.applySecureRedactions(doc)).rejects.toThrow();
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it.each(['filter array', 'unknown filter', 'forged decoded cache'] as const)(
    'rejects retained encoded streams with %s', async kind => {
      const doc = await fixture();
      const image = doc.objects.get('900_0') as PDFStream;
      const compressed = deflateSync(image.rawBytes);
      const ref = new PDFRef(990, 0);
      const filter = kind === 'filter array' ? new PDFArray([new PDFName('FlateDecode')])
        : new PDFName(kind === 'unknown filter' ? 'UnknownDecode' : 'FlateDecode');
      doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([
        ['Length', new PDFNumber(compressed.length)], ['Filter', filter],
      ]), compressed, kind === 'forged decoded cache' ? new Uint8Array([1, 2, 3]) : null));
      doc.catalog.set('RetainedDuplicate', ref);
      mark(doc);
      const before = await serializeDocument(doc);
      await expect(redactionEngine.applySecureRedactions(doc)).rejects.toThrow();
      expect(await serializeDocument(doc)).toEqual(before);
    },
  );

  it.each(['BT (SECRET) Tj ET', '0 0 10 10 re W n', '0 0 10 10 re f % hidden secret',
    '0 0 10 10 re unknown', '0 0 10 10 re', 'q 0 0 0 0 0 0 cm Q', 'q 1 0 0 1 0 0 cm']) (
    'rejects unsupported or malformed content without mutation: %s', async content => {
      const doc = await fixture(content);
      mark(doc);
      const before = await serializeDocument(doc);
      expect(() => preparePartialGraphicsRedaction(doc)).toThrow(PartialGraphicsRedactionUnsupportedError);
      expect(await serializeDocument(doc)).toEqual(before);
    },
  );

  it('refuses partially overlapping vectors', async () => {
    const doc = await fixture('0 0 20 20 re f');
    mark(doc, { x: 10, y: 10, width: 20, height: 20 });
    const before = await serializeDocument(doc);
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/partially intersects/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('does not modify an earlier valid page if a later page is unsupported', async () => {
    const doc = await fixture();
    mark(doc);
    await updatePageContent(doc.pages[1].contentRefs, new TextEncoder().encode('BT (SECRET) Tj ET'), doc.objects, false);
    redactionEngine.markRegion(doc, 1, { x: 5, y: 5, width: 30, height: 30 });
    const before = await serializeDocument(doc);
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/unsupported/);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
    expect(doc.objects.has('900_0')).toBe(true);
  });

  it('checks page geometry and rejects stale preparation', async () => {
    const doc = await fixture();
    mark(doc);
    const op = preparePartialGraphicsRedaction(doc);
    doc.pages[0].dict.set('Rotate', new PDFNumber(90));
    expect(() => op.commit()).toThrow(/changed after/);
    expect(doc.objects.has('900_0')).toBe(true);
    const doc2 = await fixture();
    doc2.pages[0].mediaBox.width = 100;
    mark(doc2);
    expect(() => preparePartialGraphicsRedaction(doc2)).toThrow(/geometry differs/);
  });

  it('rejects a nonempty resource cache when the page tree has no resources', async () => {
    const doc = await fixture();
    const page = doc.pages[0];
    const parent = doc.objects.get(page.dict.getRef('Parent')!.toKey()) as PDFDict;
    parent.delete('Resources');
    page.dict.delete('Resources');
    mark(doc);
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/resources differ/);
  });

  it('rejects nested signature dictionaries even without raw ByteRange markers', async () => {
    const doc = await fixture();
    doc.catalog.set('Nested', new PDFDict([['Item', new PDFDict([['Type', new PDFName('Sig')]])]]));
    mark(doc);
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/signed PDFs/);
  });

  it('rejects protected and tagged documents and data-bearing page features', async () => {
    for (const kind of ['protected', 'tagged', 'AA'] as const) {
      const doc = await fixture();
      mark(doc);
      if (kind === 'protected') doc.xref.trailerDict.set('Encrypt', new PDFDict());
      if (kind === 'tagged') doc.catalog.set('StructTreeRoot', new PDFDict());
      if (kind === 'AA') doc.pages[0].dict.set('AA', new PDFString('SECRET'));
      expect(() => preparePartialGraphicsRedaction(doc)).toThrow(PartialGraphicsRedactionUnsupportedError);
      expect(doc.objects.has('900_0')).toBe(true);
    }
  });

  it('rejects a malformed annotation back-reference and unmarked page caches containing removed image data', async () => {
    const doc = await fixture();
    const annotation = mark(doc);
    (doc.objects.get(annotation.toKey()) as PDFDict).set('P', new PDFRef(900, 0));
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/different page/);
    (doc.objects.get(annotation.toKey()) as PDFDict).delete('P');
    doc.pages[1].resources = doc.pages[0].resources;
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/shared/);
  });

  it('rejects a stale content cache and a malformed stream length', async () => {
    const doc = await fixture();
    mark(doc);
    const ref = doc.pages[0].contentRefs[0];
    const stream = doc.objects.get(ref.toKey()) as PDFStream;
    stream.decodedBytes = new TextEncoder().encode('0 0 1 1 re f');
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/cache differs/);
    stream.decodedBytes = stream.rawBytes.slice();
    stream.dict.set('Length', new PDFNumber(stream.rawBytes.length + 1));
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/length is invalid/);
  });

  it('does not report success for a region that contains no supported object', async () => {
    const doc = await fixture('100 100 10 10 re f');
    mark(doc);
    const before = await serializeDocument(doc);
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/does not contain/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('rejects a redaction annotation appearance still reachable from the document', async () => {
    const doc = await fixture();
    const ref = mark(doc);
    const appearance = new PDFRef(991, 0);
    const bytes = new TextEncoder().encode('ANNOTATION_PRIVATE');
    doc.objects.set(appearance.toKey(), new PDFStream(new PDFDict(), bytes, bytes));
    (doc.objects.get(ref.toKey()) as PDFDict).set('AP', new PDFDict([['N', appearance]]));
    doc.catalog.set('Custom', appearance);
    const before = await serializeDocument(doc);
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/shared/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  const popplerAvailable = spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status === 0;
  it.skipIf(!popplerAvailable)('renders a union-covered rectangle removed without changing outside pixels', async () => {
    const doc = await fixture('1 0 0 rg 15 15 10 10 re f 0 0 1 rg 100 100 10 12 re f');
    const original = await serializeDocument(doc);
    for (const area of [
      { x: 14, y: 14, width: 6, height: 6 }, { x: 20, y: 14, width: 6, height: 6 },
      { x: 14, y: 20, width: 6, height: 6 }, { x: 20, y: 20, width: 6, height: 6 },
    ]) mark(doc, area);
    await redactionEngine.applySecureRedactions(doc);
    const output = await saveQuick(doc);
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-union-redact-'));
    try {
      const render = (bytes: Uint8Array, label: string) => {
        const pdf = join(dir, `${label}.pdf`), prefix = join(dir, label);
        writeFileSync(pdf, bytes);
        execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', pdf, prefix]);
        const data = readFileSync(`${prefix}.ppm`);
        const header = /^P6\s+200\s+200\s+255\s/.exec(data.toString('latin1', 0, 64));
        if (!header) throw new Error('Unexpected PPM output');
        return data.subarray(header[0].length);
      };
      const before = render(original, 'before'), after = render(output, 'after');
      const pixel = (data: Buffer, x: number, y: number) => [...data.subarray(((199 - y) * 200 + x) * 3, ((199 - y) * 200 + x) * 3 + 3)];
      expect(pixel(before, 17, 17)).toEqual([255, 0, 0]);
      expect(pixel(after, 17, 17)).toEqual([255, 255, 255]);
      expect(pixel(after, 105, 105)).toEqual([0, 0, 255]);
      let mismatches = 0;
      for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
        if (x >= 13 && x <= 27 && y >= 13 && y <= 27) continue;
        const offset = ((199 - y) * 200 + x) * 3;
        if (after[offset] !== before[offset] || after[offset + 1] !== before[offset + 1] || after[offset + 2] !== before[offset + 2]) mismatches++;
      }
      expect(mismatches).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.skipIf(!popplerAvailable)('removes both marked areas and preserves all outside pixels in Poppler', async () => {
    const doc = await fixture('1 0 0 rg 15 15 5 5 re f\n0 1 0 rg 55 55 9 7 re f\n0 0 1 rg 100 100 10 10 re f');
    const original = await serializeDocument(doc);
    mark(doc);
    mark(doc, { x: 50, y: 50, width: 20, height: 20 });
    await redactionEngine.applySecureRedactions(doc);
    const output = await saveQuick(doc);
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-multi-redact-'));
    try {
      const render = (bytes: Uint8Array, label: string) => {
        const pdf = join(dir, `${label}.pdf`), prefix = join(dir, label);
        writeFileSync(pdf, bytes);
        execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', pdf, prefix]);
        const data = readFileSync(`${prefix}.ppm`);
        const header = /^P6\s+200\s+200\s+255\s/.exec(data.toString('latin1', 0, 64));
        if (!header) throw new Error('Unexpected PPM output');
        return data.subarray(header[0].length);
      };
      const before = render(original, 'before'), after = render(output, 'after');
      const pixel = (data: Buffer, x: number, y: number) => [...data.subarray(((199 - y) * 200 + x) * 3, ((199 - y) * 200 + x) * 3 + 3)];
      expect(pixel(before, 17, 17)).toEqual([255, 0, 0]);
      expect(pixel(before, 58, 58)).toEqual([0, 255, 0]);
      expect(pixel(after, 17, 17)).toEqual([255, 255, 255]);
      expect(pixel(after, 58, 58)).toEqual([255, 255, 255]);
      expect(pixel(after, 105, 105)).toEqual([0, 0, 255]);
      let outsideMismatches = 0;
      for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
        if ((x >= 4 && x <= 36 && y >= 4 && y <= 36) || (x >= 49 && x <= 71 && y >= 49 && y <= 71)) continue;
        const offset = ((199 - y) * 200 + x) * 3;
        if (after[offset] !== before[offset] || after[offset + 1] !== before[offset + 1] || after[offset + 2] !== before[offset + 2]) outsideMismatches++;
      }
      expect(outsideMismatches).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.skipIf(!popplerAvailable).each([
    ['translate then scale', 'q 1 0 0 1 10 40 cm 2 0 0 3 0 0 cm 1 0 0 rg 0 0 10 5 re f Q', { x: 9, y: 39, width: 22, height: 17 }, [15, 45], false],
    ['translate then rotate', 'q 1 0 0 1 60 30 cm 0 1 -1 0 0 0 cm 1 0 0 rg 0 0 10 5 re f Q', { x: 54, y: 29, width: 7, height: 12 }, [57, 35], false],
    ['translate then shear', 'q 1 0 0 1 60 30 cm 1 0 1 1 0 0 cm 1 0 0 rg 0 0 10 10 re f Q', { x: 59, y: 29, width: 22, height: 12 }, [70, 35], false],
    ['compressed translated rectangle', 'q 1 0 0 1 10 40 cm 2 0 0 3 0 0 cm 1 0 0 rg 0 0 10 5 re f Q', { x: 9, y: 39, width: 22, height: 17 }, [15, 45], true],
    ['stroked rectangle', '4 w 1 0 0 RG 20 20 10 10 re S', { x: 15, y: 15, width: 20, height: 20 }, [20, 25], false],
    ['compressed fill and stroke', '4 w 1 0 0 RG 1 0 0 rg 20 20 10 10 re B', { x: 15, y: 15, width: 20, height: 20 }, [25, 25], true],
    ['rotated stroke', 'q 1 0 0 1 60 30 cm 0 1 -1 0 0 0 cm 2 w 1 0 0 RG 0 0 10 5 re S Q', { x: 53, y: 28, width: 9, height: 14 }, [60, 35], false],
  ] as const)('matches independent PDF rendering for %s', async (_name, commands, area, redPixel, compressed) => {
    const doc = await fixture(`${commands}\n0 0 1 rg 120 120 15 13 re f`);
    if (compressed) compressContent(doc);
    const before = await serializeDocument(doc);
    mark(doc, area);
    preparePartialGraphicsRedaction(doc).commit();
    const after = await saveQuick(doc);
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-redaction-render-'));
    try {
      const render = (pdf: Uint8Array, label: string): Buffer => {
        const path = join(dir, `${label}.pdf`);
        const prefix = join(dir, label);
        writeFileSync(path, pdf);
        execFileSync('pdftoppm', ['-singlefile', '-r', '72', '-f', '1', '-l', '1', path, prefix]);
        const ppm = readFileSync(`${prefix}.ppm`);
        const header = /^P6\s+200\s+200\s+255\s/.exec(ppm.toString('latin1', 0, 64));
        if (!header) throw new Error('Unexpected PPM output');
        return ppm.subarray(header[0].length);
      };
      const originalPixels = render(before, 'before');
      const outputPixels = render(after, 'after');
      const rgb = (pixels: Buffer, x: number, y: number) => [...pixels.subarray(((199 - y) * 200 + x) * 3, ((199 - y) * 200 + x) * 3 + 3)];
      expect(rgb(originalPixels, redPixel[0], redPixel[1])).toEqual([255, 0, 0]);
      expect(rgb(outputPixels, redPixel[0], redPixel[1])).toEqual([255, 255, 255]);
      expect(rgb(originalPixels, 125, 125)).toEqual([0, 0, 255]);
      expect(rgb(outputPixels, 125, 125)).toEqual([0, 0, 255]);
      let outsideMismatch = 0;
      for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
        if (x >= area.x - 1 && x <= area.x + area.width + 1 && y >= area.y - 1 && y <= area.y + area.height + 1) continue;
        const offset = ((199 - y) * 200 + x) * 3;
        if (outputPixels[offset] !== originalPixels[offset] || outputPixels[offset + 1] !== originalPixels[offset + 1] ||
            outputPixels[offset + 2] !== originalPixels[offset + 2]) outsideMismatch++;
      }
      expect(outsideMismatch).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!popplerAvailable)('matches independent rendering for nested transforms on an image', async () => {
    const content = 'q 1 0 0 1 60 30 cm 0 1 -1 0 0 0 cm 10 0 0 5 0 0 cm /Im0 Do Q\n0 0 1 rg 120 120 15 13 re f';
    const doc = await fixture(content);
    const image = doc.objects.get('900_0') as PDFStream;
    image.rawBytes = new Uint8Array([255, 0, 0]);
    image.decodedBytes = image.rawBytes.slice();
    image.dict.set('Type', new PDFName('XObject'));
    image.dict.set('Width', new PDFNumber(1));
    image.dict.set('Height', new PDFNumber(1));
    image.dict.set('BitsPerComponent', new PDFNumber(8));
    image.dict.set('ColorSpace', new PDFName('DeviceRGB'));
    image.dict.set('Length', new PDFNumber(3));
    image.dict.delete('SMask');
    const before = await serializeDocument(doc);
    mark(doc, { x: 54, y: 29, width: 7, height: 12 });
    preparePartialGraphicsRedaction(doc).commit();
    const after = await saveQuick(doc);
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-image-render-'));
    try {
      const pixel = (pdf: Uint8Array, label: string, x: number, y: number): number[] => {
        const path = join(dir, `${label}.pdf`), prefix = join(dir, label);
        writeFileSync(path, pdf);
        execFileSync('pdftoppm', ['-singlefile', '-r', '72', '-f', '1', '-l', '1', path, prefix]);
        const ppm = readFileSync(`${prefix}.ppm`);
        const header = /^P6\s+200\s+200\s+255\s/.exec(ppm.toString('latin1', 0, 64));
        if (!header) throw new Error('Unexpected PPM output');
        const offset = header[0].length + ((199 - y) * 200 + x) * 3;
        return [...ppm.subarray(offset, offset + 3)];
      };
      expect(pixel(before, 'before', 57, 35)).toEqual([255, 0, 0]);
      expect(pixel(after, 'after', 57, 35)).toEqual([255, 255, 255]);
      expect(pixel(after, 'after2', 125, 125)).toEqual([0, 0, 255]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('bounded partial graphics inspection', () => {
  const rectangle = '1 0 0 rg 15 15 5 5 re f';

  it('accepts an uncompressed stream at the byte limit and refuses one byte over it', async () => {
    const bytes = 1_048_576;
    const accepted = await fixture(rectangle + ' '.repeat(bytes - rectangle.length));
    mark(accepted);
    expect(preparePartialGraphicsRedaction(accepted).commit().pathOperatorsRemoved).toBe(1);

    const rejected = await fixture(rectangle + ' '.repeat(bytes + 1 - rectangle.length));
    mark(rejected);
    const before = await serializeDocument(rejected);
    expect(() => preparePartialGraphicsRedaction(rejected)).toThrow(/inspection byte limit/);
    expect(await serializeDocument(rejected)).toEqual(before);
    expect(rejected.requiresFullRewrite).toBeUndefined();
  }, 20_000);

  it('bounds instructions even when the stream is small', async () => {
    const atLimit = await fixture('q Q\n'.repeat(32_766) + `0 g ${rectangle}`);
    mark(atLimit);
    expect(preparePartialGraphicsRedaction(atLimit).commit().pathOperatorsRemoved).toBe(1);
    const overLimit = await fixture('q Q\n'.repeat(32_767) + `0 g ${rectangle}`);
    mark(overLimit);
    const before = await serializeDocument(overLimit);
    expect(() => preparePartialGraphicsRedaction(overLimit)).toThrow(/inspection instruction limit/);
    expect(await serializeDocument(overLimit)).toEqual(before);
  }, 20_000);

  it('bounds graphics-state nesting and does not mutate on refusal', async () => {
    const valid = await fixture('q '.repeat(256) + rectangle + ' Q'.repeat(256));
    mark(valid);
    expect(preparePartialGraphicsRedaction(valid).commit().pathOperatorsRemoved).toBe(1);
    const excessive = await fixture('q '.repeat(257) + rectangle + ' Q'.repeat(257));
    mark(excessive);
    const before = await serializeDocument(excessive);
    expect(() => preparePartialGraphicsRedaction(excessive)).toThrow(/inspection depth/);
    expect(await serializeDocument(excessive)).toEqual(before);
  });

  it('checks retained stream limits before committing a selected page', async () => {
    const doc = await fixture(rectangle);
    await updatePageContent(doc.pages[1].contentRefs, new TextEncoder().encode(' '.repeat(1_048_577)), doc.objects, false);
    mark(doc);
    const before = await serializeDocument(doc);
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/inspection byte limit/);
    expect(await serializeDocument(doc)).toEqual(before);
  }, 20_000);

  it('limits cumulative instruction work across selected and retained streams', async () => {
    const operations = 'q Q\n'.repeat(22_000);
    const doc = await fixture(operations + rectangle);
    await updatePageContent(doc.pages[1].contentRefs, new TextEncoder().encode(operations), doc.objects, false);
    mark(doc);
    const before = await serializeDocument(doc);
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/inspection instruction limit/);
    expect(await serializeDocument(doc)).toEqual(before);
  }, 20_000);

  it('limits cumulative byte work across independently marked pages without mutation', async () => {
    const pdf = await PDFDocument.create();
    for (let i = 0; i < 5; i++) pdf.addPage([200, 200]);
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    const content = new TextEncoder().encode(rectangle + ' '.repeat(900_000 - rectangle.length));
    for (const page of doc.pages) {
      page.resources = new PDFDict();
      page.dict.set('Resources', page.resources);
      await updatePageContent(page.contentRefs, content, doc.objects, false);
    }
    for (let i = 0; i < doc.pages.length; i++) redactionEngine.markRegion(doc, i, { x: 5, y: 5, width: 30, height: 30 });
    const before = await serializeDocument(doc);
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/inspection byte limit/);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  }, 30_000);

  it('bounds work when comparing many distinct retained rectangles', async () => {
    const removed = Array.from({ length: 1_025 }, (_, i) => `10 10 ${(1 + i / 100).toFixed(2)} 1 re f`).join('\n');
    const retained = Array.from({ length: 1_025 }, (_, i) => `100 100 ${(15 + i / 100).toFixed(2)} 2 re f`).join('\n');
    const doc = await fixture(`${removed}\n${retained}`);
    mark(doc);
    const before = await serializeDocument(doc);
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/inspection comparison limit/);
    expect(await serializeDocument(doc)).toEqual(before);
  }, 20_000);

  it('bounds pairwise comparison of many removed and retained image resources', async () => {
    const doc = await fixture('q 20 0 0 20 10 10 cm /Im0 Do Q');
    const image = doc.objects.get('900_0') as PDFStream;
    const related: PDFRef[] = [];
    const retained = new PDFDict();
    for (let i = 0; i < 257; i++) {
      const sensitive = new PDFRef(2_000 + i, 0);
      const other = new PDFRef(3_000 + i, 0);
      const first = new Uint8Array(i + 1).fill(65);
      const second = new Uint8Array(i + 258).fill(66);
      doc.objects.set(sensitive.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(first.length)]]), first));
      doc.objects.set(other.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(second.length)]]), second));
      related.push(sensitive);
      retained.set(`I${i}`, other);
    }
    image.dict.set('Private', new PDFArray(related));
    doc.pages[1].resources = new PDFDict([['XObject', retained]]);
    doc.pages[1].dict.set('Resources', doc.pages[1].resources);
    mark(doc);
    const before = await serializeDocument(doc);
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/inspection pair limit/);
    expect(await serializeDocument(doc)).toEqual(before);
  }, 20_000);

  it('bounds bytes compared across equal-length image streams', async () => {
    const doc = await fixture('q 20 0 0 20 10 10 cm /Im0 Do Q');
    const image = doc.objects.get('900_0') as PDFStream;
    const sensitive = new Uint8Array(4_194_304);
    const other = new Uint8Array(sensitive.length);
    other[other.length - 1] = 1;
    image.rawBytes = sensitive;
    image.decodedBytes = null;
    image.dict.set('Length', new PDFNumber(sensitive.length));
    const retained = new PDFDict();
    for (let i = 0; i < 17; i++) {
      const ref = new PDFRef(3_000 + i, 0);
      doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(other.length)]]), other));
      retained.set(`I${i}`, ref);
    }
    doc.pages[1].resources = new PDFDict([['XObject', retained]]);
    doc.pages[1].dict.set('Resources', doc.pages[1].resources);
    mark(doc);
    const originalAnnots = doc.pages[0].dict.get('Annots');
    const originalContent = doc.pages[0].contentRefs[0];
    const objectCount = doc.objects.size;
    expect(() => preparePartialGraphicsRedaction(doc)).toThrow(/stream comparison exceeds the inspection byte limit/);
    expect(doc.pages[0].dict.get('Annots')).toBe(originalAnnots);
    expect(doc.pages[0].contentRefs[0]).toBe(originalContent);
    expect(doc.objects.size).toBe(objectCount);
    expect(doc.objects.get('900_0')).toBe(image);
    expect(doc.requiresFullRewrite).toBeUndefined();
  }, 20_000);

  it('rejects a deep indirect image graph through the public fallback without modifying the document', async () => {
    const doc = await fixture('q 20 0 0 20 10 10 cm /Im0 Do Q');
    const image = doc.objects.get('900_0') as PDFStream;
    let next: PDFRef | undefined;
    for (let i = 0; i < 50_100; i++) {
      const ref = new PDFRef(10_000 + i, 0);
      doc.objects.set(ref.toKey(), new PDFDict(next ? [['Next', next]] : []));
      next = ref;
    }
    image.dict.set('Private', next!);
    // A full-page mark reaches the whole-page attempt first. Its bounded
    // refusal must remain safe when the public API falls back to graphics.
    mark(doc, { x: 0, y: 0, width: 200, height: 200 });
    const before = await serializeDocument(doc);
    await expect(redactionEngine.applySecureRedactions(doc)).rejects.toThrow(/inspection limit/);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  }, 30_000);
});
