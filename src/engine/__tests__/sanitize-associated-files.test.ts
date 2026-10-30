import { installSignatureBase } from '../signatures/crypto/signing-pipeline';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFStream, PDFString } from '../types';
import { sanitizationEngine } from '../security/sanitization/sanitization-engine';
import { embeddedFileSecurityEngine } from '../security/embedded-files/embedded-file-engine';
import { serializeDocument } from '../writer/serializer';
import { appendIncrementalUpdate, saveIncremental } from '../writer/incremental-writer';
import { securityInspector } from '../security/inspector/security-inspector';
import { saveQuick } from '../writer/save-pipeline';
import { createSignatureField, importFromPem, signDocumentCryptographic, validateDocumentSignatures } from '../signatures';
import { getTestCredentials } from './signatures/test-credentials';

async function fixture() {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]).drawText('Keep page content');
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  const bytes = new TextEncoder().encode('ASSOCIATED_FILE_PRIVATE_PAYLOAD');
  const streamRef = new PDFRef(900, 0);
  const fileRef = new PDFRef(901, 0);
  const namesRef = new PDFRef(902, 0);
  doc.objects.set(streamRef.toKey(), new PDFStream(new PDFDict([
    ['Type', new PDFName('EmbeddedFile')], ['Length', new PDFNumber(bytes.length)],
  ]), bytes, bytes));
  doc.objects.set(fileRef.toKey(), new PDFDict([
    ['Type', new PDFName('Filespec')], ['F', new PDFString('private.txt')],
    ['EF', new PDFDict([['F', streamRef]])],
  ]));
  doc.objects.set(namesRef.toKey(), new PDFArray([new PDFString('private.txt'), fileRef]));
  doc.catalog.set('Names', new PDFDict([['EmbeddedFiles', new PDFDict([['Names', namesRef]])]]));
  doc.catalog.set('AF', new PDFArray([fileRef]));
  doc.pages[0].dict.set('AF', new PDFArray([fileRef]));
  // Direct annotation as permitted by the parser, with a second association.
  doc.pages[0].dict.set('Annots', new PDFArray([new PDFDict([
    ['Subtype', new PDFName('FileAttachment')], ['FS', fileRef],
  ])]));
  return { doc, streamRef };
}

