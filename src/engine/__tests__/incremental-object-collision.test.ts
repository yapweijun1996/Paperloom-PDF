import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePDF } from '../parser/parser';
import { findStartXref } from '../parser/xref';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFString } from '../types';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { SessionDocumentEditor } from '../session/document-edit';
import { saveQuick as saveDirect, saveQuickUnchecked } from '../writer/save-pipeline';
import { saveQuick as saveWorker, resetPDFWorkerForTests } from '../worker/client';
import { handleWorkerCommand } from '../worker/handler';
import { dehydrateDocument, sameDocumentSnapshot } from '../worker/codec';
import { appendIncrementalUpdate, IncrementalUpdateSession, OffsetManager, RevisionManager, saveIncremental } from '../writer/incremental-writer';

async function fixture() {
  const pdf = await PDFDocument.create(); pdf.addPage([200, 200]); pdf.addPage([200, 200]);
  return parsePDF(await pdf.save({ useObjectStreams: false }));
}
function assertMark(doc: Awaited<ReturnType<typeof fixture>>, expected: boolean) {
  const obj = doc.pages[0].dict.get('Annots');
  if (!expected) { expect(obj).toBeUndefined(); return; }
  expect(obj).toBeInstanceOf(PDFArray);
  const item = (obj as PDFArray).items[0] as PDFRef;
  expect((doc.objects.get(item.toKey()) as PDFDict).getName('Subtype')).toBe('Redact');
}
class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminate() {}
  postMessage(command: Parameters<typeof handleWorkerCommand>[0]) {
    const copy = structuredClone(command);
    void handleWorkerCommand(copy).then(response => this.onmessage?.({ data: structuredClone(response) } as MessageEvent));
  }
}
afterEach(() => { resetPDFWorkerForTests(); delete (globalThis as { Worker?: unknown }).Worker; });
describe('independent incremental redaction mark audit', () => {
  it.each(['direct', 'worker', 'append'] as const)('publishes the emitted xref trailer for %s saves', async mode => {
    if (mode === 'worker') Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
    const doc = await fixture();
    const previousXref = findStartXref(doc.rawBytes);
    const additions = new Map([['900_0', new PDFString('revision')]]);
    const bytes = mode === 'append' ? appendIncrementalUpdate(doc, new Set(), additions).bytes
      : await (mode === 'worker' ? saveWorker : saveDirect)(doc, new Set(), additions);
    const reopened = await parsePDF(bytes);
    for (const key of ['Size', 'Prev', 'XRefStm']) {
      expect(doc.xref.trailerDict.getNumber(key)).toBe(reopened.xref.trailerDict.getNumber(key));
    }
    expect(doc.xref.trailerDict.getNumber('Size')).toBeGreaterThan(900);
    expect(doc.xref.trailerDict.getNumber('Prev')).toBe(previousXref);
  });
  it('retains the existing trailer size when high-numbered objects leave the live graph', async () => {
    const doc = await fixture();
    appendIncrementalUpdate(doc, new Set(), new Map([['900_0', new PDFString('previous')]]));
    doc.objects.delete('900_0');
    const result = appendIncrementalUpdate(doc, new Set([doc.pages[0].ref.toKey()]));
    expect(doc.xref.trailerDict.getNumber('Size')).toBeGreaterThan(900);
    expect((await parsePDF(result.bytes)).xref.trailerDict.getNumber('Size')).toBeGreaterThan(900);
  });
  it.each(['direct', 'worker'] as const)('preserves a mark with a separate new object via %s save', async mode => {
    if (mode === 'worker') Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
    const doc = await fixture();
    redactionEngine.markRegion(doc, 0, { x: 10, y: 10, width: 20, height: 20 });
    const newRef = new PDFRef(900, 0);
    const added = new Map([[newRef.toKey(), new PDFDict([['Type', new PDFName('Test')]])]]);
    const bytes = await (mode === 'worker' ? saveWorker : saveDirect)(doc, undefined, added);
    const parsed = await parsePDF(bytes);
    assertMark(parsed, true);
    expect(parsed.objects.get(newRef.toKey())).toBeInstanceOf(PDFDict);
  });
  it('supports mark undo/redo across explicit incremental saves', async () => {
    const doc = await fixture(), editor = new SessionDocumentEditor();
    await editor.edit(doc, 'mark', async draft => { redactionEngine.markRegion(draft, 0, { x: 10, y: 10, width: 20, height: 20 }); });
    doc.pages[1].dict.set('Rotate', new PDFNumber(90));
    assertMark(await parsePDF(await saveDirect(doc, new Set([doc.pages[1].ref.toKey()]))), true);
    expect(await editor.undo(doc)).toBe(true);
    assertMark(await parsePDF(await saveDirect(doc, new Set([doc.pages[1].ref.toKey()]))), false);
    expect(await editor.redo(doc)).toBe(true);
    assertMark(await parsePDF(await saveDirect(doc, new Set([doc.pages[1].ref.toKey()]))), true);
  });
  it.each(['direct', 'worker'] as const)('does not overwrite a newly created mark with a colliding new object via %s save', async mode => {
    if (mode === 'worker') Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
    const doc = await fixture();
    const mark = redactionEngine.markRegion(doc, 0, { x: 10, y: 10, width: 20, height: 20 });
    const competing = new Map([[mark.toKey(), new PDFDict([['Type', new PDFName('Test')]])]]);
    const before = dehydrateDocument(doc);
    await expect((mode === 'worker' ? saveWorker : saveDirect)(doc, undefined, competing)).rejects.toThrow(/conflicts/);
    expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
    expect((doc.objects.get(mark.toKey()) as PDFDict).getName('Subtype')).toBe('Redact');
  });

  it('allows a caller to list the exact object already stored under the same key', async () => {
    const doc = await fixture();
    const mark = redactionEngine.markRegion(doc, 0, { x: 10, y: 10, width: 20, height: 20 });
    const same = doc.objects.get(mark.toKey())!;
    const parsed = await parsePDF(await saveDirect(doc, undefined, new Map([[mark.toKey(), same]])));
    assertMark(parsed, true);
    expect(doc.objects.get(mark.toKey())).toBe(same);
  });

  it.each(['append', 'save'] as const)(
    'rejects a colliding object in the public low-level %s API without changing the document', async mode => {
      const doc = await fixture();
      const mark = redactionEngine.markRegion(doc, 0, { x: 10, y: 10, width: 20, height: 20 });
      const before = dehydrateDocument(doc), raw = doc.rawBytes;
      const additions = new Map([[mark.toKey(), new PDFString('conflict')]]);
      const save = () => mode === 'append'
        ? appendIncrementalUpdate(doc, new Set(), additions)
        : saveIncremental(doc, new Set(), additions);
      expect(save).toThrow(/conflicts/);
      expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
      expect(doc.rawBytes).toBe(raw);
    },
  );

  it('rejects a conflicting session object before mutating the live graph', async () => {
    const doc = await fixture(), ref = doc.xref.trailerDict.getRef('Root')!;
    const original = doc.objects.get(ref.toKey()), before = dehydrateDocument(doc);
    const session = new IncrementalUpdateSession(doc);
    expect(() => session.addNewObject(ref, new PDFDict())).toThrow(/conflicts/);
    expect(doc.objects.get(ref.toKey())).toBe(original);
    expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
  });

  it('does not stage a session object when incremental output is prohibited', async () => {
    const doc = await fixture(); doc.requiresFullRewrite = true;
    const before = dehydrateDocument(doc), session = new IncrementalUpdateSession(doc);
    expect(() => session.addNewObject(new PDFRef(900, 0), new PDFString('staged'))).toThrow(/full rewrite/);
    expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
  });

  it('commits a non-conflicting session object', async () => {
    const doc = await fixture(), session = new IncrementalUpdateSession(doc);
    session.addNewObject(new PDFRef(900, 0), new PDFString('fresh'));
    const parsed = await parsePDF(session.commit().bytes);
    expect((parsed.objects.get('900_0') as PDFString).value).toBe('fresh');
  });

  it('publishes no new objects when a later object fails serialization', async () => {
    const doc = await fixture(), before = dehydrateDocument(doc), raw = doc.rawBytes;
    const offsets = new OffsetManager(raw.length), revisions = new RevisionManager(raw);
    const oldOffsets = offsets.snapshot(), oldRevisions = revisions.snapshot();
    const cyclic = new PDFArray(); cyclic.push(cyclic);
    const additions = new Map<string, PDFString | PDFArray>([['900_0', new PDFString('first')], ['901_0', cyclic]]);
    expect(() => appendIncrementalUpdate(doc, new Set(), additions, { offsetManager: offsets, revisionManager: revisions })).toThrow(/cyclic/i);
    expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
    expect(doc.rawBytes).toBe(raw);
    expect(offsets.snapshot()).toEqual(oldOffsets);
    expect(revisions.snapshot()).toEqual(oldRevisions);
  });

  it('publishes no new objects if serializing the trailer fails', async () => {
    const doc = await fixture(), cyclic = new PDFArray(); cyclic.push(cyclic);
    doc.xref.trailerDict.set('ID', cyclic);
    const before = dehydrateDocument(doc), raw = doc.rawBytes;
    const offsets = new OffsetManager(raw.length), revisions = new RevisionManager(raw);
    const oldOffsets = offsets.snapshot(), oldRevisions = revisions.snapshot();
    expect(() => appendIncrementalUpdate(doc, new Set(), new Map([['900_0', new PDFString('new')]]),
      { offsetManager: offsets, revisionManager: revisions })).toThrow(/cyclic/i);
    expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
    expect(doc.rawBytes).toBe(raw);
    expect(offsets.snapshot()).toEqual(oldOffsets);
    expect(revisions.snapshot()).toEqual(oldRevisions);
  });

  it.each(['offsets', 'revisions'] as const)(
    'restores document and manager state when the %s manager fails', async target => {
      const doc = await fixture(), before = dehydrateDocument(doc), raw = doc.rawBytes;
      const offsets = new OffsetManager(raw.length), revisions = new RevisionManager(raw);
      offsets.record('77_0', 7, 4);
      const oldOffsets = offsets.snapshot(), oldRevisions = revisions.snapshot();
      if (target === 'offsets') {
        const recordBatch = offsets.recordBatch.bind(offsets);
        vi.spyOn(offsets, 'recordBatch').mockImplementation((...args) => { recordBatch(...args); throw new Error('injected failure'); });
      } else {
        const pushRevision = revisions.pushRevision.bind(revisions);
        vi.spyOn(revisions, 'pushRevision').mockImplementation(opts => { pushRevision(opts); throw new Error('injected failure'); });
      }
      expect(() => appendIncrementalUpdate(doc, new Set(), new Map([['900_0', new PDFString('new')]]),
        { offsetManager: offsets, revisionManager: revisions })).toThrow(/injected failure/);
      expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
      expect(doc.rawBytes).toBe(raw);
      expect(offsets.snapshot()).toEqual(oldOffsets);
      expect(revisions.snapshot()).toEqual(oldRevisions);
      vi.restoreAllMocks();
    },
  );

  it('includes deferred new objects in the trailer size and publishes them after success', async () => {
    const doc = await fixture(), object = new PDFString('fresh');
    const result = appendIncrementalUpdate(doc, new Set(), new Map([['900_0', object]]));
    expect(result.size).toBeGreaterThan(900);
    expect(doc.objects.get('900_0')).toBe(object);
    expect(doc.rawBytes).toBe(result.bytes);
    const parsed = await parsePDF(result.bytes);
    expect(parsed.xref.trailerDict.getNumber('Size')).toBeGreaterThan(900);
    expect((parsed.objects.get('900_0') as PDFString).value).toBe('fresh');
  });

  it.each(['direct', 'worker', 'unchecked', 'append', 'save'] as const)(
    'rejects duplicate modified generations before mutation via %s', async mode => {
      if (mode === 'worker') Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
      const doc = await fixture();
      doc.objects.set('900_0', new PDFString('first'));
      doc.objects.set('900_1', new PDFString('second'));
      const before = dehydrateDocument(doc), raw = doc.rawBytes;
      const keys = new Set(['900_0', '900_1']);
      if (mode === 'direct') await expect(saveDirect(doc, keys)).rejects.toThrow(/conflicting generations/);
      else if (mode === 'worker') await expect(saveWorker(doc, keys)).rejects.toThrow(/conflicting generations/);
      else if (mode === 'unchecked') await expect(saveQuickUnchecked(doc, keys)).rejects.toThrow(/conflicting generations/);
      else if (mode === 'append') expect(() => appendIncrementalUpdate(doc, keys)).toThrow(/conflicting generations/);
      else expect(() => saveIncremental(doc, keys)).toThrow(/conflicting generations/);
      expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
      expect(doc.rawBytes).toBe(raw);
    },
  );

  it.each(['different generation', 'two new generations', 'in-use xref', 'unloaded same xref', 'wrong free generation'] as const)(
    'rejects %s for an existing object number without mutation', async mode => {
      const doc = await fixture();
      const mark = redactionEngine.markRegion(doc, 0, { x: 10, y: 10, width: 20, height: 20 });
      const additions = new Map<string, PDFString>();
      if (mode === 'different generation') additions.set(`${mark.objNum}_1`, new PDFString('competing'));
      if (mode === 'two new generations') {
        additions.set('900_0', new PDFString('first'));
        additions.set('900_1', new PDFString('second'));
      }
      if (mode === 'in-use xref') {
        doc.xref.entries.set('900_0', { objNum: 900, genNum: 0, offset: 42, type: 'n' });
        additions.set('900_1', new PDFString('other generation'));
      }
      if (mode === 'unloaded same xref') {
        doc.xref.entries.set('900_0', { objNum: 900, genNum: 0, offset: 42, type: 'n' });
        additions.set('900_0', new PDFString('unloaded existing object'));
      }
      if (mode === 'wrong free generation') {
        doc.xref.entries.set('900_1', { objNum: 900, genNum: 1, offset: 0, type: 'f' });
        additions.set('900_0', new PDFString('wrong free generation'));
      }
      const before = dehydrateDocument(doc);
      await expect(saveDirect(doc, undefined, additions)).rejects.toThrow(/conflicts/);
      expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
    },
  );

  it('permits reuse of a free object at its advertised generation', async () => {
    const original = await fixture();
    const root = original.xref.trailerDict.getRef('Root')!;
    const xrefOffset = original.rawBytes.length + 1;
    const suffix = new TextEncoder().encode(`\nxref\n900 1\n0000000000 00001 f \ntrailer\n<< /Size 901 /Root ${root.objNum} ${root.genNum} R /Prev ${findStartXref(original.rawBytes)} >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
    const bytes = new Uint8Array(original.rawBytes.length + suffix.length);
    bytes.set(original.rawBytes); bytes.set(suffix, original.rawBytes.length);
    const doc = await parsePDF(bytes);
    const added = new PDFString('reused-free');
    const reopened = await parsePDF(await saveDirect(doc, undefined, new Map([['900_1', added]])));
    expect((reopened.objects.get('900_1') as PDFString).value).toBe('reused-free');
  });

  it('detects a collision when an earlier queued save claims the same number', async () => {
    const doc = await fixture();
    const firstObject = new PDFString('first'), conflictingObject = new PDFString('second');
    const first = saveDirect(doc, undefined, new Map([['900_0', firstObject]]));
    const second = saveDirect(doc, undefined, new Map([['900_1', conflictingObject]]));
    // Attach the handler immediately to avoid an unhandled rejection if the
    // queued check runs before this test resumes after the first save.
    const secondResult = second.then(() => null, error => error as Error);
    await first;
    const before = dehydrateDocument(doc);
    expect((await secondResult)?.message).toMatch(/conflicts/);
    expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
    expect(doc.objects.get('900_0')).toBe(firstObject);
    expect(doc.objects.has('900_1')).toBe(false);
  });
});
