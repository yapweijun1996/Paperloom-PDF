import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, PDFName as LibName } from 'pdf-lib';
import { PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, PDFString } from '../types';
import { deduplicateStreams } from '../optimize/garbage-collect';
import { fnv1aHex } from '../optimize/types';
import { parsePDF } from '../parser/parser';
import { saveOptimized, saveQuick } from '../writer/save-pipeline';
import { serializeDocument, serializeDocumentCompact } from '../writer/serializer';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { securityEngine } from '../security';

function stream(data: number[], fields: Array<[string, PDFName | PDFNumber]> = []): PDFStream {
  return new PDFStream(new PDFDict([['Length', new PDFNumber(data.length)], ...fields]), new Uint8Array(data));
}

describe('stream deduplication safety', () => {
  it('checks raw bytes on a forced hash collision while still merging identical streams', () => {
    const objects = new Map([
      ['1_0', stream([1, 2, 3])], ['2_0', stream([4, 5, 6])], ['3_0', stream([1, 2, 3])],
    ]);
    const result = deduplicateStreams(objects, () => 'same-hash');
    expect([...result.refMap]).toEqual([['3_0', '1_0']]);
    expect(result.groups).toMatchObject([{ keeper: '1_0', duplicates: ['3_0'], bytesSaved: 3 }]);
  });

  it.each([
    ['image size', [['Width', new PDFNumber(2)]], [['Width', new PDFNumber(4)]]],
    ['color space', [['ColorSpace', new PDFName('DeviceGray')]], [['ColorSpace', new PDFName('DeviceRGB')]]],
    ['filter', [['Filter', new PDFName('FlateDecode')]], [['Filter', new PDFName('LZWDecode')]]],
    ['font subtype', [['Subtype', new PDFName('Type1C')]], [['Subtype', new PDFName('CIDFontType0C')]]],
  ] as Array<[string, Array<[string, PDFName | PDFNumber]>, Array<[string, PDFName | PDFNumber]>]>)
  ('does not merge identical bytes with a different %s', (_label, left, right) => {
    expect(deduplicateStreams(new Map([['1_0', stream([1, 2, 3], left)], ['2_0', stream([1, 2, 3], right)]])).refMap.size).toBe(0);
  });

  it('uses stored stream data instead of a decoded cache', () => {
    const a = stream([1, 2, 3]), b = stream([4, 5, 6]);
    a.decodedBytes = b.decodedBytes = new Uint8Array([7, 8, 9]);
    expect(deduplicateStreams(new Map([['1_0', a], ['2_0', b]])).refMap.size).toBe(0);
  });

  it('stops trying to deduplicate after the dictionary inspection budget is exhausted', () => {
    const large = 'x'.repeat(1_100_000), first = stream([1]), second = stream([1]);
    first.dict.set('Private', new PDFString(large));
    second.dict.set('Private', new PDFString(large));
    const result = deduplicateStreams(new Map([['1_0', first], ['2_0', second], ['3_0', stream([1])], ['4_0', stream([1])]]), () => 'same');
    expect(result.refMap.size).toBe(0);
  });

  it('preserves a real default FNV-1a collision through save and reopen', async () => {
    const a = new Uint8Array(Buffer.from('80ce00008046a9bf', 'hex'));
    const b = new Uint8Array(Buffer.from('16cf01003694dbed', 'hex'));
    const s1 = new PDFStream(new PDFDict([['Length', new PDFNumber(a.length)]]), a);
    const s2 = new PDFStream(new PDFDict([['Length', new PDFNumber(b.length)]]), b);
    expect(fnv1aHex(a)).toBe(fnv1aHex(b));
    expect(deduplicateStreams(new Map([['1_0', s1], ['2_0', s2]])).refMap.size).toBe(0);
    const pdf = await PDFDocument.create(); pdf.addPage([100, 100]);
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    const first = new PDFRef(900, 0), second = new PDFRef(901, 0);
    doc.objects.set(first.toKey(), s1); doc.objects.set(second.toKey(), s2);
    doc.catalog.set('CollisionA', first); doc.catalog.set('CollisionB', second);
    const output = await serializeDocument(doc), reopened = await parsePDF(output);
    const refA = reopened.catalog.getRef('CollisionA')!, refB = reopened.catalog.getRef('CollisionB')!;
    expect(refA.toKey()).not.toBe(refB.toKey());
    expect((reopened.objects.get(refA.toKey()) as PDFStream).rawBytes).toEqual(a);
    expect((reopened.objects.get(refB.toKey()) as PDFStream).rawBytes).toEqual(b);
    expect((await PDFDocument.load(output)).getPageCount()).toBe(1);
  });

  it('preserves identical ciphertext under distinct encrypted object keys on all full-save paths', async () => {
    const fixture = new Uint8Array(readFileSync(join(__dirname, 'fixtures/encrypted/rc4-128-r4.pdf')));
    const doc = await parsePDF(fixture), a = new PDFRef(7000, 0), b = new PDFRef(7001, 0);
    const ciphertext = Array.from({ length: 16 }, (_, index) => index + 1);
    doc.objects.set(a.toKey(), stream(ciphertext)); doc.objects.set(b.toKey(), stream(ciphertext));
    doc.catalog.set('PrivateCipherA', a); doc.catalog.set('PrivateCipherB', b);
    const source = await serializeDocument(doc);
    for (const save of [serializeDocument, serializeDocumentCompact, saveQuick, saveOptimized]) {
      const input = await parsePDF(source), output = await save(input), parsed = await parsePDF(output);
      const refA = parsed.catalog.getRef('PrivateCipherA')!, refB = parsed.catalog.getRef('PrivateCipherB')!;
      expect(refA.toKey()).not.toBe(refB.toKey());
      expect((parsed.objects.get(refA.toKey()) as PDFStream).rawBytes).toEqual(new Uint8Array(ciphertext));
      expect((parsed.objects.get(refB.toKey()) as PDFStream).rawBytes).toEqual(new Uint8Array(ciphertext));
      const opened = (await securityEngine.open(parsed, 'userpass')).doc;
      const plainA = (opened.objects.get(refA.toKey()) as PDFStream).rawBytes;
      const plainB = (opened.objects.get(refB.toKey()) as PDFStream).rawBytes;
      expect(plainA).not.toEqual(plainB);
    }
  }, 30000);

  it('keeps equal plaintext streams independent when rewriting an authenticated encrypted file', async () => {
    const fixture = new Uint8Array(readFileSync(join(__dirname, 'fixtures/encrypted/rc4-128-r4.pdf')));
    for (const save of [saveQuick, saveOptimized]) {
      const doc = (await securityEngine.open(await parsePDF(fixture), 'userpass')).doc;
      const a = new PDFRef(7000, 0), b = new PDFRef(7001, 0), plain = [1, 2, 3, 4, 5, 6];
      doc.objects.set(a.toKey(), stream(plain)); doc.objects.set(b.toKey(), stream(plain));
      doc.catalog.set('PrivatePlainA', a); doc.catalog.set('PrivatePlainB', b);
      const output = await save(doc), parsed = await parsePDF(output);
      const refA = parsed.catalog.getRef('PrivatePlainA')!, refB = parsed.catalog.getRef('PrivatePlainB')!;
      expect(refA.toKey()).not.toBe(refB.toKey());
      expect((parsed.objects.get(refA.toKey()) as PDFStream).rawBytes)
        .not.toEqual((parsed.objects.get(refB.toKey()) as PDFStream).rawBytes);
      const reopened = (await securityEngine.open(parsed, 'userpass')).doc;
      expect((reopened.objects.get(refA.toKey()) as PDFStream).rawBytes).toEqual(new Uint8Array(plain));
      expect((reopened.objects.get(refB.toKey()) as PDFStream).rawBytes).toEqual(new Uint8Array(plain));
    }
  }, 30000);

  it.skipIf(spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status !== 0)(
    'preserves differently shaped images after redaction, save and independent rendering', async () => {
      const pdf = await PDFDocument.create();
      pdf.addPage([200, 200]);
      const page = pdf.addPage([200, 200]);
      const samples = new Uint8Array([0, 64, 128, 255]);
      const image = (width: number, height: number) => pdf.context.register(pdf.context.stream(samples, {
        Type: 'XObject', Subtype: 'Image', Width: width, Height: height, ColorSpace: 'DeviceGray', BitsPerComponent: 8,
      }));
      const first = image(2, 2), second = image(4, 1);
      page.node.set(LibName.of('Resources'), pdf.context.obj({ XObject: { A: first, B: second } }));
      page.node.set(LibName.of('Contents'), pdf.context.register(pdf.context.stream(
        'q 40 0 0 40 10 10 cm /A Do Q\nq 40 0 0 40 80 10 cm /B Do Q\n',
      )));
      const original = await pdf.save({ useObjectStreams: false });
      const doc = await parsePDF(original);
      redactionEngine.markRegion(doc, 0, { x: 0, y: 0, width: 200, height: 200 });
      await redactionEngine.applySecureRedactions(doc);
      const output = await saveQuick(doc), reopened = await parsePDF(output);
      const resources = reopened.pages[1].resources.getDict('XObject')!;
      const a = reopened.objects.get((resources.get('A') as PDFRef).toKey()) as PDFStream;
      const b = reopened.objects.get((resources.get('B') as PDFRef).toKey()) as PDFStream;
      expect([a.dict.getNumber('Width'), a.dict.getNumber('Height')]).toEqual([2, 2]);
      expect([b.dict.getNumber('Width'), b.dict.getNumber('Height')]).toEqual([4, 1]);
      expect((await PDFDocument.load(output)).getPageCount()).toBe(2);
      const dir = mkdtempSync(join(tmpdir(), 'paperloom-dedup-'));
      try {
        const render = (data: Uint8Array, label: string) => {
          const path = join(dir, `${label}.pdf`), prefix = join(dir, label);
          writeFileSync(path, data);
          execFileSync('pdftoppm', ['-f', '2', '-l', '2', '-singlefile', '-r', '72', path, prefix]);
          return readFileSync(`${prefix}.ppm`);
        };
        expect(render(output, 'after')).toEqual(render(original, 'before'));
        if (spawnSync('qpdf', ['--version'], { stdio: 'ignore' }).status === 0) {
          execFileSync('qpdf', ['--check', join(dir, 'after.pdf')]);
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 30000,
  );
});
