import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { interpretPage, type ImageItem } from '../content/interpreter';
import { imageResourceVersion } from '../content/image-resource-version';
import { replaceImageXObject } from '../editor/image-editor';
import { updatePageContent } from '../editor/stream-compiler';
import { applyFilters, flateEncode } from '../parser/filters';
import { getPageContentBytes, getResource, parsePDF, resolveRef } from '../parser/parser';
import { decodeImage } from '../render/image-decoder';
import { PDFArray, PDFBoolean, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, type PDFDocumentData } from '../types';
import { getNextObjNum } from '../writer/serializer';
import { saveOptimized, saveQuick } from '../writer/save-pipeline';
import { installPNGEnvironment, rawPDF, tinyJPEG, tinyPNG } from './audit-p1-fixtures';
import { dehydrateDocument, hydrateDocument, sameDocumentSnapshot } from '../worker/codec';
import { SessionDocumentEditor } from '../session/document-edit';

const originalPixels = [10, 20, 30, 255];
const replacementPixels = [201, 102, 53, 255, 17, 99, 231, 255];

async function fixture(mode: 'pages-and-names' | 'form' | 'shared-resources' | 'inherited-resources' | 'single' = 'pages-and-names'): Promise<PDFDocumentData> {
  const shared = mode === 'shared-resources' || mode === 'inherited-resources';
  const ownResources = mode === 'inherited-resources' ? '' : shared ? '/Resources 10 0 R' : '/Resources << /XObject << /Edit 7 0 R /Alias 7 0 R /Fm 9 0 R >> >>';
  const firstContent = mode === 'pages-and-names' ? '/Edit Do /Alias Do' : '/Edit Do';
  const secondContent = shared ? '/Edit Do' : '/Original Do';
  const stream = (content: string) => `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  const doc = await parsePDF(rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 ${mode === 'inherited-resources' ? '/Resources 10 0 R' : ''} >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] ${ownResources} /Contents 5 0 R >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] ${shared ? ownResources : '/Resources << /XObject << /Original 7 0 R >> >>'} /Contents 6 0 R >>`,
    stream(firstContent), stream(secondContent),
    `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\n${String.fromCharCode(10, 20, 30)}\nendstream`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\x40\nendstream',
    '<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << /XObject << /Nested 7 0 R >> >> /Length 10 >>\nstream\n/Nested Do\nendstream',
    '<< /XObject << /Edit 7 0 R >> >>',
  ]));
  if (mode === 'single' || mode === 'form') {
    doc.pages[0].resources = new PDFDict([['XObject', new PDFDict([['Edit', new PDFRef(7, 0)]])]]);
    doc.pages[0].dict.set('Resources', doc.pages[0].resources);
    doc.pages[1].resources = new PDFDict();
    doc.pages[1].dict.set('Resources', doc.pages[1].resources);
    // Keep the form only when its resource entry is a second image use.
    if (mode === 'single') doc.objects.delete('9_0');
  }
  return doc;
}

function editedImage(doc: PDFDocumentData): ImageItem {
  const page = doc.pages[0];
  const item = interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects).displayList.find(item => item.type === 'image' && item.name === 'Edit');
  if (!item || item.type !== 'image') throw new Error('Synthetic edited image missing');
  return item;
}

async function pixels(doc: PDFDocumentData, resources: PDFDict, name: string): Promise<number[]> {
  const image = getResource(resources, 'XObject', name, doc.objects);
  if (!(image instanceof PDFStream)) throw new Error(`Synthetic /${name} missing`);
  image.decodedBytes = await applyFilters(image.rawBytes, image.getFilters(), image.getDecodeParams());
  const decoded = await decodeImage(image, doc.objects);
  if (!decoded) throw new Error(`Synthetic /${name} did not decode`);
  return Array.from(decoded.data);
}

beforeEach(installPNGEnvironment);
afterEach(() => vi.unstubAllGlobals());

