import { afterEach, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { spawnSync } from 'child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { collectTransferBuffers, dehydrateDocument, extractNewObjects, hydrateDocument, sameDocumentSnapshot } from '../worker/codec';
import { PDFArray, PDFBoolean, PDFDict, PDFHexString, PDFName, PDFNull, PDFNumber, PDFRef, PDFStream, PDFString, type PDFDocumentData, type PDFObject } from '../types';
import { parsePDF, saveOptimized, saveQuick, resetPDFWorkerForTests } from '../worker/client';
import { handleWorkerCommand } from '../worker/handler';
import { parsePDF as parseDirect } from '../parser/parser';
import { securityEngine } from '../security';

const encryptedFixtures = [
  ['aes-256-r6.pdf', 'userpass'],
  ['aes-128-r4.pdf', 'userpass'],
  ['rc4-128-r4.pdf', 'userpass'],
  ['rc4-40-empty-user-r2.pdf', ''],
] as const;

function fixture(): PDFDocumentData {
  const shared = new PDFDict();
  const resources = new PDFDict([['Font', shared]]);
  const page = new PDFDict([['Resources', resources]]);
  const ref = new PDFRef(1, 0);
  const stream = new PDFStream(new PDFDict([['Length', new PDFNumber(3)]]), new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]));
  const objects = new Map<string, PDFObject>([['1_0', page], ['2_0', stream]]);
  return { version: '1.7', objects, xref: { entries: new Map([['1_0', { objNum: 1, genNum: 0, offset: 0, type: 'n' as const }]]), trailerDict: new PDFDict([['Root', ref]]) }, catalog: page, pages: [{ index: 0, dict: page, mediaBox: { x: 0, y: 0, width: 10, height: 10 }, cropBox: { x: 0, y: 0, width: 10, height: 10 }, rotate: 0, ref, resources, contentRefs: [ref] }], info: { title: 'test' }, rawBytes: new Uint8Array([37, 80]) };
}

