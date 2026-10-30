import { PDFDocument, PDFName as LibName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';
import { metadataEngine } from '../security/metadata/metadata-engine';
import { sanitizationEngine } from '../security/sanitization/sanitization-engine';
import { PDFArray, PDFDict, PDFRef, PDFString } from '../types';
import { serializeDocument } from '../writer/serializer';
import { saveQuick } from '../writer/save-pipeline';

const noCleanup = {
  metadata: false, javascript: false, embeddedFiles: false, comments: false,
  annotations: false, unusedObjects: false, hiddenLayers: false, alternativeImages: false,
};

async function fixture() {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.addPage([200, 200]);
  pdf.setTitle('original title');
  return parsePDF(await pdf.save({ useObjectStreams: false }));
}

describe('shared Info metadata values', () => {
  it.each(['standalone', 'sanitization'] as const)(
    'refuses %s when removed Info metadata remains indirectly reachable', async mode => {
      const doc = await fixture();
      const ref = new PDFRef(999, 0);
      const info = doc.objects.get(doc.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;
      info.set('Title', ref);
      doc.objects.set(ref.toKey(), new PDFString('PRIVATE_SHARED_INFO_549'));
      doc.catalog.set('RetainedPrivateInfo', ref);

      // Establish that this is a real serialized reference, not only shared
      // JavaScript object identity in an in-memory fixture.
      const input = await serializeDocument(doc);
      const independent = await PDFDocument.load(input, { updateMetadata: false });
      expect(independent.catalog.lookup(LibName.of('RetainedPrivateInfo'))?.toString()).toContain('PRIVATE_SHARED_INFO_549');
      const reopened = await parsePDF(input);
      const before = await serializeDocument(reopened);
      if (mode === 'standalone') {
        expect(() => metadataEngine.stripMetadata(reopened)).toThrow(/shared metadata/i);
      } else {
        await expect(sanitizationEngine.sanitize(reopened, { ...noCleanup, metadata: true })).rejects.toThrow(/shared metadata/i);
      }
      expect(await serializeDocument(reopened)).toEqual(before);
      expect(reopened.requiresFullRewrite).toBeUndefined();
    },
  );

  it('refuses a removed value shared with a preserved Info field', async () => {
    const doc = await fixture();
    const ref = new PDFRef(999, 0);
    const info = doc.objects.get(doc.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;
    info.set('Title', ref);
    info.set('Producer', ref);
    doc.objects.set(ref.toKey(), new PDFString('PRIVATE_PRESERVED_VALUE_717'));
    const before = await serializeDocument(doc);
    expect(() => metadataEngine.stripMetadata(doc, { preserveProducer: true })).toThrow(/shared metadata/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('refuses a nested Info descendant shared with other document content', async () => {
    const doc = await fixture();
    const ref = new PDFRef(17, 0);
    const info = doc.objects.get(doc.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;
    info.set('PrivateDetails', new PDFDict([['nested', new PDFArray([ref])]]));
    doc.objects.set(ref.toKey(), new PDFString('PRIVATE_NESTED_INFO_483'));
    doc.catalog.set('RetainedPrivateInfo', ref);
    const before = await serializeDocument(doc);
    expect(() => metadataEngine.stripMetadata(doc)).toThrow(/shared metadata/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('refuses a removed field shared with custom metadata requested to be retained', async () => {
    const doc = await fixture();
    const ref = new PDFRef(17, 0);
    const info = doc.objects.get(doc.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;
    info.set('Title', ref);
    info.set('RetainedCustom', ref);
    doc.objects.set(ref.toKey(), new PDFString('PRIVATE_CUSTOM_SHARED_113'));
    const before = await serializeDocument(doc);
    expect(() => metadataEngine.stripMetadata(doc, { stripCustom: false })).toThrow(/shared metadata/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('refuses an unresolved removed value without changing the document', async () => {
    const doc = await fixture();
    const info = doc.objects.get(doc.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;
    info.set('Title', new PDFRef(17, 0));
    expect(() => metadataEngine.stripMetadata(doc)).toThrow(/inspect shared metadata/i);
    expect(info.has('Title')).toBe(true);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('removes an unshared indirect Info value from quick save output', async () => {
    const doc = await fixture();
    const ref = new PDFRef(17, 0);
    const info = doc.objects.get(doc.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;
    info.set('Title', ref);
    doc.objects.set(ref.toKey(), new PDFString('PRIVATE_INDIRECT_INFO_827'));
    doc.rawBytes = await serializeDocument(doc);
    const reopened = await parsePDF(doc.rawBytes);
    metadataEngine.stripMetadata(reopened);
    const output = await saveQuick(reopened);
    expect(new TextDecoder().decode(output)).not.toContain('PRIVATE_INDIRECT_INFO_827');
    const independent = await PDFDocument.load(output, { updateMetadata: false });
    expect(independent.getTitle()).toBeUndefined();
  });

  it('still strips unshared Info while preserving a distinct Producer', async () => {
    const doc = await fixture();
    const info = doc.objects.get(doc.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;
    info.set('Title', new PDFString('PRIVATE_UNSHARED_TITLE_618'));
    info.set('Producer', new PDFString('PUBLIC_PRODUCER'));
    metadataEngine.stripMetadata(doc, { preserveProducer: true });
    const output = await serializeDocument(doc);
    expect(new TextDecoder().decode(output)).not.toContain('PRIVATE_UNSHARED_TITLE_618');
    const independent = await PDFDocument.load(output, { updateMetadata: false });
    expect(independent.getTitle()).toBeUndefined();
    expect(independent.getProducer()).toBe('PUBLIC_PRODUCER');
  });
});
