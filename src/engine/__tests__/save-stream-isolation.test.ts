import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName as LibName } from 'pdf-lib';
import { getPageContentBytes, parsePDF } from '../parser/parser';
import { updatePageContent } from '../editor/stream-compiler';
import { PDFDict, PDFNumber, PDFRef, PDFStream } from '../types';
import { saveOptimized, saveQuick } from '../writer/save-pipeline';
import { serializeDocument, serializeDocumentCompact } from '../writer/serializer';
import { compressDocumentImages } from '../optimize/image-compress';

async function fixture() {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 2; i++) {
    const page = pdf.addPage([100, 100]);
    const image = pdf.context.register(pdf.context.stream(new Uint8Array([10, 20, 30, 40]), {
      Type: 'XObject', Subtype: 'Image', Width: 2, Height: 2, ColorSpace: 'DeviceGray', BitsPerComponent: 8,
    }));
    page.node.set(LibName.of('Resources'), pdf.context.obj({ XObject: { Im: image } }));
    page.node.set(LibName.of('Contents'), pdf.context.register(pdf.context.stream('q 20 0 0 20 10 10 cm /Im Do Q\n')));
  }
  return parsePDF(await pdf.save({ useObjectStreams: false }));
}

function imageRef(doc: Awaited<ReturnType<typeof fixture>>, index: number): PDFRef {
  return doc.pages[index].resources.getDict('XObject')!.get('Im') as PDFRef;
}

describe('saved stream edit isolation', () => {
  it.each([
    ['full serialization', serializeDocument],
    ['quick save', saveQuick],
    ['optimized save', saveOptimized],
    ['compact serialization', serializeDocumentCompact],
    ['image compression', async (doc: Awaited<ReturnType<typeof fixture>>) =>
      (await compressDocumentImages(doc, { quality: 0.8, dpi: null })).bytes],
  ])('%s keeps identical page and image streams independently editable', async (_name, save) => {
    const original = await fixture();
    const unused = new Uint8Array([101, 102, 103]);
    original.objects.set('999_0', new PDFStream(new PDFDict([['Length', new PDFNumber(unused.length)]]), unused));
    const reopened = await parsePDF(await save(original));
    if (_name !== 'compact serialization') expect(reopened.objects.has('999_0')).toBe(false);
    expect(reopened.pages[0].contentRefs[0].toKey()).not.toBe(reopened.pages[1].contentRefs[0].toKey());
    expect(imageRef(reopened, 0).toKey()).not.toBe(imageRef(reopened, 1).toKey());

    const pageTwoBefore = getPageContentBytes(reopened.pages[1], reopened.objects).slice();
    const otherImageBefore = (reopened.objects.get(imageRef(reopened, 1).toKey()) as PDFStream).rawBytes.slice();
    await updatePageContent(reopened.pages[0].contentRefs, new TextEncoder().encode('q 10 0 0 10 5 5 cm /Im Do Q\n'), reopened.objects, false);
    const first = imageRef(reopened, 0), image = reopened.objects.get(first.toKey()) as PDFStream;
    reopened.objects.set(first.toKey(), new PDFStream(image.dict, new Uint8Array([255, 255, 255, 255])));
    expect(getPageContentBytes(reopened.pages[1], reopened.objects)).toEqual(pageTwoBefore);
    expect((reopened.objects.get(imageRef(reopened, 1).toKey()) as PDFStream).rawBytes).toEqual(otherImageBefore);

    const savedAgain = await parsePDF(await saveQuick(reopened));
    expect(getPageContentBytes(savedAgain.pages[1], savedAgain.objects)).toEqual(pageTwoBefore);
    expect((savedAgain.objects.get(imageRef(savedAgain, 1).toKey()) as PDFStream).rawBytes).toEqual(otherImageBefore);
    expect((savedAgain.objects.get(imageRef(savedAgain, 0).toKey()) as PDFStream).rawBytes).toEqual(new Uint8Array([255, 255, 255, 255]));
  });
});
