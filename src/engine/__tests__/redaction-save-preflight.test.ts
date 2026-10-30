import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { parsePDF } from '../parser/parser';
import { updatePageContent } from '../editor/stream-compiler';
import { PDFArray, PDFDict, PDFRef, PDFString } from '../types';
import { dehydrateDocument, sameDocumentSnapshot } from '../worker/codec';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { prepareWholePageRedaction } from '../security/redaction/whole-page-redaction';
import { preparePartialGraphicsRedaction } from '../security/redaction/partial-graphics-redaction';
import { saveQuick } from '../writer/save-pipeline';

async function fixture() {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  doc.pages[0].resources = new PDFDict();
  doc.pages[0].dict.set('Resources', doc.pages[0].resources);
  await updatePageContent(doc.pages[0].contentRefs, new TextEncoder().encode('q 20 20 10 10 re f Q\n'), doc.objects, false);
  return doc;
}

describe('redaction save preflight', () => {
  it.each(['whole', 'graphics'] as const)('rejects a retained direct cycle before %s redaction commits', async mode => {
    const doc = await fixture();
    redactionEngine.markRegion(doc, 0, mode === 'whole'
      ? { x: 0, y: 0, width: 200, height: 200 } : { x: 19, y: 19, width: 12, height: 12 });
    const cycle = new PDFDict();
    cycle.set('Self', cycle);
    doc.catalog.set('PrivateCycle', cycle);
    const before = dehydrateDocument(doc);
    const prepare = mode === 'whole' ? prepareWholePageRedaction : preparePartialGraphicsRedaction;
    expect(() => prepare(doc)).toThrow(/safely serialized/i);
    expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('rejects exponential retained direct-object expansion before public redaction commits', async () => {
    const doc = await fixture();
    redactionEngine.markRegion(doc, 0, { x: 0, y: 0, width: 200, height: 200 });
    let value: PDFArray = new PDFArray();
    for (let i = 0; i < 24; i++) value = new PDFArray([value, value]);
    doc.catalog.set('PrivateDag', value);
    const before = dehydrateDocument(doc);
    await expect(redactionEngine.applySecureRedactions(doc)).rejects.toThrow();
    expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
    expect(doc.requiresFullRewrite).toBeUndefined();
  }, 30000);

  it('rejects a reader-unsafe sparse object number before redaction commits', async () => {
    const doc = await fixture();
    redactionEngine.markRegion(doc, 0, { x: 0, y: 0, width: 200, height: 200 });
    const ref = new PDFRef(20_000_000, 0);
    doc.objects.set(ref.toKey(), new PDFDict([['Value', new PDFString('RETAINED')]]));
    doc.catalog.set('PrivateSparse', ref);
    const before = dehydrateDocument(doc);
    expect(() => prepareWholePageRedaction(doc)).toThrow(/safely serialized/i);
    expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('saves and reopens supported retained direct objects after redaction', async () => {
    const doc = await fixture();
    doc.catalog.set('PrivateData', new PDFDict([['Nested', new PDFArray([new PDFDict()])]]));
    redactionEngine.markRegion(doc, 0, { x: 0, y: 0, width: 200, height: 200 });
    await redactionEngine.applySecureRedactions(doc);
    const reopened = await parsePDF(await saveQuick(doc));
    expect(reopened.catalog.getDict('PrivateData')?.getArray('Nested')?.length).toBe(1);
  });
});
