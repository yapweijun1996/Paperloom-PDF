import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { deflateSync, inflateSync } from 'node:zlib';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePDF, getPageContentBytes } from '../parser/parser';
import { updatePageContent } from '../editor/stream-compiler';
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNull, PDFNumber, PDFRef, PDFStream, PDFString } from '../types';
import { serializeDocument, serializeDocumentCompact } from '../writer/serializer';
import { appendIncrementalUpdate } from '../writer/incremental-writer';
import { saveQuick } from '../writer/save-pipeline';
import { saveQuick as saveQuickWorker } from '../worker/client';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { prepareWholePageRedaction, WholePageRedactionUnsupportedError } from '../security/redaction/whole-page-redaction';
import { dehydrateDocument, sameDocumentSnapshot } from '../worker/codec';

async function fixture(): Promise<Awaited<ReturnType<typeof parsePDF>>> {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Preserve document title');
  pdf.addPage([200, 200]);
  pdf.addPage([200, 200]).drawText('Preserved second page');
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  // Independent resource graph ensures the second page is not changed.
  doc.pages[0].resources = new PDFDict();
  doc.pages[0].dict.set('Resources', doc.pages[0].resources);
  await updatePageContent(doc.pages[0].contentRefs, new TextEncoder().encode('BT (SECRET_IN_PAGE_STREAM) Tj ET\n0 0 10 10 re f'), doc.objects, false);
  // The conservative secure-redaction path accepts independently inspectable
  // surviving streams; preserve the second page's decoded content verbatim.
  const retainedContent = getPageContentBytes(doc.pages[1], doc.objects).slice();
  await updatePageContent(doc.pages[1].contentRefs, retainedContent, doc.objects, false);
  return parsePDF(await serializeDocument(doc));
}

function mark(doc: Awaited<ReturnType<typeof parsePDF>>, page = 0): PDFRef {
  return redactionEngine.markRegion(doc, page, { x: 0, y: 0, width: 200, height: 200 });
}

