import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';
import { PDFDict, PDFNumber, PDFStream } from '../types';
import { coordinateQuickSave } from '../writer/save-coordinator';
import { deferred } from './test-deferred';

async function fixture() {
  const source = await PDFDocument.create();
  source.addPage([200, 200]);
  const doc = await parsePDF(await source.save({ useObjectStreams: false }));
  const shared = new Uint8Array(new SharedArrayBuffer(3));
  shared.set([1, 2, 3]);
  const stream = new PDFStream(new PDFDict([['Length', new PDFNumber(3)]]), shared);
  doc.objects.set('900_0', stream);
  return { doc, stream };
}

function pendingSave(doc: Awaited<ReturnType<typeof fixture>>['doc'], newObjects?: Map<string, PDFStream>) {
  const started = deferred<void>();
  const gate = deferred<void>();
  const result = coordinateQuickSave(doc, undefined, newObjects, async () => {
    started.resolve();
    await gate.promise;
    return { bytes: new Uint8Array([1]), rawBytesAdvanced: false };
  });
  return { started: started.promise, resume: () => gate.resolve(), result };
}

describe('independent save snapshot audit', () => {
  it('rejects an in-place SharedArrayBuffer change when an identical live object is listed', async () => {
    const { doc, stream } = await fixture();
    const save = pendingSave(doc, new Map([['900_0', stream]]));
    await save.started;
    stream.rawBytes[0] = 9;
    save.resume();
    await expect(save.result).rejects.toThrow(/Document changed during save/);
    expect(stream.rawBytes[0]).toBe(9);
  });

  it('rejects a changed pending new object and does not publish it', async () => {
    const { doc } = await fixture();
    const added = new PDFStream(new PDFDict([['Length', new PDFNumber(3)]]), Buffer.from([7, 8, 9]));
    const save = pendingSave(doc, new Map([['901_0', added]]));
    await save.started;
    added.rawBytes[1] = 3;
    save.resume();
    await expect(save.result).rejects.toThrow(/Document changed during save/);
    expect(doc.objects.has('901_0')).toBe(false);
    expect(added.rawBytes[1]).toBe(3);
  });

  it('rejects replacement with an equal but distinct object when the request aliases the live object', async () => {
    const { doc, stream } = await fixture();
    const save = pendingSave(doc, new Map([['900_0', stream]]));
    await save.started;
    const replacement = new PDFStream(new PDFDict([['Length', new PDFNumber(3)]]), new Uint8Array([1, 2, 3]));
    doc.objects.set('900_0', replacement);
    save.resume();
    await expect(save.result).rejects.toThrow(/Document changed during save/);
    expect(doc.objects.get('900_0')).toBe(replacement);
  });

  it('isolates worker wire bytes from the live graph including added objects', async () => {
    const { doc, stream } = await fixture();
    const added = new PDFStream(new PDFDict([['Length', new PDFNumber(3)]]), Buffer.from([7, 8, 9]));
    const originalRaw = doc.rawBytes[0];
    const result = await coordinateQuickSave(doc, undefined, new Map([['901_0', added]]), async request => {
      const liveId = request.document.objects.find(([key]) => key === '900_0')?.[1];
      const addedId = request.document.objects.find(([key]) => key === '901_0')?.[1];
      const liveNode = request.document.nodes.find(node => node.id === liveId);
      const addedNode = request.document.nodes.find(node => node.id === addedId);
      if (!request.document.rawBytes || liveNode?.kind !== 'stream' || addedNode?.kind !== 'stream') throw new Error('Missing wire bytes');
      request.document.rawBytes[0] ^= 1;
      liveNode.rawBytes[0] = 4;
      addedNode.rawBytes[0] = 5;
      return { bytes: new Uint8Array([1]), rawBytesAdvanced: false };
    });
    expect(result).toEqual(new Uint8Array([1]));
    expect(doc.rawBytes[0]).toBe(originalRaw);
    expect([...stream.rawBytes]).toEqual([1, 2, 3]);
    expect([...added.rawBytes]).toEqual([7, 8, 9]);
    expect(doc.objects.get('901_0')).toBe(added);
  });
});
