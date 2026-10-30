import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { parsePDF } from '../parser/parser';
import { runDocumentTransaction } from '../session/document-transaction';

async function fixture() {
  const pdf = await PDFDocument.create();
  pdf.addPage([100, 100]);
  return parsePDF(await pdf.save({ useObjectStreams: false }));
}

describe('transaction byte isolation', () => {
  it('does not mutate live Buffer bytes when a staged operation fails', async () => {
    const doc = await fixture();
    doc.rawBytes = Buffer.from(doc.rawBytes);
    doc.encryptionFileKey = Buffer.from([1, 2, 3]);
    const raw = new Uint8Array(doc.rawBytes), key = new Uint8Array(doc.encryptionFileKey);
    await expect(runDocumentTransaction(doc, async staged => {
      staged.rawBytes[0] ^= 255;
      staged.encryptionFileKey![0] = 99;
      throw new Error('staged failure');
    })).rejects.toThrow('staged failure');
    expect([...doc.rawBytes]).toEqual([...raw]);
    expect([...doc.encryptionFileKey!]).toEqual([...key]);
  });

  it('does not retain a Buffer supplied by a successful staged operation', async () => {
    const doc = await fixture(), supplied = Buffer.from([4, 5, 6]);
    await runDocumentTransaction(doc, async staged => { staged.rawBytes = supplied; });
    supplied[0] = 99;
    expect([...doc.rawBytes]).toEqual([4, 5, 6]);
  });
});