describe('image replacement isolation (P1-B)', () => {
  it('shares a page fingerprint budget across images while reusing aliases of one reference', async () => {
    const doc = await fixture('single');
    const page = doc.pages[0];
    const xobjects = page.resources.get('XObject') as PDFDict;
    const image = doc.objects.get('7_0') as PDFStream;
    const data = new Uint8Array(10 * 1024 * 1024);
    image.rawBytes = data;
    image.dict.set('Width', new PDFNumber(4096));
    image.dict.set('Height', new PDFNumber(2560));
    image.dict.set('ColorSpace', new PDFName('DeviceGray'));
    image.dict.set('Length', new PDFNumber(data.length));
    for (let i = 0; i < 3; i++) xobjects.set(`Alias${i}`, new PDFRef(7, 0));
    for (let i = 0; i < 12; i++) {
      const ref = new PDFRef(100 + i, 0);
      xobjects.set(`Different${i}`, ref);
      doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([...image.dict.entries()]), data));
    }
    const content = new TextEncoder().encode(`/Edit Do /Alias0 Do /Alias1 Do /Alias2 Do ${Array.from({ length: 12 }, (_, i) => `/Different${i} Do`).join(' ')} /Alias0 Do`);
    await updatePageContent(page.contentRefs, content, doc.objects, false);
    const images = interpretPage(content, page, doc.objects).displayList.filter((item): item is ImageItem => item.type === 'image');
    expect(images).toHaveLength(17);
    expect(images.slice(0, 4).map(item => item.sourceImageVersion)).toEqual(Array(4).fill(images[0].sourceImageVersion));
    expect(images.slice(0, 15).every(item => !!item.sourceImageVersion)).toBe(true);
    expect(images[15].sourceImageVersion).toBeUndefined();
    expect(images[16].sourceImageVersion).toBe(images[0].sourceImageVersion);
    await expect(replaceImageXObject(doc, 0, images[15], tinyPNG(replacementPixels))).rejects.toThrow(/stale|ambiguous/);

    // A fresh interpretation must not reuse a previous fingerprint after a
    // resource is changed in place.
    data[0] = 42;
    const changed = interpretPage(content, page, doc.objects).displayList.find(item => item.type === 'image' && item.name === 'Edit');
    expect(changed?.type === 'image' && changed.sourceImageVersion).not.toBe(images[0].sourceImageVersion);
  }, 20_000);

  it('preserves support for a single image near the existing 128 MiB limit', async () => {
    const doc = await fixture('single');
    const page = doc.pages[0], image = doc.objects.get('7_0') as PDFStream;
    image.rawBytes = new Uint8Array(127 * 1024 * 1024);
    image.dict.set('Width', new PDFNumber(16256));
    image.dict.set('Height', new PDFNumber(8192));
    image.dict.set('ColorSpace', new PDFName('DeviceGray'));
    image.dict.set('Length', new PDFNumber(image.rawBytes.length));
    const images = interpretPage(new TextEncoder().encode('/Edit Do'), page, doc.objects).displayList
      .filter((item): item is ImageItem => item.type === 'image');
    expect(images).toHaveLength(1);
    expect(images[0].sourceImageVersion).toBeDefined();
    await replaceImageXObject(doc, 0, images[0], tinyPNG(replacementPixels));
    expect(await pixels(doc, doc.pages[0].resources, 'Edit')).toEqual(replacementPixels);
  }, 20_000);

  it('limits total inspected image graph nodes without omitting display items', async () => {
    const doc = await fixture('single');
    const page = doc.pages[0], xobjects = page.resources.get('XObject') as PDFDict;
    const template = doc.objects.get('7_0') as PDFStream;
    const values = new PDFArray(Array(30_000).fill(new PDFNumber(1)));
    for (let i = 0; i < 4; i++) {
      const ref = new PDFRef(100 + i, 0);
      const dict = new PDFDict([...template.dict.entries()]);
      dict.set('Private', values);
      xobjects.set(`Image${i}`, ref);
      doc.objects.set(ref.toKey(), new PDFStream(dict, template.rawBytes));
    }
    const content = new TextEncoder().encode('/Image0 Do /Image1 Do /Image2 Do /Image3 Do');
    const images = interpretPage(content, page, doc.objects).displayList.filter((item): item is ImageItem => item.type === 'image');
    expect(images).toHaveLength(4);
    expect(images.slice(0, 3).every(item => !!item.sourceImageVersion)).toBe(true);
    expect(images[3].sourceImageVersion).toBeUndefined();
  });

  it('returns an unavailable image version for a cyclic XObject dictionary reference', () => {
    const resources = new PDFDict([['XObject', new PDFRef(71, 0)]]);
    const objects = new Map([
      ['71_0', new PDFRef(72, 0)],
      ['72_0', new PDFRef(71, 0)],
    ]);
    expect(imageResourceVersion(resources, 'Edit', objects)).toBeUndefined();
  });
  it('rejects a cloned selection after the same named image was replaced in place', async () => {
    const doc = await fixture('single');
    const stale = structuredClone(editedImage(doc));
    const session = new SessionDocumentEditor();
    await session.edit(doc, 'replace-image', staged => replaceImageXObject(staged, 0, stale, tinyPNG(replacementPixels)));
    expect(editedImage(doc).name).toBe(stale.name);
    expect(editedImage(doc).sourceInstructionIndex).toBe(stale.sourceInstructionIndex);
    const changed = dehydrateDocument(doc);
    await expect(session.edit(doc, 'replace-image', staged => replaceImageXObject(staged, 0, stale, tinyPNG(originalPixels))))
      .rejects.toThrow(/stale|ambiguous/);
    expect(sameDocumentSnapshot(changed, dehydrateDocument(doc))).toBe(true);
    expect(await session.undo(doc)).toBe(true);
    await session.edit(doc, 'replace-image', staged => replaceImageXObject(staged, 0, stale, tinyPNG(replacementPixels)));
    const fresh = structuredClone(editedImage(doc));
    await session.edit(doc, 'replace-image', staged => replaceImageXObject(staged, 0, fresh, tinyPNG(originalPixels)));
  });

  it('rejects a selection after an indirect soft mask changes without changing its reference', async () => {
    const doc = await fixture('single');
    const image = doc.objects.get('7_0') as PDFStream;
    image.dict.set('SMask', new PDFRef(8, 0));
    const selected = structuredClone(editedImage(doc));
    (doc.objects.get('8_0') as PDFStream).rawBytes[0] ^= 0xff;
    const changed = dehydrateDocument(doc);
    await expect(replaceImageXObject(doc, 0, selected, tinyPNG(replacementPixels))).rejects.toThrow(/stale|ambiguous/);
    expect(sameDocumentSnapshot(changed, dehydrateDocument(doc))).toBe(true);
  });

  it('preserves the selected identity across a worker document and selection round trip', async () => {
    const doc = await fixture('single');
    const selected = structuredClone(editedImage(doc));
    const workerDocument = hydrateDocument(structuredClone(dehydrateDocument(doc)));
    await replaceImageXObject(workerDocument, 0, selected, tinyPNG(replacementPixels));
    expect(await pixels(workerDocument, workerDocument.pages[0].resources, 'Edit')).toEqual(replacementPixels);
  });

  it('rejects a selection when the resource is redirected to an identical image object', async () => {
    const doc = await fixture('single');
    const selected = editedImage(doc);
    const image = doc.objects.get('7_0') as PDFStream;
    doc.objects.set('998_0', new PDFStream(new PDFDict([...image.dict.entries()]), image.rawBytes.slice()));
    const dictionary = resolveRef(doc.pages[0].resources.get('XObject')!, doc.objects) as PDFDict;
    dictionary.set('Edit', new PDFRef(998, 0));
    await expect(replaceImageXObject(doc, 0, selected, tinyPNG(replacementPixels))).rejects.toThrow(/stale|ambiguous/);
  });

  it('detects changes to a named page color space used by the image', async () => {
    const doc = await fixture('single');
    const image = doc.objects.get('7_0') as PDFStream;
    image.dict.set('ColorSpace', new PDFName('PictureSpace'));
    const colorSpaces = new PDFDict([['PictureSpace', new PDFRef(997, 0)]]);
    doc.pages[0].resources.set('ColorSpace', colorSpaces);
    doc.objects.set('997_0', new PDFName('DeviceRGB'));
    const selected = editedImage(doc);
    expect(selected.sourceImageVersion).toBeDefined();
    doc.objects.set('997_0', new PDFName('DeviceGray'));
    await expect(replaceImageXObject(doc, 0, selected, tinyPNG(replacementPixels))).rejects.toThrow(/stale|ambiguous/);
  });

  it('rejects an image whose named page color space cannot be resolved', async () => {
    const doc = await fixture('single');
    (doc.objects.get('7_0') as PDFStream).dict.set('ColorSpace', new PDFName('MissingSpace'));
    const selected = editedImage(doc);
    expect(selected.sourceImageVersion).toBeUndefined();
    await expect(replaceImageXObject(doc, 0, selected, tinyPNG(replacementPixels))).rejects.toThrow(/stale|ambiguous/);
  });

  it('refuses replacement when an image resource cannot be completely inspected', async () => {
    const doc = await fixture('single');
    (doc.objects.get('7_0') as PDFStream).dict.set('SMask', new PDFRef(999, 0));
    const selected = editedImage(doc);
    expect(selected.sourceImageVersion).toBeUndefined();
    await expect(replaceImageXObject(doc, 0, selected, tinyPNG(replacementPixels))).rejects.toThrow(/stale|ambiguous/);
  });
  it.each(['quick', 'incremental'] as const)('does not activate an unresolved page image name after %s save', async mode => {
    const doc = await fixture('single');
    await updatePageContent(doc.pages[0].contentRefs, new TextEncoder().encode('/Edit Do /Im#52eplace1 Do /Edit Do'), doc.objects, false);
    const page = doc.pages[0];
    const images = interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects).displayList
      .filter((item): item is ImageItem => item.type === 'image');
    expect(images).toHaveLength(2);
    await replaceImageXObject(doc, 0, images[1], tinyPNG(replacementPixels));
    const output = mode === 'quick' ? await saveQuick(doc) : await saveQuick(doc, new Set([page.ref.toKey()]));
    const reopened = await parsePDF(output), reopenedPage = reopened.pages[0];
    expect(new TextDecoder().decode(getPageContentBytes(reopenedPage, reopened.objects)))
      .toBe('/Edit Do /Im#52eplace1 Do /ImReplace2 Do');
    const result = interpretPage(getPageContentBytes(reopenedPage, reopened.objects), reopenedPage, reopened.objects).displayList
      .filter((item): item is ImageItem => item.type === 'image');
    expect(result).toHaveLength(2);
    expect(result[1].name).not.toBe('ImReplace1');
    expect(await pixels(reopened, reopenedPage.resources, result[0].name)).toEqual(originalPixels);
    expect(await pixels(reopened, reopenedPage.resources, result[1].name)).toEqual(replacementPixels);
  });

  it.each(['plain', 'compressed'] as const)('avoids an unresolved image name in a %s Form inheriting the page resources', async encoding => {
    const doc = await fixture('single');
    const form = new PDFRef(991, 0), content = new TextEncoder().encode('/Im#52eplace1 Do');
    const formBytes = encoding === 'compressed' ? await flateEncode(content) : content;
    const subtype = new PDFRef(990, 0);
    doc.objects.set(subtype.toKey(), new PDFName('Form'));
    doc.objects.set(form.toKey(), new PDFStream(new PDFDict([
      ['Subtype', subtype], ['Length', new PDFNumber(formBytes.length)],
      ...(encoding === 'compressed' ? [['Filter', new PDFName('FlateDecode')] as [string, PDFName]] : []),
    ]), formBytes));
    const xobjects = resolveRef(doc.pages[0].resources.get('XObject')!, doc.objects) as PDFDict;
    xobjects.set('Fm', form);
    await updatePageContent(doc.pages[0].contentRefs, new TextEncoder().encode('/Fm Do /Edit Do /Edit Do'), doc.objects, false);
    const page = doc.pages[0];
    const images = interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects).displayList
      .filter((item): item is ImageItem => item.type === 'image');
    await replaceImageXObject(doc, 0, images[1], tinyPNG(replacementPixels));
    const reopened = await parsePDF(await saveQuick(doc)), reopenedPage = reopened.pages[0];
    expect(getResource(reopenedPage.resources, 'XObject', 'ImReplace1', reopened.objects)).toBeUndefined();
    const result = interpretPage(getPageContentBytes(reopenedPage, reopened.objects), reopenedPage, reopened.objects).displayList
      .filter((item): item is ImageItem => item.type === 'image');
    expect(result).toHaveLength(2);
    expect(result[1].name).not.toBe('ImReplace1');
  });

  it('leaves the document unchanged when an inherited Form uses an unsupported filter', async () => {
    const doc = await fixture('single');
    const bytes = new TextEncoder().encode('opaque');
    doc.objects.set('991_0', new PDFStream(new PDFDict([
      ['Subtype', new PDFName('Form')], ['Filter', new PDFName('UnsupportedFilter')], ['Length', new PDFNumber(bytes.length)],
    ]), bytes));
    await updatePageContent(doc.pages[0].contentRefs, new TextEncoder().encode('/Edit Do /Edit Do'), doc.objects, false);
    const page = doc.pages[0];
    const images = interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects).displayList
      .filter((item): item is ImageItem => item.type === 'image');
    const before = dehydrateDocument(doc);
    await expect(replaceImageXObject(doc, 0, images[1], tinyPNG(replacementPixels))).rejects.toThrow(/form filters/i);
    expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
  });

  it('leaves the document unchanged when an inherited Form has stale decoded bytes', async () => {
    const doc = await fixture('single');
    const raw = new TextEncoder().encode('/ImReplace1 Do');
    const cached = new TextEncoder().encode('/Other Do');
    const form = new PDFStream(new PDFDict([
      ['Subtype', new PDFName('Form')], ['Length', new PDFNumber(raw.length)],
    ]), raw, cached);
    doc.objects.set('991_0', form);
    await updatePageContent(doc.pages[0].contentRefs, new TextEncoder().encode('/Edit Do /Edit Do'), doc.objects, false);
    const page = doc.pages[0];
    const images = interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects).displayList
      .filter((item): item is ImageItem => item.type === 'image');
    const before = dehydrateDocument(doc);
    await expect(replaceImageXObject(doc, 0, images[1], tinyPNG(replacementPixels))).rejects.toThrow(/form content/i);
    expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
    expect(form.rawBytes).toEqual(raw);
    expect(form.decodedBytes).toEqual(cached);
  });

  it('does not overwrite saved page content when its decoded cache is stale', async () => {
    const doc = await fixture('single');
    const stream = doc.objects.get(doc.pages[0].contentRefs[0].toKey()) as PDFStream;
    const raw = new TextEncoder().encode('/Edit Do /Edit Do /ImReplace1 Do');
    const cached = new TextEncoder().encode('/Edit Do /Edit Do');
    stream.rawBytes = raw;
    stream.decodedBytes = cached;
    stream.dict.set('Length', new PDFNumber(raw.length));
    const page = doc.pages[0];
    const images = interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects).displayList
      .filter((item): item is ImageItem => item.type === 'image');
    const before = dehydrateDocument(doc);
    await expect(replaceImageXObject(doc, 0, images[1], tinyPNG(replacementPixels))).rejects.toThrow(/page content/i);
    expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
    expect(stream.rawBytes).toEqual(raw);
    expect(stream.decodedBytes).toEqual(cached);
  });

  it.each(['stale', 'corrupt'] as const)('rejects a %s compressed page stream without changing a multi-stream page', async mode => {
    const doc = await fixture('single');
    const page = doc.pages[0];
    await updatePageContent(page.contentRefs, new TextEncoder().encode('/Edit Do'), doc.objects, true);
    const cached = new TextEncoder().encode(' /Edit Do');
    const raw = mode === 'stale' ? await flateEncode(new TextEncoder().encode(' /Edit Do /ImReplace1 Do')) : new Uint8Array([0, 1, 2]);
    const second = new PDFRef(991, 0);
    const stream = new PDFStream(new PDFDict([
      ['Filter', new PDFName('FlateDecode')], ['Length', new PDFNumber(raw.length)],
    ]), raw, cached);
    doc.objects.set(second.toKey(), stream);
    page.contentRefs.push(second);
    page.dict.set('Contents', new PDFArray([...page.contentRefs]));
    const images = interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects).displayList
      .filter((item): item is ImageItem => item.type === 'image');
    const before = dehydrateDocument(doc);
    await expect(replaceImageXObject(doc, 0, images[1], tinyPNG(replacementPixels))).rejects.toThrow(/page content/i);
    expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
    expect(stream.rawBytes).toEqual(raw);
    expect(stream.decodedBytes).toEqual(cached);
  });

  it('accepts consistent compressed page streams and preserves their other content', async () => {
    const doc = await fixture('single');
    const page = doc.pages[0];
    await updatePageContent(page.contentRefs, new TextEncoder().encode('/Edit Do'), doc.objects, true);
    const cached = new TextEncoder().encode(' /Edit Do /Im#52eplace1 Do');
    const raw = await flateEncode(cached), second = new PDFRef(991, 0);
    doc.objects.set(second.toKey(), new PDFStream(new PDFDict([
      ['Filter', new PDFName('FlateDecode')], ['Length', new PDFNumber(raw.length)],
    ]), raw, cached));
    page.contentRefs.push(second);
    page.dict.set('Contents', new PDFArray([...page.contentRefs]));
    const images = interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects).displayList
      .filter((item): item is ImageItem => item.type === 'image');
    await replaceImageXObject(doc, 0, images[1], tinyPNG(replacementPixels));
    const reopened = await parsePDF(await saveQuick(doc, new Set([second.toKey()])));
    const result = new TextDecoder().decode(getPageContentBytes(reopened.pages[0], reopened.objects));
    expect(result).toBe('/Edit Do  /ImReplace2 Do /Im#52eplace1 Do ');
  });

  it.each([['quick', saveQuick], ['optimized', saveOptimized]] as const)(
    'replaces only the selected placement of a reused image with %s', async (_name, save) => {
      const doc = await fixture('single');
      await updatePageContent(doc.pages[0].contentRefs, new TextEncoder().encode(
        'q 20 0 0 20 10 10 cm /Edit Do Q\nq 20 0 0 20 80 10 cm /Edit Do Q\n',
      ), doc.objects, false);
      const page = doc.pages[0];
      const images = interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects).displayList
        .filter((item): item is ImageItem => item.type === 'image');
      expect(images).toHaveLength(2);
      await replaceImageXObject(doc, 0, images[1], tinyPNG(replacementPixels));
      const reopened = await parsePDF(await save(doc));
      const reopenedPage = reopened.pages[0];
      const placements = interpretPage(getPageContentBytes(reopenedPage, reopened.objects), reopenedPage, reopened.objects).displayList
        .filter((item): item is ImageItem => item.type === 'image');
      expect(placements).toHaveLength(2);
      expect(await pixels(reopened, reopenedPage.resources, placements[0].name)).toEqual(originalPixels);
      expect(await pixels(reopened, reopenedPage.resources, placements[1].name)).toEqual(replacementPixels);
    },
  );

  it('keeps both masks and selected placement through explicit incremental save', async () => {
    const doc = await fixture('single');
    const original = doc.objects.get('7_0') as PDFStream;
    original.dict.set('SMask', new PDFRef(8, 0));
    await updatePageContent(doc.pages[0].contentRefs, new TextEncoder().encode(
      'q 20 0 0 20 10 10 cm /Edit Do Q\nq 20 0 0 20 80 10 cm /Edit Do Q\n',
    ), doc.objects, false);
    const page = doc.pages[0];
    const images = interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects).displayList
      .filter((item): item is ImageItem => item.type === 'image');
    const expected = [201, 102, 53, 73, 17, 99, 231, 255];
    await replaceImageXObject(doc, 0, images[1], tinyPNG(expected));
    // Include the original fixture's pre-existing mask edit; new objects must be registered by replacement.
    const reopened = await parsePDF(await saveQuick(doc, new Set(['7_0'])));
    const reopenedPage = reopened.pages[0];
    const placements = interpretPage(getPageContentBytes(reopenedPage, reopened.objects), reopenedPage, reopened.objects).displayList
      .filter((item): item is ImageItem => item.type === 'image');
    expect(placements).toHaveLength(2);
    expect(await pixels(reopened, reopenedPage.resources, placements[0].name)).toEqual([10, 20, 30, 64]);
    expect(await pixels(reopened, reopenedPage.resources, placements[1].name)).toEqual(expected);
  });

  it('does not change a different page sharing the selected content stream', async () => {
    const doc = await fixture('single');
    await updatePageContent(doc.pages[0].contentRefs, new TextEncoder().encode('/Edit Do /Edit Do'), doc.objects, false);
    const sharedRef = doc.pages[0].contentRefs[0];
    doc.pages[1].dict.set('Contents', sharedRef);
    doc.pages[1].contentRefs.splice(0, doc.pages[1].contentRefs.length, sharedRef);
    const page = doc.pages[0];
    const selected = interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects).displayList
      .filter((item): item is ImageItem => item.type === 'image')[1];
    await replaceImageXObject(doc, 0, selected, tinyPNG(replacementPixels));
    expect(new TextDecoder().decode(getPageContentBytes(doc.pages[1], doc.objects))).toBe('/Edit Do /Edit Do');
    expect(doc.pages[0].contentRefs[0].toKey()).not.toBe(sharedRef.toKey());
    const reopened = await parsePDF(await saveQuick(doc, new Set([doc.pages[1].ref.toKey(), sharedRef.toKey()])));
    expect(new TextDecoder().decode(getPageContentBytes(reopened.pages[1], reopened.objects))).toBe('/Edit Do /Edit Do');
  });

  it('rejects a stale selected placement without changing the document', async () => {
    const doc = await fixture('single');
    const selected = editedImage(doc);
    await updatePageContent(doc.pages[0].contentRefs, new TextEncoder().encode('1 0 0 1 30 0 cm /Edit Do'), doc.objects, false);
    const snapshot = dehydrateDocument(doc);
    await expect(replaceImageXObject(doc, 0, selected, tinyPNG(replacementPixels))).rejects.toThrow(/stale|ambiguous/);
    expect(sameDocumentSnapshot(snapshot, dehydrateDocument(doc))).toBe(true);
  });

  it('discards an asynchronous replacement if page resources change during image loading', async () => {
    const doc = await fixture('single');
    const selected = editedImage(doc);
    const BaseImage = globalThis.Image;
    let resume!: () => void;
    class DelayedImage extends BaseImage {
      set src(url: string) { resume = () => { super.src = url; }; }
    }
    vi.stubGlobal('Image', DelayedImage);
    const operation = replaceImageXObject(doc, 0, selected, tinyPNG([201, 102, 53, 73, 17, 99, 231, 255]));
    doc.pages[0].resources.set('Concurrent', new PDFName('Change'));
    const snapshot = dehydrateDocument(doc);
    resume();
    await expect(operation).rejects.toThrow(/changed/);
    expect(sameDocumentSnapshot(snapshot, dehydrateDocument(doc))).toBe(true);
  });

  it('leaves the document intact when image decoding fails', async () => {
    const doc = await fixture('single');
    const selected = editedImage(doc);
    const snapshot = dehydrateDocument(doc);
    await expect(replaceImageXObject(doc, 0, selected, 'data:image/png;base64,AA==')).rejects.toThrow(/decode/);
    expect(sameDocumentSnapshot(snapshot, dehydrateDocument(doc))).toBe(true);
  });

  it('leaves no soft mask behind when RGB encoding fails after alpha encoding', async () => {
    const doc = await fixture('single');
    const selected = editedImage(doc);
    const snapshot = dehydrateDocument(doc);
    const OriginalCompressionStream = globalThis.CompressionStream;
    let calls = 0;
    vi.stubGlobal('CompressionStream', class {
      constructor(format: CompressionFormat) {
        if (++calls === 2) throw new Error('Synthetic RGB encoding failure');
        return new OriginalCompressionStream(format);
      }
    });
    await expect(replaceImageXObject(doc, 0, selected, tinyPNG([201, 102, 53, 73, 17, 99, 231, 255])))
      .rejects.toThrow('Synthetic RGB encoding failure');
    expect(sameDocumentSnapshot(snapshot, dehydrateDocument(doc))).toBe(true);
  });

  it('rejects concurrent mutation of a Buffer-backed decoded content cache', async () => {
    const doc = await fixture('single');
    const content = doc.objects.get(doc.pages[0].contentRefs[0].toKey()) as PDFStream;
    content.decodedBytes = Buffer.from(content.getBytes());
    const selected = editedImage(doc);
    const BaseImage = globalThis.Image;
    let resume!: () => void;
    class DelayedImage extends BaseImage {
      set src(url: string) { resume = () => { super.src = url; }; }
    }
    vi.stubGlobal('Image', DelayedImage);
    const operation = replaceImageXObject(doc, 0, selected, tinyPNG(replacementPixels));
    content.decodedBytes[0] = 0x20;
    const changed = new Uint8Array(content.decodedBytes);
    resume();
    await expect(operation).rejects.toThrow(/changed/);
    expect(Array.from(content.decodedBytes!)).toEqual(Array.from(changed));
  });

  for (const save of [saveQuick, saveOptimized]) {
    it(`${save.name} changes only one resource name across two pages`, async () => {
      const doc = await fixture();
      await replaceImageXObject(doc, 0, editedImage(doc), tinyPNG(replacementPixels), () => getNextObjNum(doc));
      const reopened = await parsePDF(await save(doc));
      expect(await pixels(reopened, reopened.pages[0].resources, 'Edit')).toEqual(replacementPixels);
      expect(await pixels(reopened, reopened.pages[0].resources, 'Alias')).toEqual(originalPixels);
      expect(await pixels(reopened, reopened.pages[1].resources, 'Original')).toEqual(originalPixels);
    });
  }

  it.each(['shared-resources', 'inherited-resources'] as const)('does not repoint a sibling page sharing %s', async mode => {
    const doc = await fixture(mode);
    await replaceImageXObject(doc, 0, editedImage(doc), tinyPNG(replacementPixels), () => getNextObjNum(doc));
    const reopened = await parsePDF(await saveQuick(doc));
    expect(await pixels(reopened, reopened.pages[0].resources, 'Edit')).toEqual(replacementPixels);
    expect(await pixels(reopened, reopened.pages[1].resources, 'Edit')).toEqual(originalPixels);
  });

  it('preserves the original image referenced only by another form XObject', async () => {
    const doc = await fixture('form');
    await replaceImageXObject(doc, 0, editedImage(doc), tinyPNG(replacementPixels), () => getNextObjNum(doc));
    const form = doc.objects.get('9_0') as PDFStream;
    expect(await pixels(doc, resolveRef(form.dict.get('Resources')!, doc.objects) as PDFDict, 'Nested')).toEqual(originalPixels);
    expect(await pixels(doc, doc.pages[0].resources, 'Edit')).toEqual(replacementPixels);
  });

  it('keeps a single-use stream and indirect reference in place', async () => {
    const doc = await fixture('single');
    const original = doc.objects.get('7_0');
    await replaceImageXObject(doc, 0, editedImage(doc), tinyPNG(replacementPixels), () => getNextObjNum(doc));
    expect(doc.objects.get('7_0')).toBe(original);
    expect((resolveRef(doc.pages[0].resources.get('XObject')!, doc.objects) as PDFDict).getRef('Edit')?.toKey()).toBe('7_0');
    expect(await pixels(doc, doc.pages[0].resources, 'Edit')).toEqual(replacementPixels);
  });

  it('allocates replacement objects without an optional allocator', async () => {
    const doc = await fixture();
    await replaceImageXObject(doc, 0, editedImage(doc), tinyPNG(replacementPixels));
    const reopened = await parsePDF(await saveQuick(doc));
    expect(await pixels(reopened, reopened.pages[0].resources, 'Edit')).toEqual(replacementPixels);
    expect(await pixels(reopened, reopened.pages[1].resources, 'Original')).toEqual(originalPixels);
  });

  it('keeps an alpha image and its mask in distinct objects when cloning', async () => {
    const doc = await fixture();
    const expected = [201, 102, 53, 73, 17, 99, 231, 255];
    await replaceImageXObject(doc, 0, editedImage(doc), tinyPNG(expected), () => getNextObjNum(doc));
    const replaced = getResource(doc.pages[0].resources, 'XObject', 'Edit', doc.objects) as PDFStream;
    const xobjects = resolveRef(doc.pages[0].resources.get('XObject')!, doc.objects) as PDFDict;
    expect(replaced.dict.getRef('SMask')?.toKey()).not.toBe(xobjects.getRef('Edit')?.toKey());
    const reopened = await parsePDF(await saveQuick(doc));
    expect(await pixels(reopened, reopened.pages[0].resources, 'Edit')).toEqual(expected);
    expect(await pixels(reopened, reopened.pages[0].resources, 'Alias')).toEqual(originalPixels);
    expect(await pixels(reopened, reopened.pages[1].resources, 'Original')).toEqual(originalPixels);
  });
});

