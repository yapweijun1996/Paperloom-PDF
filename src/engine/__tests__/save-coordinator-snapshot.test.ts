import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';
import { PDFDict, PDFNumber, PDFStream } from '../types';
import { coordinateQuickSave } from '../writer/save-coordinator';
import { dehydrateDocument } from '../worker/codec';

async function fixture() {
  const source = await PDFDocument.create();
  source.addPage([200, 200]);
  const doc = await parsePDF(await source.save({ useObjectStreams: false }));
  doc.rawBytes = Buffer.from(doc.rawBytes);
  const stream = new PDFStream(new PDFDict([['Length', new PDFNumber(3)]]), Buffer.from([1, 2, 3]), Buffer.from([4, 5, 6]));
  doc.objects.set('900_0', stream);
  return { doc, stream };
}

describe('quick save comparison snapshots', () => {
  it('keeps worker bytes independent while rejecting concurrent Buffer-backed stream changes without new objects', async () => {
    const { doc, stream } = await fixture();
    let resume!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const saved = coordinateQuickSave(doc, undefined, undefined, async request => {
      const node = request.document.nodes.find(item => item.kind === 'stream' && item.rawBytes.length === 3);
      expect(node?.kind === 'stream' && [...node.decodedBytes!]).toEqual([4, 5, 6]);
      entered(); await gate;
      expect(node?.kind === 'stream' && [...node.rawBytes]).toEqual([1, 2, 3]);
      return { bytes: new Uint8Array([1]), rawBytesAdvanced: false };
    });
    await ready;
    stream.rawBytes[0] = 9;
    resume();
    await expect(saved).rejects.toThrow(/Document changed during save/);
    expect(stream.rawBytes[0]).toBe(9);
  });

  it('rejects concurrent changes when newObjects contains the identical live object', async () => {
    const { doc, stream } = await fixture();
    let resume!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const saved = coordinateQuickSave(doc, undefined, new Map([['900_0', stream]]), async () => {
      entered(); await gate;
      return { bytes: new Uint8Array([1]), rawBytesAdvanced: false };
    });
    await ready;
    stream.rawBytes[1] = 8;
    resume();
    await expect(saved).rejects.toThrow(/Document changed during save/);
    expect(stream.rawBytes[1]).toBe(8);
  });

  it('omits decoded cache only when explicitly requested and keeps raw data independent', async () => {
    const { doc, stream } = await fixture();
    const wire = dehydrateDocument(doc, { includeDecodedBytes: false });
    const node = wire.nodes.find(item => item.kind === 'stream' && item.rawBytes.length === 3);
    expect(node?.kind === 'stream' && node.decodedBytes).toBeNull();
    stream.rawBytes[2] = 7;
    expect(node?.kind === 'stream' && [...node.rawBytes]).toEqual([1, 2, 3]);
  });
});