describe('embedded-file sanitization', () => {
  it.each(['removeAttachment', 'removeAllAttachments'] as const)(
    'refuses %s when the page cache omits an associated attachment', async method => {
      const pdf = await PDFDocument.create();
      pdf.addPage([200, 200]);
      pdf.addPage([200, 200]);
      const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
      const payload = new TextEncoder().encode('MISSED_PAGE_ATTACHMENT');
      const streamRef = new PDFRef(900, 0);
      const specRef = new PDFRef(901, 0);
      doc.objects.set(streamRef.toKey(), new PDFStream(new PDFDict([
        ['Type', new PDFName('EmbeddedFile')], ['Length', new PDFNumber(payload.length)],
      ]), payload, payload));
      doc.objects.set(specRef.toKey(), new PDFDict([
        ['Type', new PDFName('Filespec')], ['F', new PDFString('missing.txt')],
        ['EF', new PDFDict([['F', streamRef]])],
      ]));
      doc.pages[1].dict.set('AF', new PDFArray([specRef]));
      doc.pages.pop();
      const before = await serializeDocument(doc);
      expect(new TextDecoder().decode(before)).toContain('MISSED_PAGE_ATTACHMENT');
      expect(() => embeddedFileSecurityEngine.listAttachments(doc)).not.toThrow();
      expect(() => method === 'removeAttachment'
        ? embeddedFileSecurityEngine.removeAttachment(doc, 'missing.txt')
        : embeddedFileSecurityEngine.removeAllAttachments(doc)).toThrow(/page tree/i);
      expect(await serializeDocument(doc)).toEqual(before);
      expect(doc.requiresFullRewrite).toBeUndefined();
    },
  );

  it('removes associated files, indirect name-tree entries and direct file annotations from a full save', async () => {
    const { doc } = await fixture();
    const result = await sanitizationEngine.sanitize(doc, { metadata: false, javascript: false, comments: false, hiddenLayers: false, alternativeImages: false });
    expect(result.detail.attachmentsRemoved).toBeGreaterThan(0);
    const bytes = await serializeDocument(doc);
    expect(new TextDecoder().decode(bytes)).not.toContain('ASSOCIATED_FILE_PRIVATE_PAYLOAD');
    const reopened = await parsePDF(bytes);
    expect(reopened.catalog.has('AF')).toBe(false);
    expect(reopened.pages[0].dict.has('AF')).toBe(false);
    expect(reopened.pages[0].dict.getArray('Annots')?.length ?? 0).toBe(0);
    expect(embeddedFileSecurityEngine.listAttachments(reopened)).toHaveLength(0);
    expect(() => appendIncrementalUpdate(doc, new Set())).toThrow(/full rewrite/i);
  });

  it('refuses shared embedded data before any other sanitization changes', async () => {
    const { doc, streamRef } = await fixture();
    doc.catalog.set('Retain', streamRef);
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc)).rejects.toThrow(/shared/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it.each([true, false])('stages the complete sanitization before shared metadata can leave a dangling reference (attachments: %s)', async embeddedFiles => {
    const { doc } = await fixture();
    const metadataRef = new PDFRef(910, 0);
    const bytes = new TextEncoder().encode('<metadata/>');
    doc.objects.set(metadataRef.toKey(), new PDFStream(new PDFDict(), bytes, bytes));
    doc.catalog.set('Metadata', metadataRef);
    doc.catalog.set('RetainedMetadata', metadataRef);
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, { embeddedFiles })).rejects.toThrow(/shared metadata/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.catalog.has('Metadata')).toBe(true);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('refuses a shared file specification before removing its EF dictionary', async () => {
    const { doc } = await fixture();
    doc.catalog.set('RetainedSpec', new PDFRef(901, 0));
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc)).rejects.toThrow(/specification is shared/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect((doc.objects.get('901_0') as PDFDict).has('EF')).toBe(true);
  });

  it('refuses a shared embedded-file name tree instead of leaving an alias behind', async () => {
    const { doc } = await fixture();
    const names = doc.catalog.getDict('Names')!;
    doc.catalog.set('RetainedTree', names.get('EmbeddedFiles')!);
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc)).rejects.toThrow(/directory is shared/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('refuses an unresolved live reference before changing any attachment or metadata', async () => {
    const { doc } = await fixture();
    doc.catalog.set('Broken', new PDFRef(9999, 0));
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc)).rejects.toThrow(/unresolved document reference/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
    const inspection = await securityInspector.inspectFull(doc);
    expect(inspection.embeddedFiles.complete).toBe(false);
    expect(inspection.recommendations.join(' ')).toMatch(/attachment inspection is incomplete/i);
  });

  it.each(['name tree', 'associated files'] as const)('rejects malformed %s before mutation', async kind => {
    const { doc } = await fixture();
    if (kind === 'name tree') doc.objects.set('902_0', new PDFArray([new PDFString('unpaired')]));
    else doc.catalog.set('AF', new PDFString('not-an-array'));
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc)).rejects.toThrow(/cannot safely inspect/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
    expect((await securityInspector.inspectFull(doc)).embeddedFiles.complete).toBe(false);
  });

  it('removes platform-specific file streams even when optional file specification labels are absent', async () => {
    const { doc } = await fixture();
    const spec = doc.objects.get('901_0') as PDFDict;
    spec.delete('Type');
    spec.delete('F');
    const ef = spec.getDict('EF')!;
    const ref = ef.get('F')!;
    ef.delete('F');
    ef.set('DOS', ref);
    await sanitizationEngine.sanitize(doc, { metadata: false, javascript: false, comments: false, hiddenLayers: false, alternativeImages: false });
    expect(new TextDecoder().decode(await serializeDocument(doc))).not.toContain('ASSOCIATED_FILE_PRIVATE_PAYLOAD');
  });

  it('marks direct attachment removal as requiring full rewrite', async () => {
    const { doc } = await fixture();
    expect(embeddedFileSecurityEngine.removeAllAttachments(doc)).toBeGreaterThan(0);
    expect(() => saveIncremental(doc, new Set())).toThrow(/full rewrite/i);
  });

  it('refuses individual removal when the file stream is also used elsewhere', async () => {
    const { doc, streamRef } = await fixture();
    doc.catalog.delete('AF');
    doc.pages[0].dict.delete('AF');
    doc.pages[0].dict.delete('Annots');
    const tree = doc.catalog.getDict('Names')!.getDict('EmbeddedFiles')!;
    tree.set('Names', doc.objects.get('902_0')!);
    doc.catalog.set('Retain', streamRef);
    const before = await serializeDocument(doc);
    expect(() => embeddedFileSecurityEngine.removeAttachment(doc, 'private.txt')).toThrow(/shared/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('checks every EF stream when removing a named file', async () => {
    const { doc } = await fixture();
    doc.catalog.delete('AF');
    doc.pages[0].dict.delete('AF');
    doc.pages[0].dict.delete('Annots');
    const extra = new TextEncoder().encode('RETAINED_ALTERNATE_FILE_BYTES');
    const ref = new PDFRef(910, 0);
    doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(extra.length)]]), extra, extra));
    (doc.objects.get('901_0') as PDFDict).getDict('EF')!.set('UF', ref);
    doc.catalog.set('Retain', ref);
    const before = await serializeDocument(doc);
    expect(() => embeddedFileSecurityEngine.removeAttachment(doc, 'private.txt')).toThrow(/shared/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(new TextDecoder().decode(await serializeDocument(doc))).toContain('RETAINED_ALTERNATE_FILE_BYTES');
  });

  it('uses the name-tree key as well as the file name when checking retained data', async () => {
    const { doc, streamRef } = await fixture();
    doc.catalog.delete('AF');
    doc.pages[0].dict.delete('AF');
    doc.pages[0].dict.delete('Annots');
    (doc.objects.get('901_0') as PDFDict).set('F', new PDFString('actual.txt'));
    doc.catalog.set('Retain', streamRef);
    const before = await serializeDocument(doc);
    expect(() => embeddedFileSecurityEngine.removeAttachment(doc, 'private.txt')).toThrow(/shared/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('forces full rewrite after an unshared individual attachment is removed', async () => {
    const { doc } = await fixture();
    doc.catalog.delete('AF');
    doc.pages[0].dict.delete('AF');
    doc.pages[0].dict.delete('Annots');
    doc.catalog.getDict('Names')!.getDict('EmbeddedFiles')!.set('Names', doc.objects.get('902_0')!);
    expect(embeddedFileSecurityEngine.removeAttachment(doc, 'private.txt')).toBe(true);
    expect(() => saveIncremental(doc, new Set())).toThrow(/full rewrite/i);
    expect(new TextDecoder().decode(await serializeDocument(doc))).not.toContain('ASSOCIATED_FILE_PRIVATE_PAYLOAD');
  });

  it('lists an associated file even without a name tree or annotation', async () => {
    const { doc } = await fixture();
    doc.catalog.delete('Names');
    doc.pages[0].dict.delete('Annots');
    const attachments = embeddedFileSecurityEngine.listAttachments(doc);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ name: 'private.txt', source: 'EF' });
  });

  it('removes an individually selected associated file and keeps other associations', async () => {
    const { doc } = await fixture();
    doc.catalog.delete('Names');
    doc.pages[0].dict.delete('Annots');
    const otherBytes = new TextEncoder().encode('OTHER_ASSOCIATED_FILE');
    const otherStream = new PDFRef(910, 0), otherSpec = new PDFRef(911, 0);
    doc.objects.set(otherStream.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(otherBytes.length)]]), otherBytes, otherBytes));
    doc.objects.set(otherSpec.toKey(), new PDFDict([
      ['F', new PDFString('other.txt')], ['EF', new PDFDict([['F', otherStream]])],
    ]));
    doc.catalog.set('AF', new PDFArray([new PDFRef(901, 0), otherSpec]));
    expect(embeddedFileSecurityEngine.removeAttachment(doc, 'private.txt')).toBe(true);
    expect(() => saveIncremental(doc, new Set())).toThrow(/full rewrite/i);
    const bytes = await saveQuick(doc);
    expect(new TextDecoder().decode(bytes)).not.toContain('ASSOCIATED_FILE_PRIVATE_PAYLOAD');
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    const reopened = await parsePDF(bytes);
    expect(embeddedFileSecurityEngine.listAttachments(reopened).map(item => item.name)).toEqual(['other.txt']);
    expect(new TextDecoder().decode(embeddedFileSecurityEngine.getAttachmentBytes(reopened, 'other.txt')!)).toBe('OTHER_ASSOCIATED_FILE');
  });

  it('removes all aliases and associations of the selected file specification', async () => {
    const { doc } = await fixture();
    const spec = doc.objects.get('901_0') as PDFDict;
    spec.set('UF', new PDFString('unicode.txt'));
    expect(embeddedFileSecurityEngine.removeAttachment(doc, 'private.txt')).toBe(true);
    const bytes = await saveQuick(doc);
    expect(new TextDecoder().decode(bytes)).not.toContain('ASSOCIATED_FILE_PRIVATE_PAYLOAD');
    expect(embeddedFileSecurityEngine.listAttachments(await parsePDF(bytes))).toHaveLength(0);
  });

  it.each(['same filename', 'name-tree alias'] as const)(
    'refuses ambiguous attachment selections matching separate file specifications: %s', async mode => {
      const { doc } = await fixture();
      const bytes = new TextEncoder().encode('SECOND_PRIVATE_FILE');
      const streamRef = new PDFRef(910, 0), specRef = new PDFRef(911, 0);
      doc.objects.set(streamRef.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(bytes.length)]]), bytes, bytes));
      doc.objects.set(specRef.toKey(), new PDFDict([
        ['F', new PDFString(mode === 'same filename' ? 'private.txt' : 'different.txt')],
        ['EF', new PDFDict([['F', streamRef]])],
      ]));
      if (mode === 'same filename') doc.catalog.set('AF', new PDFArray([new PDFRef(901, 0), specRef]));
      else doc.catalog.getDict('Names')!.getDict('EmbeddedFiles')!.set('Kids', new PDFArray([
        new PDFDict([['Names', new PDFArray([new PDFString('private.txt'), specRef])]]),
      ]));
      const before = await serializeDocument(doc);
      expect(() => embeddedFileSecurityEngine.removeAttachment(doc, 'private.txt')).toThrow(/ambiguous/i);
      expect(await serializeDocument(doc)).toEqual(before);
      expect(doc.requiresFullRewrite).toBeUndefined();
    },
  );

  it.each(['individual', 'all'] as const)('refuses %s attachment removal on a signed document before mutation', async method => {
    const { doc } = await fixture();
    doc.catalog.set('Signature', new PDFDict([
      ['Type', new PDFName('Sig')], ['ByteRange', new PDFArray([0, 10, 20, 10].map(n => new PDFNumber(n)))],
      ['Contents', new PDFHexString('aabb')],
    ]));
    const before = await serializeDocument(doc);
    expect(() => method === 'individual' ? embeddedFileSecurityEngine.removeAttachment(doc, 'private.txt') :
      embeddedFileSecurityEngine.removeAllAttachments(doc)).toThrow(/signed/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('preserves a real signed attachment document on both removal paths', async () => {
    const { doc } = await fixture();
    const field = createSignatureField(doc, 0, { x: 20, y: 20, width: 100, height: 40 }, 'Signer');
    await installSignatureBase(doc, await serializeDocument(doc));
    const credentials = getTestCredentials();
    const bundle = await importFromPem(credentials.pem, 'test');
    const signed = await signDocumentCryptographic(doc, field, bundle.key!.privateKey, {
      certificateDer: bundle.leaf!.der, hashAlgorithm: 'sha256', contentsSize: 4096, enableTimestamp: false,
    });
    const original = new Uint8Array(signed.bytes);
    const reopened = await parsePDF(original);
    for (const remove of [() => embeddedFileSecurityEngine.removeAttachment(reopened, 'private.txt'),
      () => embeddedFileSecurityEngine.removeAllAttachments(reopened)]) {
      expect(remove).toThrow(/signed/i);
      expect(reopened.requiresFullRewrite).toBeUndefined();
      expect(await saveQuick(reopened)).toEqual(original);
    }
    const report = await validateDocumentSignatures(reopened, { allowSelfSigned: true });
    expect(report.signatures.some(item => item.digestMatch && item.cmsSignatureOk === true)).toBe(true);
  }, 30000);

  it('refuses a retained file specification or malformed name-tree branch without mutation', async () => {
    for (const mode of ['retained spec', 'malformed branch'] as const) {
      const { doc } = await fixture();
      if (mode === 'retained spec') doc.catalog.set('Retained', new PDFRef(901, 0));
      else doc.catalog.getDict('Names')!.getDict('EmbeddedFiles')!.set('Kids', new PDFArray([new PDFNumber(1)]));
      const before = await serializeDocument(doc);
      expect(() => embeddedFileSecurityEngine.removeAttachment(doc, 'private.txt')).toThrow(/shared|cannot safely inspect/i);
      expect(await serializeDocument(doc)).toEqual(before);
      expect(doc.requiresFullRewrite).toBeUndefined();
    }
  });

  it.each(['name array', 'name tree', 'annotation array'] as const)(
    'refuses shared %s before modifying retained content', async kind => {
      const { doc } = await fixture();
      doc.catalog.delete('AF');
      doc.pages[0].dict.delete('AF');
      const tree = doc.catalog.getDict('Names')!.getDict('EmbeddedFiles')!;
      if (kind === 'name array') doc.catalog.set('Retained', tree.get('Names')!);
      if (kind === 'name tree') doc.catalog.set('Retained', tree);
      if (kind === 'annotation array') doc.catalog.set('Retained', doc.pages[0].dict.get('Annots')!);
      const before = await serializeDocument(doc);
      expect(() => embeddedFileSecurityEngine.removeAttachment(doc, 'private.txt')).toThrow(/shared/i);
      expect(await serializeDocument(doc)).toEqual(before);
      expect(doc.requiresFullRewrite).toBeUndefined();
    },
  );

  it.each(['individual', 'all'] as const)(
    'refuses %s removal of a file specification with unsupported related files before mutation', async mode => {
      const { doc } = await fixture();
      const bytes = new TextEncoder().encode('RETAINED_RELATED_FILE');
      const streamRef = new PDFRef(910, 0);
      doc.objects.set(streamRef.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(bytes.length)]]), bytes, bytes));
      (doc.objects.get('901_0') as PDFDict).set('RF', new PDFDict([
        ['F', new PDFArray([new PDFString('related.txt'), streamRef])],
      ]));
      doc.catalog.set('RetainedRelated', streamRef);
      const before = await serializeDocument(doc);
      expect(() => mode === 'individual' ? embeddedFileSecurityEngine.removeAttachment(doc, 'private.txt') :
        embeddedFileSecurityEngine.removeAllAttachments(doc)).toThrow(/related/i);
      expect(await serializeDocument(doc)).toEqual(before);
      expect(doc.requiresFullRewrite).toBeUndefined();
    },
  );

  it('keeps other name-tree branches when individually removing an attachment', async () => {
    const { doc } = await fixture();
    doc.catalog.delete('AF');
    doc.pages[0].dict.delete('AF');
    doc.pages[0].dict.delete('Annots');
    const bytes = new TextEncoder().encode('OTHER_ATTACHMENT_CONTENT');
    const otherStream = new PDFRef(910, 0);
    const otherSpec = new PDFRef(911, 0);
    doc.objects.set(otherStream.toKey(), new PDFStream(new PDFDict([
      ['Type', new PDFName('EmbeddedFile')], ['Length', new PDFNumber(bytes.length)],
    ]), bytes, bytes));
    doc.objects.set(otherSpec.toKey(), new PDFDict([
      ['Type', new PDFName('Filespec')], ['F', new PDFString('other.txt')],
      ['EF', new PDFDict([['F', otherStream]])],
    ]));
    const tree = doc.catalog.getDict('Names')!.getDict('EmbeddedFiles')!;
    tree.set('Kids', new PDFArray([new PDFDict([
      ['Names', new PDFArray([new PDFString('other.txt'), otherSpec])],
    ])]));
    expect(embeddedFileSecurityEngine.removeAttachment(doc, 'private.txt')).toBe(true);
    const reopened = await parsePDF(await serializeDocument(doc));
    expect(embeddedFileSecurityEngine.listAttachments(reopened).map(item => item.name)).toEqual(['other.txt']);
    expect(new TextDecoder().decode(embeddedFileSecurityEngine.getAttachmentBytes(reopened, 'other.txt')!))
      .toBe('OTHER_ATTACHMENT_CONTENT');
  });
});