describe('in-session image replacement', () => {
  it('decodes new RGB and alpha on the same object after JPEG and repeated PNG replacements', async () => {
    const doc = await fixture('single');
    const image = doc.objects.get('7_0') as PDFStream;
    image.rawBytes = tinyJPEG();
    image.decodedBytes = null;
    image.dict.set('Filter', new PDFName('DCTDecode'));
    image.dict.set('Length', new PDFNumber(image.rawBytes.length));

    for (const expected of [
      [220, 30, 30, 255, 0, 0, 0, 0],
      [30, 180, 70, 255, 0, 0, 0, 0],
    ]) {
      await replaceImageXObject(doc, 0, editedImage(doc), tinyPNG(expected), () => getNextObjNum(doc));
      const replaced = getResource(doc.pages[0].resources, 'XObject', 'Edit', doc.objects) as PDFStream;
      expect(replaced).toBe(image);
      // Decode the live streams without saving, reopening, or repairing decodedBytes.
      for (let pass = 0; pass < 2; pass++) {
        const decoded = await decodeImage(replaced, doc.objects);
        expect(decoded).toMatchObject({ width: 2, height: 1 });
        expect(Array.from(decoded!.data)).toEqual(expected);
      }
    }
  });
});

describe('PNG replacement dictionaries (P1-C)', () => {
  it.each([255, 73])('replaces JPEG and obsolete masks/decoding keys with new alpha=%i', async alpha => {
    const doc = await fixture('single');
    const image = doc.objects.get('7_0') as PDFStream;
    image.rawBytes = tinyJPEG();
    image.decodedBytes = null;
    image.dict.set('Length', new PDFNumber(image.rawBytes.length));
    image.dict.set('Filter', new PDFName('DCTDecode'));
    image.dict.set('SMask', new PDFRef(8, 0));
    image.dict.set('Mask', new PDFRef(8, 0));
    image.dict.set('Decode', new PDFArray([1, 0, 1, 0, 1, 0].map(value => new PDFNumber(value))));
    image.dict.set('DecodeParms', new PDFDict([['ColorTransform', new PDFNumber(0)], ['Predictor', new PDFNumber(15)]]));
    image.dict.set('Matte', new PDFArray([new PDFNumber(1), new PDFNumber(0), new PDFNumber(0)]));
    image.dict.set('Intent', new PDFName('AbsoluteColorimetric'));
    image.dict.set('ImageMask', new PDFBoolean(true));
    image.dict.set('F', new PDFName('obsolete-file'));
    image.dict.set('FFilter', new PDFName('DCTDecode'));
    image.dict.set('FDecodeParms', new PDFDict([['ColorTransform', new PDFNumber(0)]]));
    const expected = [201, 102, 53, alpha, 17, 99, 231, 255];
    await replaceImageXObject(doc, 0, editedImage(doc), tinyPNG(expected), () => getNextObjNum(doc));
    const replaced = getResource(doc.pages[0].resources, 'XObject', 'Edit', doc.objects) as PDFStream;
    const validKeys = ['Type', 'Subtype', 'Width', 'Height', 'ColorSpace', 'BitsPerComponent', 'Filter', 'Length'];
    if (alpha !== 255) validKeys.push('SMask');
    expect([...replaced.dict.keys()].sort()).toEqual(validKeys.sort());
    if (alpha !== 255) expect(replaced.dict.getRef('SMask')?.toKey()).not.toBe('8_0');
    for (const save of [saveQuick, saveOptimized]) {
      const reopened = await parsePDF(await save(doc));
      expect(await pixels(reopened, reopened.pages[0].resources, 'Edit')).toEqual(expected);
    }
  });
});