describe('whole-page secure redaction', () => {
  it('refuses a marked page whose cached content points to another page', async () => {
    const doc = await fixture();
    await updatePageContent(doc.pages[1].contentRefs,
      new TextEncoder().encode('BT (PRIVATE_STALE_MARKER) Tj ET\n'), doc.objects, false);
    doc.pages[0].contentRefs.splice(0, doc.pages[0].contentRefs.length, ...doc.pages[1].contentRefs);
    expect(new TextDecoder().decode(getPageContentBytes(doc.pages[0], doc.objects))).toContain('PRIVATE_STALE_MARKER');
    mark(doc);
    const before = dehydrateDocument(doc);
    expect(() => prepareWholePageRedaction(doc)).toThrow(/cached page content/i);
    await expect(redactionEngine.applySecureRedactions(doc)).rejects.toThrow();
    expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it.each(['omitted', 'reordered', 'extra'] as const)('refuses %s cached content references without mutation', async mode => {
    const doc = await fixture(), page = doc.pages[0], first = page.contentRefs[0];
    const second = new PDFRef(980, 0), bytes = new TextEncoder().encode('0 0 2 2 re f\n');
    doc.objects.set(second.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(bytes.length)]]), bytes));
    page.dict.set('Contents', new PDFArray([first, second]));
    page.contentRefs = mode === 'omitted' ? [first] : mode === 'reordered' ? [second, first] : [first, second, second];
    mark(doc);
    const before = dehydrateDocument(doc);
    expect(() => prepareWholePageRedaction(doc)).toThrow(/cached page content/i);
    expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('accepts an indirect content array and a canonicalized stream reference alias', async () => {
    const doc = await fixture(), page = doc.pages[0], contentRef = page.contentRefs[0];
    const aliasRef = new PDFRef(980, 0), arrayRef = new PDFRef(981, 0);
    doc.objects.set(aliasRef.toKey(), contentRef);
    doc.objects.set(arrayRef.toKey(), new PDFArray([aliasRef]));
    page.dict.set('Contents', arrayRef);
    page.contentRefs = [new PDFRef(contentRef.objNum, contentRef.genNum)];
    mark(doc);
    expect(prepareWholePageRedaction(doc).commit()).toMatchObject({ pagesCleared: 1 });
    const output = await saveQuick(doc);
    const reopened = await parsePDF(output);
    expect(getPageContentBytes(reopened.pages[0], reopened.objects)).toHaveLength(0);
    expect(new TextDecoder().decode(output)).not.toContain('SECRET_IN_PAGE_STREAM');
  });

  it.each(['missing', 'null', 'empty', 'indirect-empty'] as const)('accepts a genuinely empty %s page', async mode => {
    const doc = await fixture(), page = doc.pages[0];
    page.contentRefs = [];
    if (mode === 'missing') page.dict.delete('Contents');
    else if (mode === 'null') page.dict.set('Contents', PDFNull.instance);
    else if (mode === 'empty') page.dict.set('Contents', new PDFArray());
    else {
      const ref = new PDFRef(980, 0);
      doc.objects.set(ref.toKey(), new PDFArray());
      page.dict.set('Contents', ref);
    }
    mark(doc);
    expect(prepareWholePageRedaction(doc).commit()).toMatchObject({ pagesCleared: 1 });
    const reopened = await parsePDF(await saveQuick(doc));
    expect(getPageContentBytes(reopened.pages[0], reopened.objects)).toHaveLength(0);
  });

  it.each(['missing', 'cycle', 'direct-stream', 'invalid-array'] as const)('refuses %s content references before mutation', async mode => {
    const doc = await fixture(), page = doc.pages[0], ref = new PDFRef(980, 0);
    if (mode === 'missing') page.dict.set('Contents', ref);
    else if (mode === 'cycle') { doc.objects.set(ref.toKey(), ref); page.dict.set('Contents', ref); }
    else if (mode === 'direct-stream') page.dict.set('Contents', new PDFStream(new PDFDict(), new Uint8Array()));
    else page.dict.set('Contents', new PDFArray([new PDFString('not a stream')]));
    mark(doc);
    const before = dehydrateDocument(doc);
    expect(() => prepareWholePageRedaction(doc)).toThrow(/page content/i);
    expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it.skipIf(spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status !== 0)(
    'removes real text covered jointly by marks as checked by Poppler', async () => {
      const pdf = await PDFDocument.create();
      pdf.addPage([200, 200]).drawText('PRIVATE UNION TEXT', { x: 20, y: 100, size: 12 });
      pdf.addPage([200, 200]);
      const original = await pdf.save({ useObjectStreams: false });
      const dir = mkdtempSync(join(tmpdir(), 'paperloom-whole-union-'));
      try {
        const input = join(dir, 'input.pdf');
        const output = join(dir, 'output.pdf');
        writeFileSync(input, original);
        expect(execFileSync('pdftotext', [input, '-'], { encoding: 'utf8' })).toContain('PRIVATE UNION TEXT');
        const doc = await parsePDF(original);
        redactionEngine.markRegion(doc, 0, { x: 0, y: 0, width: 100, height: 200 });
        redactionEngine.markRegion(doc, 0, { x: 100, y: 0, width: 100, height: 200 });
        await redactionEngine.applySecureRedactions(doc);
        writeFileSync(output, await saveQuick(doc));
        expect(execFileSync('pdftotext', [output, '-'], { encoding: 'utf8' })).not.toContain('PRIVATE UNION TEXT');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
  it.each([
    [{ x: 0, y: 0, width: 100, height: 200 }, { x: 100, y: 0, width: 100, height: 200 }],
    [{ x: 0, y: 0, width: 100, height: 100 }, { x: 100, y: 0, width: 100, height: 100 },
      { x: 0, y: 100, width: 100, height: 100 }, { x: 100, y: 100, width: 100, height: 100 }],
    [{ x: -1, y: 0, width: 102, height: 200 }, { x: 99, y: 0, width: 102, height: 200 }],
  ].map(areas => ({ areas })))('clears and rewrites a whole page jointly covered by marks %#', async ({ areas }) => {
    const doc = await fixture();
    const second = getPageContentBytes(doc.pages[1], doc.objects).slice();
    for (const area of areas) redactionEngine.markRegion(doc, 0, area);
    const result = await redactionEngine.applySecureRedactions(doc);
    expect(result).toMatchObject({ pagesCleared: 1, annotationsRemoved: areas.length });
    const output = await saveQuick(doc);
    expect(new TextDecoder().decode(output)).not.toContain('SECRET_IN_PAGE_STREAM');
    const reopened = await parsePDF(output);
    expect(getPageContentBytes(reopened.pages[0], reopened.objects)).toHaveLength(0);
    expect(getPageContentBytes(reopened.pages[1], reopened.objects)).toEqual(second);
    const independent = await PDFDocument.load(output);
    expect(independent.getPageCount()).toBe(2);
    expect(independent.getPage(0).node.Contents()).toBeUndefined();
  });

  it.each([
    [{ x: 0, y: 0, width: 99.999, height: 200 }, { x: 100, y: 0, width: 100, height: 200 }],
    [{ x: 0, y: 0, width: 200, height: 99.999 }, { x: 0, y: 100, width: 200, height: 100 }],
    [{ x: 0, y: 0, width: 100, height: 100 }, { x: 100, y: 0, width: 100, height: 100 },
      { x: 0, y: 100, width: 100, height: 100 }],
  ].map(areas => ({ areas })))('rejects an uncovered gap without modifying the document %#', async ({ areas }) => {
    const doc = await fixture();
    for (const area of areas) redactionEngine.markRegion(doc, 0, area);
    const before = await serializeDocument(doc);
    expect(() => prepareWholePageRedaction(doc)).toThrow(/complete page/);
    await expect(redactionEngine.applySecureRedactions(doc)).rejects.toThrow();
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('does not infer page coverage from quadrilaterals outside their annotation rectangles', async () => {
    const doc = await fixture();
    const first = redactionEngine.markRegion(doc, 0, { x: 0, y: 0, width: 100, height: 200 });
    redactionEngine.markRegion(doc, 0, { x: 100, y: 0, width: 100, height: 200 });
    const dict = doc.objects.get(first.toKey()) as PDFDict;
    dict.set('QuadPoints', new PDFArray([300, 200, 400, 200, 300, 0, 400, 0].map(x => new PDFNumber(x))));
    const before = await serializeDocument(doc);
    expect(() => prepareWholePageRedaction(doc)).toThrow(/complete page/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it.each(['duplicate', 'excessive'] as const)('rejects %s redaction marks before mutation', async kind => {
    const doc = await fixture();
    const ref = mark(doc);
    if (kind === 'duplicate') doc.pages[0].dict.getArray('Annots')!.push(ref);
    else for (let i = 0; i < 64; i++) mark(doc);
    const before = await serializeDocument(doc);
    expect(() => prepareWholePageRedaction(doc)).toThrow(/duplicated or exceed/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('rejects a compressed retained copy through the public API without changing the document', async () => {
    const doc = await fixture();
    const source = doc.objects.get(doc.pages[0].contentRefs[0].toKey()) as PDFStream;
    const compressed = deflateSync(source.rawBytes);
    const ref = new PDFRef(990, 0);
    doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([
      ['Length', new PDFNumber(compressed.length)], ['Filter', new PDFName('FlateDecode')],
    ]), compressed, null));
    doc.catalog.set('RetainedDuplicate', ref);
    mark(doc);
    const before = await serializeDocument(doc);
    expect(inflateSync(compressed)).toEqual(Buffer.from(source.rawBytes));
    expect(() => prepareWholePageRedaction(doc)).toThrow(/retained encoded streams/);
    await expect(redactionEngine.applySecureRedactions(doc)).rejects.toThrow();
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('rejects even an unrelated compressed survivor when its saved data cannot be verified', async () => {
    const doc = await fixture();
    const compressed = deflateSync(Buffer.from('unrelated retained data'));
    const ref = new PDFRef(990, 0);
    doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([
      ['Length', new PDFNumber(compressed.length)], ['Filter', new PDFName('FlateDecode')],
    ]), compressed, null));
    doc.catalog.set('UninspectedData', ref);
    mark(doc);
    const before = await serializeDocument(doc);
    await expect(redactionEngine.applySecureRedactions(doc)).rejects.toThrow();
    expect(await serializeDocument(doc)).toEqual(before);
  });
  it('clears the marked page, preserves other pages and metadata, and never exports the old revision', async () => {
    const doc = await fixture();
    const second = getPageContentBytes(doc.pages[1], doc.objects).slice();
    const original = doc.rawBytes.slice();
    doc.catalog.set('OpenAction', new PDFDict([['S', new PDFName('URI')], ['URI', new PDFString('https://example.test')]]));
    const reference = mark(doc);
    const prepared = prepareWholePageRedaction(doc);
    expect(getPageContentBytes(doc.pages[0], doc.objects).length).toBeGreaterThan(0);
    const result = prepared.commit();
    expect(result).toMatchObject({ pagesProcessed: 1, pagesCleared: 1, annotationsRemoved: 1 });
    expect(doc.rawBytes).toEqual(original);
    expect(doc.requiresFullRewrite).toBe(true);
    expect(doc.pages[0].dict.has('Annots')).toBe(false);
    expect(doc.objects.has(reference.toKey())).toBe(false);
    expect(() => appendIncrementalUpdate(doc, new Set())).toThrow(/full rewrite/i);
    await expect(async () => prepared.commit()).rejects.toThrow(/already committed/i);
    for (const save of [saveQuick, serializeDocumentCompact, saveQuickWorker]) {
      const bytes = await save(doc);
      expect(new TextDecoder().decode(bytes)).not.toContain('SECRET_IN_PAGE_STREAM');
      const reopened = await parsePDF(bytes);
      expect(getPageContentBytes(reopened.pages[0], reopened.objects).length).toBe(0);
      expect(getPageContentBytes(reopened.pages[1], reopened.objects)).toEqual(second);
      expect(reopened.info.title).toBe(doc.info.title);
      expect(reopened.catalog.getDict('OpenAction')?.getString('URI')).toBe('https://example.test');
      expect(reopened.pages[0].dict.has('Annots')).toBe(false);
    }
  });

  it('refuses partial marks and does not change any page when another marked page is unsupported', async () => {
    const doc = await fixture();
    mark(doc);
    redactionEngine.markRegion(doc, 1, { x: 20, y: 20, width: 30, height: 30 });
    const before = await serializeDocument(doc);
    expect(() => prepareWholePageRedaction(doc)).toThrow(WholePageRedactionUnsupportedError);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('refuses shared sensitive resources and preserves them', async () => {
    const doc = await fixture();
    const image = new PDFRef(900, 0);
    doc.objects.set(image.toKey(), new PDFStream(new PDFDict(), new Uint8Array([1, 2, 3]), null));
    const resources = new PDFDict([['XObject', new PDFDict([['Shared', image]])]]);
    doc.pages[0].dict.set('Resources', resources);
    doc.pages[0].resources = resources;
    doc.pages[1].resources.set('XObject', new PDFDict([['Shared', image]]));
    mark(doc);
    const before = await serializeDocument(doc);
    expect(() => prepareWholePageRedaction(doc)).toThrow(/shared/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('removes page-local image data as well as painted vector instructions', async () => {
    const doc = await fixture();
    const imageRef = new PDFRef(900, 0);
    const image = new TextEncoder().encode('PRIVATE_IMAGE_SAMPLE');
    doc.objects.set(imageRef.toKey(), new PDFStream(new PDFDict([
      ['Subtype', new PDFName('Image')], ['Length', new PDFNumber(image.length)],
    ]), image, image));
    doc.pages[0].resources.set('XObject', new PDFDict([['Im0', imageRef]]));
    await updatePageContent(doc.pages[0].contentRefs, new TextEncoder().encode('q /Im0 Do Q 0 0 20 20 re f'), doc.objects, false);
    const originalContent = doc.pages[0].contentRefs[0].toKey();
    mark(doc);
    prepareWholePageRedaction(doc).commit();
    expect(doc.objects.has(imageRef.toKey())).toBe(false);
    expect(doc.objects.has(originalContent)).toBe(false);
    const output = await saveQuick(doc);
    expect(new TextDecoder().decode(output)).not.toContain('PRIVATE_IMAGE_SAMPLE');
    const reopened = await parsePDF(output);
    expect(getPageContentBytes(reopened.pages[0], reopened.objects).length).toBe(0);
    expect(reopened.objects.has(imageRef.toKey())).toBe(false);
  });

  it('rechecks the document at commit and rejects unsafe changes before mutating any page', async () => {
    const doc = await fixture();
    mark(doc);
    const prepared = prepareWholePageRedaction(doc);
    doc.pages[0].dict.set('Metadata', new PDFString('do not drop'));
    const before = await serializeDocument(doc);
    expect(() => prepared.commit()).toThrow(/changed after/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('refuses unsupported protected, signed, tagged and interactive documents', async () => {
    for (const kind of ['protected', 'signed', 'tagged', 'interactive'] as const) {
      const doc = await fixture();
      mark(doc);
      if (kind === 'protected') doc.xref.trailerDict.set('Encrypt', new PDFDict());
      if (kind === 'signed') doc.rawBytes = new TextEncoder().encode('%PDF-1.7\n/ByteRange [0 10 20 10] /Contents <01020304>');
      if (kind === 'tagged') doc.catalog.set('StructTreeRoot', new PDFDict());
      if (kind === 'interactive') doc.catalog.set('AcroForm', new PDFDict());
      const before = getPageContentBytes(doc.pages[0], doc.objects).slice();
      expect(() => prepareWholePageRedaction(doc)).toThrow(WholePageRedactionUnsupportedError);
      expect(getPageContentBytes(doc.pages[0], doc.objects)).toEqual(before);
      expect(doc.requiresFullRewrite).toBeUndefined();
    }
  });

  it('rejects malformed geometry, other annotations and options that would retain page content', async () => {
    const doc = await fixture();
    const ref = mark(doc);
    const dict = doc.objects.get(ref.toKey()) as PDFDict;
    dict.set('QuadPoints', new PDFArray([0, 0, 200, 0, 100, 200, 0, 200].map(x => new PDFNumber(x))));
    expect(() => prepareWholePageRedaction(doc)).toThrow(/complete page/);
    dict.delete('QuadPoints');
    expect(() => prepareWholePageRedaction(doc, { images: false })).toThrow(/options/);
    const annots = doc.pages[0].dict.getArray('Annots')!;
    annots.push(new PDFDict([['Subtype', new PDFName('Text')]]));
    expect(() => prepareWholePageRedaction(doc)).toThrow(/other annotations/);
  });

  it('rejects stale cached geometry when the inherited MediaBox changes', async () => {
    const doc = await fixture();
    const page = doc.pages[0];
    const parent = doc.objects.get(page.dict.getRef('Parent')!.toKey()) as PDFDict;
    page.dict.delete('MediaBox');
    parent.set('MediaBox', new PDFArray([0, 0, 300, 300].map(value => new PDFNumber(value))));
    mark(doc);
    const before = await serializeDocument(doc);
    expect(() => prepareWholePageRedaction(doc)).toThrow(/geometry differs/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('refuses inherited resources that remain reachable through the ancestor', async () => {
    const doc = await fixture();
    const page = doc.pages[0];
    const parent = doc.objects.get(page.dict.getRef('Parent')!.toKey()) as PDFDict;
    const shared = new PDFDict([['Marker', new PDFString('INHERITED_SECRET')]]);
    parent.set('Resources', shared);
    page.dict.delete('Resources');
    page.resources = shared;
    mark(doc);
    const before = await serializeDocument(doc);
    expect(() => prepareWholePageRedaction(doc)).toThrow(/shared/);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(parent.get('Resources')).toBe(shared);
  });

  it.each(['AA', 'Group', 'Trans', 'Dur', 'Tabs', 'UserUnit', 'CropBox', 'Rotate'] as const)(
    'rejects data-bearing or malformed page feature %s before mutation', async key => {
      const doc = await fixture();
      doc.pages[0].dict.set(key, new PDFString('PAGE_SECRET'));
      mark(doc);
      const before = await serializeDocument(doc);
      expect(() => prepareWholePageRedaction(doc)).toThrow(WholePageRedactionUnsupportedError);
      expect(await serializeDocument(doc)).toEqual(before);
    },
  );

  it.each(['content', 'resources'] as const)(
    'rejects sensitive objects still used by an unmarked page %s cache', async key => {
      const doc = await fixture();
      if (key === 'content') doc.pages[1].contentRefs = [doc.pages[0].contentRefs[0]];
      else doc.pages[1].resources = doc.pages[0].resources;
      mark(doc);
      const before = await serializeDocument(doc);
      expect(() => prepareWholePageRedaction(doc)).toThrow(/shared/);
      expect(await serializeDocument(doc)).toEqual(before);
    },
  );

  it('rejects a redaction annotation whose P reference points to secret data', async () => {
    const doc = await fixture();
    const secret = new PDFRef(990, 0);
    doc.objects.set(secret.toKey(), new PDFString('SECRET_ON_INVALID_PAGE_REFERENCE'));
    const ref = mark(doc);
    (doc.objects.get(ref.toKey()) as PDFDict).set('P', secret);
    const before = await serializeDocument(doc);
    expect(() => prepareWholePageRedaction(doc)).toThrow(/different page/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('rejects a distinct surviving stream with the same image bytes', async () => {
    const doc = await fixture();
    const image = new PDFRef(900, 0), duplicate = new PDFRef(901, 0);
    const bytes = new TextEncoder().encode('DUPLICATED_SENSITIVE_IMAGE');
    doc.objects.set(image.toKey(), new PDFStream(new PDFDict(), bytes, bytes));
    doc.objects.set(duplicate.toKey(), new PDFStream(new PDFDict(), bytes.slice(), bytes.slice()));
    doc.pages[0].resources.set('XObject', new PDFDict([['Image', image]]));
    doc.catalog.set('RetainedDuplicate', duplicate);
    mark(doc);
    const before = await serializeDocument(doc);
    expect(() => prepareWholePageRedaction(doc)).toThrow(/duplicates removed data/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('rejects a nonempty cached resource dictionary when no resource exists in the page tree', async () => {
    const doc = await fixture();
    const page = doc.pages[0];
    const parent = doc.objects.get(page.dict.getRef('Parent')!.toKey()) as PDFDict;
    parent.delete('Resources');
    page.dict.delete('Resources');
    page.resources = new PDFDict([['Marker', new PDFString('stale')]]);
    mark(doc);
    expect(() => prepareWholePageRedaction(doc)).toThrow(/resources differ/);
  });

  it('rejects nested signature dictionaries even without raw ByteRange markers', async () => {
    const doc = await fixture();
    doc.catalog.set('Nested', new PDFArray([new PDFDict([['Type', new PDFName('Sig')]])]));
    mark(doc);
    expect(() => prepareWholePageRedaction(doc)).toThrow(/signed PDFs/);
  });
});

describe('whole-page duplicate text safeguards', () => {
  async function duplicateFixture(removed: string, retained: string) {
    const doc = await fixture();
    const font = () => new PDFDict([['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')], ['BaseFont', new PDFName('Helvetica')]]);
    for (const page of doc.pages) {
      page.resources = new PDFDict([['Font', new PDFDict([['F1', font()]])]]);
      page.dict.set('Resources', page.resources);
    }
    await updatePageContent(doc.pages[0].contentRefs, new TextEncoder().encode(`BT /F1 12 Tf 10 100 Td ${removed} ET`), doc.objects, false);
    await updatePageContent(doc.pages[1].contentRefs, new TextEncoder().encode(`BT /F1 12 Tf 10 100 Td ${retained} ET`), doc.objects, false);
    return parsePDF(await serializeDocument(doc));
  }

  it.each([
    ['(S\\105CRET_MARKER) Tj', '<5345435245545F4D41524B4552> Tj'],
    ['[(SECRET_) 20 (MARKER)] TJ', '[(SECRET_) -20 (MARKER)] TJ'],
    ['(SECRET_) Tj (MARKER) Tj', '(SECRET_MARKER) Tj'],
  ])('rejects copies across differently encoded text operators %#', async (removed, retained) => {
    const doc = await duplicateFixture(removed, retained);
    mark(doc);
    const before = await serializeDocument(doc);
    expect(() => prepareWholePageRedaction(doc)).toThrow(/contains removed text/);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('rejects a UTF-16 metadata copy without mutating the document', async () => {
    const doc = await duplicateFixture('(SECRET_MARKER) Tj', '(safe) Tj');
    const info = doc.objects.get(doc.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;
    info.set('Private', new PDFHexString('FEFF005300450043005200450054005F004D00410052004B00450052'));
    mark(doc);
    const before = await serializeDocument(doc);
    expect(() => prepareWholePageRedaction(doc)).toThrow(/contains removed text/);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('saves and reopens unrelated content', async () => {
    const doc = await duplicateFixture('(SECRET_MARKER) Tj', '(SAFE_OTHER) Tj');
    mark(doc);
    prepareWholePageRedaction(doc).commit();
    const output = await saveQuick(doc);
    expect(new TextDecoder().decode(output)).not.toContain('SECRET_MARKER');
    const reopened = await parsePDF(output);
    expect(getPageContentBytes(reopened.pages[0], reopened.objects)).toHaveLength(0);
    expect(new TextDecoder().decode(getPageContentBytes(reopened.pages[1], reopened.objects))).toContain('SAFE_OTHER');
    expect((await PDFDocument.load(output)).getPageCount()).toBe(2);
    if (spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status === 0) {
      const dir = mkdtempSync(join(tmpdir(), 'paperloom-whole-text-'));
      try {
        const path = join(dir, 'output.pdf');
        writeFileSync(path, output);
        const extracted = execFileSync('pdftotext', [path, '-'], { encoding: 'utf8' });
        expect(extracted).toContain('SAFE_OTHER');
        expect(extracted).not.toContain('SECRET_MARKER');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it('does not interpret opaque marked-page resources as text', async () => {
    const doc = await duplicateFixture('(SECRET_MARKER) Tj', '(SAFE_OTHER) Tj');
    const image = new PDFRef(990, 0);
    const bytes = new TextEncoder().encode('BT (SAFE_OTHER) Tj ET');
    doc.objects.set(image.toKey(), new PDFStream(new PDFDict([
      ['Subtype', new PDFName('Image')], ['Filter', new PDFName('UnknownFilter')], ['Length', new PDFNumber(bytes.length)],
    ]), bytes));
    doc.pages[0].resources.set('XObject', new PDFDict([['Im0', image]]));
    mark(doc);
    expect(prepareWholePageRedaction(doc).commit().pagesCleared).toBe(1);
    expect(doc.objects.has(image.toKey())).toBe(false);
  });

  it('refuses an uninspectable removed stream before mutation', async () => {
    const doc = await duplicateFixture('(SECRET_MARKER) Tj', '(SAFE_OTHER) Tj');
    const bytes = new Uint8Array([0, 1, 2, 3]);
    const ref = doc.pages[0].contentRefs[0];
    doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([
      ['Filter', new PDFName('FlateDecode')], ['Length', new PDFNumber(bytes.length)],
    ]), bytes));
    mark(doc);
    const before = await serializeDocument(doc);
    expect(() => prepareWholePageRedaction(doc)).toThrow(/cannot be inspected/i);
    await expect(redactionEngine.applySecureRedactions(doc)).rejects.toThrow();
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('rechecks duplicates when a prepared redaction is committed', async () => {
    const doc = await duplicateFixture('(SECRET_MARKER) Tj', '(SAFE_OTHER) Tj');
    mark(doc);
    const prepared = prepareWholePageRedaction(doc);
    const info = doc.objects.get(doc.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;
    info.set('Private', new PDFString('SECRET_MARKER'));
    const before = await serializeDocument(doc);
    expect(() => prepared.commit()).toThrow(/changed after/);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });
});

describe('whole-page object graph inspection', () => {
  function addIndirectChain(doc: Awaited<ReturnType<typeof parsePDF>>, count: number, cycle: boolean): void {
    const first = 20_000;
    for (let i = 0; i < count; i++) {
      const node = new PDFDict();
      if (i + 1 < count || cycle) node.set('Next', new PDFRef(first + ((i + 1) % count), 0));
      doc.objects.set(new PDFRef(first + i, 0).toKey(), node);
    }
    doc.catalog.set('Deep', new PDFRef(first, 0));
    doc.catalog.set('SharedDeep', new PDFRef(first, 0));
  }

  it('handles a long shared indirect cycle without overflowing the stack', async () => {
    const doc = await fixture();
    addIndirectChain(doc, 12_000, true);
    mark(doc);
    const result = prepareWholePageRedaction(doc).commit();
    expect(result.pagesCleared).toBe(1);
    expect(doc.catalog.getRef('Deep')?.toKey()).toBe(doc.catalog.getRef('SharedDeep')?.toKey());
    expect(doc.objects.has(new PDFRef(20_000, 0).toKey())).toBe(true);
  });

  it('refuses a graph beyond the inspection budget without changing the document', async () => {
    const doc = await fixture();
    addIndirectChain(doc, 50_100, false);
    const ref = mark(doc);
    const page = doc.pages[0];
    const content = page.dict.get('Contents');
    const annotations = page.dict.get('Annots');
    const objectCount = doc.objects.size;
    expect(() => prepareWholePageRedaction(doc)).toThrow(/object references exceed the inspection limit/);
    await expect(redactionEngine.applySecureRedactions(doc)).rejects.toThrow();
    expect(page.dict.get('Contents')).toBe(content);
    expect(page.dict.get('Annots')).toBe(annotations);
    expect(doc.objects.size).toBe(objectCount);
    expect(doc.objects.has(ref.toKey())).toBe(true);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });
});
