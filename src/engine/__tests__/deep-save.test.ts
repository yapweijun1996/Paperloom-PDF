import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFArray, PDFBoolean, PDFDict, PDFHexString, PDFNull, PDFNumber, PDFRef, PDFStream, PDFString, type PDFObject } from '../types';
import { concatByteChunks, serializeToString } from '../editor/stream-compiler';
import { applyRefMap, buildObjectGraph, garbageCollect, rootsFromTrailer } from '../optimize/garbage-collect';
import { parsePDF, getPageContentBytes } from '../parser/parser';
import { saveQuick } from '../writer/save-pipeline';
import { assertFullRewriteLayoutSafe, assertSerializableObjectKeys, serializeDocument } from '../writer/serializer';
import { redactionEngine } from '../security/redaction/redaction-engine';

function nested(depth: number, leaf: PDFDict | PDFRef = new PDFDict()): PDFDict | PDFRef {
  let result = leaf;
  for (let i = 0; i < depth; i++) result = new PDFDict([['D', result]]);
  return result;
}

describe('deep PDF object saving', () => {
  it('keeps the existing serialization syntax for nested values and shared containers', () => {
    const shared = new PDFArray([new PDFNumber(2), new PDFString('a\nb')]);
    const value = new PDFDict([
      ['A B', new PDFArray([new PDFBoolean(true), new PDFHexString('01ff'), PDFNull.instance, new PDFRef(8, 2)])],
      ['One', shared], ['Two', shared], ['Empty', new PDFDict()],
    ]);
    expect(serializeToString(value)).toBe('<</A#20B [true <01ff> null 8 2 R] /One [2 (a\\nb)] /Two [2 (a\\nb)] /Empty <<>>>>');
  });

  it('serializes a 14,000-level direct chain without the JavaScript call stack', () => {
    const output = serializeToString(nested(14_000, new PDFDict([['Leaf', new PDFString('END')]])));
    expect(output.startsWith('<</D <</D ')).toBe(true);
    expect(output).toContain('<</Leaf (END)>>');
    expect(output.endsWith('>>'.repeat(14_000))).toBe(true);
  });

  it('walks a wide array and finds nested references in order', () => {
    const list = new PDFArray(Array.from({ length: 140_000 }, () => PDFNull.instance));
    list.items[3] = new PDFRef(2, 0);
    list.items[139_999] = new PDFDict([['Target', new PDFRef(3, 0)]]);
    const graph = buildObjectGraph(new Map<string, PDFObject>([['1_0', list], ['2_0', new PDFDict()], ['3_0', new PDFDict()]]), [new PDFRef(1, 0)]);
    expect(graph.edges).toEqual([{ from: '1_0', to: '2_0', via: '[3]' }, { from: '1_0', to: '3_0', via: 'Target' }]);
  });

  it('deduplicates direct shared DAG traversal while retaining all indirect targets', () => {
    let value: PDFArray = new PDFArray([new PDFRef(2, 0)]);
    for (let i = 0; i < 40; i++) value = new PDFArray([value, value]);
    const result = garbageCollect(new Map<string, PDFObject>([['1_0', value], ['2_0', new PDFDict()]]), [new PDFRef(1, 0)], { deduplicateStreams: false });
    expect(result.removedKeys).toEqual([]);
    expect(() => buildObjectGraph(new Map<string, PDFObject>([['1_0', value], ['2_0', new PDFDict()]]), [new PDFRef(1, 0)])).toThrow(/inspection work limit/);
    expect(() => serializeToString(value)).toThrow(/serialization work limit/);
  }, 30000);

  it('keeps the order and multiplicity of public graph edges through shared direct subtrees', () => {
    const shared = new PDFDict([['Target', new PDFRef(2, 0)]]);
    const root = new PDFDict([['A', shared], ['B', shared]]);
    const graph = buildObjectGraph(new Map<string, PDFObject>([['1_0', root], ['2_0', new PDFDict()]]), [new PDFRef(1, 0)]);
    expect(graph.edges).toEqual([
      { from: '1_0', to: '2_0', via: 'Target' }, { from: '1_0', to: '2_0', via: 'Target' },
    ]);
  });

  it('rejects an oversized dictionary key before encoding it', () => {
    const value = new PDFDict([['x'.repeat(64 * 1024 * 1024), new PDFNumber(1)]]);
    expect(() => serializeToString(value)).toThrow(/serialization output limit/);
  });

  it('remaps a deep shared direct graph while preserving identity and indirect cycles', () => {
    const shared = new PDFDict([['Target', new PDFRef(4, 0)]]);
    const root = new PDFDict([['Deep', nested(14_000, shared)], ['Other', shared], ['Cycle', new PDFRef(1, 0)]]);
    const remapped = applyRefMap(new Map([['1_0', root]]), new Map([['4_0', '5_0']]));
    const mapped = remapped.get('1_0') as PDFDict;
    let current = mapped.get('Deep') as PDFDict;
    for (let i = 0; i < 14_000; i++) current = current.get('D') as PDFDict;
    expect(current).toBe(mapped.get('Other'));
    expect((current.get('Target') as PDFRef).toKey()).toBe('5_0');
    expect((mapped.get('Cycle') as PDFRef).toKey()).toBe('1_0');
  });

  it('detects invalid direct cycles without modifying the source graph', () => {
    const array = new PDFArray();
    const stream = new PDFStream(new PDFDict([['A', array]]), new Uint8Array());
    array.push(stream);
    expect(() => serializeToString(array)).toThrow(/cyclic direct/);
    expect(() => buildObjectGraph(new Map([['1_0', array]]), [new PDFRef(1, 0)])).toThrow(/cyclic direct/);
    expect(() => applyRefMap(new Map([['1_0', array]]), new Map([['4_0', '5_0']]))).toThrow(/cyclic direct/);
    expect(array.get(0)).toBe(stream);
    expect(stream.dict.get('A')).toBe(array);
  });

  it('concatenates many indirect-object chunks without spreading function arguments', () => {
    const chunks = Array.from({ length: 150_000 }, (_, i) => new Uint8Array([i % 256]));
    const output = concatByteChunks(chunks);
    expect(output.length).toBe(chunks.length);
    expect(output[149_999]).toBe(149_999 % 256);
  });

  it('writes reader-compatible sparse xref subsections and preserves the referenced value', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    const ref = new PDFRef(100_001, 0), filler = new PDFRef(900, 0);
    doc.objects.set(ref.toKey(), new PDFString('SPARSE_OBJECT'));
    doc.catalog.set('SparseObject', ref);
    const fillerBytes = new Uint8Array(400_100);
    doc.objects.set(filler.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(fillerBytes.length)]]), fillerBytes));
    doc.catalog.set('PaddingStream', filler);
    const reachable = garbageCollect(doc.objects, rootsFromTrailer(doc.xref.trailerDict)).objects;
    expect(() => assertFullRewriteLayoutSafe(doc, reachable)).not.toThrow();
    const bytes = await serializeDocument(doc);
    expect(bytes.length).toBeLessThan(500_000);
    expect(new TextDecoder().decode(bytes)).toContain('100001 1\n');
    const reopened = await parsePDF(bytes);
    expect((reopened.objects.get(ref.toKey()) as PDFString).value).toBe('SPARSE_OBJECT');
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    if (spawnSync('qpdf', ['--version'], { stdio: 'ignore' }).status === 0) {
      const dir = mkdtempSync(join(tmpdir(), 'paperloom-sparse-xref-'));
      try {
        const path = join(dir, 'output.pdf');
        writeFileSync(path, bytes);
        expect(execFileSync('qpdf', ['--show-object=100001', path], { encoding: 'utf8' })).toContain('SPARSE_OBJECT');
        expect(execFileSync('qpdf', ['--show-object=trailer', path], { encoding: 'utf8' })).toContain('/Root');
        const root = doc.xref.trailerDict.getRef('Root')!;
        expect(execFileSync('qpdf', [`--show-object=${root.objNum}`, path], { encoding: 'utf8' })).toContain('/SparseObject 100001 0 R');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  }, 30000);

  it('refuses a sparse object number a reader would silently ignore', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    const ref = new PDFRef(20_000_000, 0);
    doc.objects.set(ref.toKey(), new PDFString('MUST_NOT_BE_LOST'));
    doc.catalog.set('SparseObject', ref);
    const reachable = garbageCollect(doc.objects, rootsFromTrailer(doc.xref.trailerDict)).objects;
    expect(() => assertFullRewriteLayoutSafe(doc, reachable)).toThrow(/sparse PDF object numbers/);
    await expect(serializeDocument(doc)).rejects.toThrow(/sparse PDF object numbers/);
    expect((doc.objects.get(ref.toKey()) as PDFString).value).toBe('MUST_NOT_BE_LOST');
    expect(doc.catalog.get('SparseObject')).toBe(ref);
  });

  it('refuses sparse object IDs before redaction mutates the original document', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    redactionEngine.markRegion(doc, 0, { x: 0, y: 0, width: 200, height: 200 });
    const ref = new PDFRef(20_000_000, 0), value = new PDFString('PRESERVE_REFERENCED_DATA');
    doc.objects.set(ref.toKey(), value);
    doc.catalog.set('SparseObject', ref);
    const marks = doc.pages[0].dict.get('Annots');
    await expect(redactionEngine.applySecureRedactions(doc)).rejects.toThrow(/sparse|supported/i);
    expect(doc.objects.get(ref.toKey())).toBe(value);
    expect(doc.catalog.get('SparseObject')).toBe(ref);
    expect(doc.pages[0].dict.get('Annots')).toBe(marks);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('rejects invalid, excessive and duplicate object numbers before serialization', () => {
    for (const keys of [['0_0'], ['1_x'], ['2147483648_0'], ['1_65536'], ['1_0', '1_1']]) {
      expect(() => assertSerializableObjectKeys(keys)).toThrow(/object number/);
    }
    expect(() => assertSerializableObjectKeys(['1_0', '20000000_0'])).not.toThrow();
  });

  it('saves a whole-page redaction with a deep independent direct dictionary', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    doc.catalog.set('Deep', nested(14_000, new PDFDict([['Leaf', new PDFString('KEEP')]])));
    redactionEngine.markRegion(doc, 0, { x: 0, y: 0, width: 200, height: 200 });
    await redactionEngine.applySecureRedactions(doc);
    const bytes = await saveQuick(doc);
    expect(new TextDecoder().decode(bytes)).toContain('/Leaf (KEEP)');
    expect(getPageContentBytes(doc.pages[0], doc.objects)).toHaveLength(0);
    const reopened = await parsePDF(bytes);
    expect(reopened.pages).toHaveLength(1);
    let current = reopened.catalog.getDict('Deep')!;
    for (let i = 1; i < 14_000; i++) current = current.getDict('D')!;
    expect(current.getDict('D')?.get('Leaf')).toBeInstanceOf(PDFString);
  }, 30000);

  it('saves and reopens a moderately deep direct dictionary independently', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    doc.catalog.set('Deep', nested(128, new PDFDict([['Leaf', new PDFString('KEEP')]])));
    redactionEngine.markRegion(doc, 0, { x: 0, y: 0, width: 200, height: 200 });
    await redactionEngine.applySecureRedactions(doc);
    const bytes = await saveQuick(doc);
    expect((await parsePDF(bytes)).pages).toHaveLength(1);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  }, 30000);
});