describe('PDF worker codec', () => {
  afterEach(() => {
    resetPDFWorkerForTests();
    delete (globalThis as { Worker?: unknown }).Worker;
  });

  it('round-trips deeply nested direct containers without recursive stack growth', () => {
    const doc = fixture();
    const root = new PDFDict();
    let current = root;
    for (let i = 0; i < 14_000; i++) {
      const next = new PDFDict();
      current.set('Next', next);
      current = next;
    }
    const shared = new PDFString('deep alias');
    current.set('Loop', root);
    current.set('Shared', shared);
    doc.catalog.set('Deep', root);
    doc.catalog.set('Shared', shared);
    const wire = dehydrateDocument(doc);
    const restored = hydrateDocument(wire);
    const first = restored.catalog.getDict('Deep')!;
    let last = first;
    for (let i = 0; i < 14_000; i++) last = last.getDict('Next')!;
    expect(last.get('Loop')).toBe(first);
    expect(last.get('Shared')).toBe(restored.catalog.get('Shared'));
    expect(doc.catalog.get('Deep')).toBe(root);
    expect(dehydrateDocument(restored)).toEqual(wire);
  });

  it('hydrates wide arrays without overflowing call argument limits', () => {
    const doc = fixture();
    const shared = new PDFString('shared');
    doc.catalog.set('Wide', new PDFArray(Array.from({ length: 140_000 }, () => shared)));
    const restored = hydrateDocument(dehydrateDocument(doc));
    const array = restored.catalog.getArray('Wide')!;
    expect(array.length).toBe(140_000);
    expect(array.items[0]).toBe(array.items[139_999]);
  });

  it('preserves depth-first wire IDs for aliases and ordered children', () => {
    const doc = fixture();
    const shared = new PDFString('shared');
    const nested = new PDFDict([['alias', shared]]);
    const root = new PDFDict([['first', new PDFArray([shared, nested])], ['second', shared]]);
    doc.objects = new Map([['1_0', root]]);
    doc.catalog = root;
    doc.xref.trailerDict = root;
    doc.pages = [];
    expect(dehydrateDocument(doc).nodes).toEqual([
      { id: 1, kind: 'dict', entries: [['first', 2], ['second', 3]] },
      { id: 2, kind: 'array', items: [3, 4] },
      { id: 3, kind: 'string', value: 'shared' },
      { id: 4, kind: 'dict', entries: [['alias', 3]] },
    ]);
  });

  it('resolves missing page resource caches from the page and its ancestors', () => {
    const direct = fixture();
    const resources = direct.pages[0].resources;
    Reflect.deleteProperty(direct.pages[0], 'resources');
    const directRestored = hydrateDocument(dehydrateDocument(direct));
    expect(directRestored.pages[0].resources).toBe(directRestored.pages[0].dict.get('Resources'));
    expect(directRestored.pages[0].resources.getDict('Font')).toBeDefined();
    expect(direct.pages[0].dict.get('Resources')).toBe(resources);

    const inherited = fixture();
    const inheritedResources = inherited.pages[0].resources;
    const parent = new PDFDict([['Resources', inheritedResources]]);
    inherited.objects.set('98_0', parent);
    inherited.pages[0].dict.delete('Resources');
    inherited.pages[0].dict.set('Parent', new PDFRef(98, 0));
    Reflect.deleteProperty(inherited.pages[0], 'resources');
    const reopened = hydrateDocument(dehydrateDocument(inherited));
    expect(reopened.pages[0].resources).toBe((reopened.objects.get('98_0') as PDFDict).get('Resources'));
    expect(inherited.pages[0].dict.has('Resources')).toBe(false);

    const missing = fixture();
    missing.pages[0].dict.delete('Resources');
    Reflect.deleteProperty(missing.pages[0], 'resources');
    expect(hydrateDocument(dehydrateDocument(missing)).pages[0].resources.size).toBe(0);
    expect(missing.pages[0].dict.has('Resources')).toBe(false);
  });

  it('round-trips core classes, bytes, and aliases', () => {
    const values = [new PDFName('N'), new PDFString('s'), new PDFHexString('ff'), new PDFNumber(1), new PDFBoolean(true), PDFNull.instance, new PDFArray(), new PDFDict(), new PDFStream(new PDFDict(), new Uint8Array([9])), new PDFRef(4, 0)];
    const doc = fixture();
    values.forEach((value, index) => doc.objects.set(`9_${index}`, value));
    const hydrated = hydrateDocument(dehydrateDocument(doc));
    expect(hydrated.objects.get('9_0')).toBeInstanceOf(PDFName);
    expect(hydrated.objects.get('9_1')).toBeInstanceOf(PDFString);
    expect(hydrated.objects.get('9_2')).toBeInstanceOf(PDFHexString);
    expect(hydrated.objects.get('9_3')).toBeInstanceOf(PDFNumber);
    expect(hydrated.objects.get('9_4')).toBeInstanceOf(PDFBoolean);
    expect(hydrated.objects.get('9_5')).toBe(PDFNull.instance);
    expect(hydrated.objects.get('9_6')).toBeInstanceOf(PDFArray);
    expect(hydrated.objects.get('9_7')).toBeInstanceOf(PDFDict);
    expect(hydrated.objects.get('9_8')).toBeInstanceOf(PDFStream);
    expect(hydrated.objects.get('9_9')).toBeInstanceOf(PDFRef);
    expect(hydrated.catalog).toBe(hydrated.pages[0].dict);
    expect(hydrated.pages[0].resources).toBe(hydrated.pages[0].dict.get('Resources'));
    const result = hydrated.objects.get('2_0') as PDFStream;
    expect(Array.from(result.rawBytes)).toEqual([1, 2, 3]);
    expect(Array.from(result.decodedBytes ?? [])).toEqual([4, 5]);
  });

  it('round-trips the encrypted-document save flag', () => {
    const doc = fixture();
    doc.decryptedFromEncrypted = true;
    expect(hydrateDocument(dehydrateDocument(doc)).decryptedFromEncrypted).toBe(true);
  });

  it('round-trips the authenticated file key only through the wire document', () => {
    const doc = fixture();
    doc.decryptedFromEncrypted = true;
    doc.encryptionFileKey = new Uint8Array([1, 2, 3, 4]);
    doc.encryptionAlgorithm = 'AES-256';
    const hydrated = hydrateDocument(dehydrateDocument(doc));
    expect(Array.from(hydrated.encryptionFileKey ?? [])).toEqual([1, 2, 3, 4]);
    expect(hydrated.encryptionAlgorithm).toBe('AES-256');
    expect(dehydrateDocument(doc)).not.toHaveProperty('password');
  });

  it('copies snapshot bytes before transfer and preserves explicit rawBytes identity', () => {
    const doc = fixture();
    const originalRaw = doc.rawBytes;
    const originalStream = doc.objects.get('2_0') as PDFStream;
    const originalStreamBytes = originalStream.rawBytes;
    const wire = dehydrateDocument(doc);
    expect(wire.rawBytes).not.toBe(originalRaw);
    expect((wire.nodes.find((node) => node.kind === 'stream') as { rawBytes: Uint8Array }).rawBytes).not.toBe(originalStreamBytes);
    const hydrated = hydrateDocument(wire, originalRaw);
    expect(hydrated.rawBytes).toBe(originalRaw);
    const transfer = collectTransferBuffers(wire);
    expect(transfer).not.toContain(originalRaw.buffer);
    expect(transfer).not.toContain(originalStreamBytes.buffer);
  });

  it('isolates Buffer-backed source bytes before snapshot comparison and transfer', () => {
    const doc = fixture();
    const stream = doc.objects.get('2_0') as PDFStream;
    doc.rawBytes = Buffer.from([10, 11]);
    stream.rawBytes = Buffer.from([20, 21, 22]);
    stream.decodedBytes = Buffer.from([30, 31]);
    doc.encryptionFileKey = Buffer.from([40, 41]);
    const sourceRaw = doc.rawBytes, sourceStream = stream.rawBytes, sourceDecoded = stream.decodedBytes;
    const sourceKey = doc.encryptionFileKey;
    const wire = dehydrateDocument(doc);
    const node = wire.nodes.find(item => item.kind === 'stream');
    if (!node || node.kind !== 'stream') throw new Error('Missing stream node');
    sourceRaw[0] = 12; sourceStream[0] = 23; sourceDecoded[0] = 32; sourceKey[0] = 42;
    expect([...wire.rawBytes!]).toEqual([10, 11]);
    expect([...node.rawBytes]).toEqual([20, 21, 22]);
    expect([...node.decodedBytes!]).toEqual([30, 31]);
    expect([...wire.encryptionFileKey!]).toEqual([40, 41]);
    expect(sameDocumentSnapshot(wire, dehydrateDocument(doc))).toBe(false);
    const transfer = collectTransferBuffers(wire);
    expect(transfer).not.toContain(sourceRaw.buffer);
    expect(transfer).not.toContain(sourceStream.buffer);
    expect(transfer).not.toContain(sourceDecoded.buffer);
    expect(transfer).not.toContain(sourceKey.buffer);
    structuredClone(wire, { transfer });
    expect([...sourceRaw]).toEqual([12, 11]);
    expect([...sourceStream]).toEqual([23, 21, 22]);
    expect([...sourceDecoded]).toEqual([32, 31]);
    expect([...sourceKey]).toEqual([42, 41]);
  });

  it('copies Buffer-backed wire bytes when hydrating without explicit raw bytes', () => {
    const wire = dehydrateDocument(fixture());
    const node = wire.nodes.find(item => item.kind === 'stream');
    if (!node || node.kind !== 'stream') throw new Error('Missing stream node');
    wire.rawBytes = Buffer.from([10, 11]);
    wire.encryptionFileKey = Buffer.from([40, 41]);
    node.rawBytes = Buffer.from([20, 21, 22]);
    node.decodedBytes = Buffer.from([30, 31]);
    const restored = hydrateDocument(wire);
    const stream = restored.objects.get('2_0') as PDFStream;
    restored.rawBytes[0] = 12; stream.rawBytes[0] = 23; stream.decodedBytes![0] = 32; restored.encryptionFileKey![0] = 42;
    expect([...wire.rawBytes]).toEqual([10, 11]);
    expect([...node.rawBytes]).toEqual([20, 21, 22]);
    expect([...node.decodedBytes]).toEqual([30, 31]);
    expect([...wire.encryptionFileKey]).toEqual([40, 41]);
    wire.rawBytes[1] = 99; node.rawBytes[1] = 98; node.decodedBytes[1] = 97; wire.encryptionFileKey[1] = 96;
    expect([...restored.rawBytes]).toEqual([12, 11]);
    expect([...stream.rawBytes]).toEqual([23, 21, 22]);
    expect([...stream.decodedBytes!]).toEqual([32, 31]);
    expect([...restored.encryptionFileKey!]).toEqual([42, 41]);
  });

  it('isolates xref entry objects in snapshots', () => {
    const doc = fixture();
    const original = doc.xref.entries.get('1_0')!;
    const hydrated = hydrateDocument(dehydrateDocument(doc));
    const snapshot = hydrated.xref.entries.get('1_0')!;
    expect(snapshot).not.toBe(original);
    snapshot.offset = 99;
    expect(original.offset).toBe(0);
  });

  it('uses one graph for newObjects aliases and extracts the same hydrated instance', () => {
    const doc = fixture();
    const shared = doc.objects.get('1_0')!;
    const newObjects = new Map([['8_0', shared]]);
    const wire = dehydrateDocument({ ...doc, objects: new Map([...doc.objects, ...newObjects]) });
    const hydrated = hydrateDocument(wire);
    const extracted = extractNewObjects(hydrated, ['8_0']);
    expect(extracted.get('8_0')).toBe(hydrated.objects.get('1_0'));
  });

  it('optimized fallback does not mutate live objects', async () => {
    resetPDFWorkerForTests();
    const doc = fixture();
    const before = Array.from(doc.objects.entries());
    await saveOptimized(doc);
    expect(Array.from(doc.objects.entries())).toEqual(before);
  });

  it('uses direct parser and writer when Worker is unavailable', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>\nendobj\n4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000219 00000 n \ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n268\n%%EOF\n');
    const doc = await parsePDF(pdf);
    expect(doc.catalog).toBeInstanceOf(PDFDict);
    const saved = await saveQuick(doc);
    expect(saved).toBeInstanceOf(Uint8Array);
    expect(saved.length).toBeGreaterThan(0);
  });

  it('advances live rawBytes across two successful worker quick saves', async () => {
    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      terminate() {}
      postMessage(command: Parameters<typeof handleWorkerCommand>[0]) {
        void handleWorkerCommand(command).then((response) => this.onmessage?.({ data: response } as MessageEvent));
      }
    }
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
    const source = await PDFDocument.create();
    source.addPage([10, 10]);
    const doc = await parseDirect(await source.save({ useObjectStreams: false }));
    const modified = new Set(['1_0']);
    const first = await saveQuick(doc, modified);
    expect(doc.rawBytes).toBe(first);
    const firstLength = first.length;
    const second = await saveQuick(doc, modified);
    expect(doc.rawBytes).toBe(second);
    expect(second.length).toBeGreaterThan(firstLength);
  });

  for (const [fixtureName, password] of encryptedFixtures) {
    for (const commandType of ['SAVE_PDF', 'OPTIMIZE_PDF'] as const) {
      it(`${commandType} exports decrypted ${fixtureName} through the worker`, async () => {
        const source = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'encrypted', fixtureName)));
        const opened = await securityEngine.open(await parseDirect(source), password);
        const wire = dehydrateDocument(opened.doc);
        const response = await handleWorkerCommand(commandType === 'SAVE_PDF'
          ? { type: commandType, requestId: `${fixtureName}-${commandType}`, document: wire }
          : { type: commandType, requestId: `${fixtureName}-${commandType}`, document: wire });
        if (response.type !== 'RESULT' || !response.bytes) throw new Error('worker save failed');
        const reparsed = await parseDirect(response.bytes);
        expect(reparsed.xref.trailerDict.has('Encrypt')).toBe(true);
        const reopened = await securityEngine.open(reparsed, password);
        let text = '';
        for (const object of reopened.doc.objects.values()) {
          if (object instanceof PDFStream) text += new TextDecoder().decode(object.getBytes());
        }
        expect(text).toContain('Hello encrypted');
        expect(new TextDecoder().decode(response.bytes)).not.toContain('Hello encrypted');

        const outputPath = join(tmpdir(), `bloom-worker-${fixtureName}-${commandType}.pdf`);
        writeFileSync(outputPath, response.bytes);
        try {
          const qpdf = spawnSync('qpdf', [`--password=${password}`, '--check', outputPath], { encoding: 'utf8' });
          if ((qpdf.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
            console.info('SKIP qpdf assertion: qpdf is not installed');
          } else {
            expect(qpdf.status).toBe(0);
            expect(`${qpdf.stdout}${qpdf.stderr}`).not.toMatch(/WARNING|ERROR/);
          }
        } finally {
          unlinkSync(outputPath);
        }
      }, 30000);
    }
  }
});
