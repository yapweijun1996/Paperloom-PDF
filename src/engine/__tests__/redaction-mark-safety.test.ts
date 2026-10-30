import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef } from '../types';
import { dehydrateDocument, sameDocumentSnapshot } from '../worker/codec';
import { saveQuick } from '../writer/save-pipeline';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { runDocumentTransaction } from '../session/document-transaction';

async function fixture() {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  pdf.addPage([200, 200]);
  return parsePDF(await pdf.save({ useObjectStreams: false }));
}

describe('redaction mark creation', () => {
  it.each([
    { x: 0, y: 0, width: 0, height: 1 },
    { x: 0, y: 0, width: -1, height: 1 },
    { x: NaN, y: 0, width: 1, height: 1 },
    { x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 1 },
    { x: 0, y: 0, width: 1, height: Infinity },
  ])('rejects an invalid rectangle before changing the document', async rect => {
    const doc = await fixture();
    const before = dehydrateDocument(doc);
    expect(() => redactionEngine.markRegion(doc, 0, rect)).toThrow(/invalid rectangle/);
    expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
  });

  it.each([-1, 2, 0.5, NaN])('rejects invalid page index %s without mutation', async page => {
    const doc = await fixture();
    const before = dehydrateDocument(doc);
    expect(() => redactionEngine.markRegion(doc, page, { x: 0, y: 0, width: 10, height: 10 })).toThrow(/invalid page/);
    expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
  });

  it.each(['number', 'missing', 'cycle'] as const)(
    'rejects %s annotation arrays instead of creating an unattached mark', async type => {
      const doc = await fixture();
      const ref = new PDFRef(700, 0);
      if (type === 'number') doc.pages[0].dict.set('Annots', new PDFNumber(7));
      else {
        doc.pages[0].dict.set('Annots', ref);
        if (type === 'cycle') doc.objects.set(ref.toKey(), ref);
      }
      const before = dehydrateDocument(doc);
      expect(() => redactionEngine.markRegion(doc, 0, { x: 0, y: 0, width: 10, height: 10 })).toThrow(/annotations/);
      expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
    },
  );

  it.each(['direct', 'indirect'] as const)(
    'adds a mark only to the selected page when an annotation array is shared (%s)', async kind => {
      const doc = await fixture();
      const existingRef = new PDFRef(700, 0), sharedRef = new PDFRef(701, 0);
      doc.objects.set(existingRef.toKey(), new PDFDict([['Type', new PDFName('Annot')], ['Subtype', new PDFName('Text')]]));
      const shared = new PDFArray([existingRef]);
      if (kind === 'indirect') doc.objects.set(sharedRef.toKey(), shared);
      for (const page of doc.pages) page.dict.set('Annots', kind === 'direct' ? shared : sharedRef);

      const mark = redactionEngine.markRegion(doc, 0, { x: 10, y: 10, width: 20, height: 20 });
      expect(shared.items).toEqual([existingRef]);
      expect((doc.pages[0].dict.get('Annots') as PDFArray).items.map(item => (item as PDFRef).toKey())).toEqual([existingRef.toKey(), mark.toKey()]);
      const reopened = await parsePDF(await saveQuick(doc));
      const annots = (index: number) => {
        const value = reopened.pages[index].dict.get('Annots');
        return value instanceof PDFRef ? reopened.objects.get(value.toKey()) : value;
      };
      expect((annots(0) as PDFArray).length).toBe(2);
      expect((annots(1) as PDFArray).length).toBe(1);
      expect((reopened.objects.get(mark.toKey()) as PDFDict).getName('Subtype')).toBe('Redact');
    },
  );

  it.each(['direct', 'staged'] as const)(
    'preserves a %s redaction mark during an explicit incremental save of another page', async mode => {
      const doc = await fixture();
      const original = new Uint8Array(doc.rawBytes);
      let mark: PDFRef | undefined;
      if (mode === 'direct') mark = redactionEngine.markRegion(doc, 0, { x: 10, y: 10, width: 20, height: 20 });
      else await runDocumentTransaction(doc, async staged => {
        mark = redactionEngine.markRegion(staged, 0, { x: 10, y: 10, width: 20, height: 20 });
      });
      doc.pages[1].dict.set('Rotate', new PDFNumber(90));
      const saved = await saveQuick(doc, new Set([doc.pages[1].ref.toKey()]));
      expect(saved.slice(0, original.length)).toEqual(original);
      const reopened = await parsePDF(saved);
      const annots = reopened.pages[0].dict.get('Annots');
      expect(annots).toBeInstanceOf(PDFArray);
      expect((annots as PDFArray).items.map(item => (item as PDFRef).toKey())).toContain(mark!.toKey());
      expect((reopened.objects.get(mark!.toKey()) as PDFDict).getName('Subtype')).toBe('Redact');
      expect(reopened.pages[1].dict.getNumber('Rotate')).toBe(90);
    },
  );
});
