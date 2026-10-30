import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';
import { updatePageContent } from '../editor/stream-compiler';
import { sanitizationEngine } from '../security/sanitization/sanitization-engine';
import { serializeDocument } from '../writer/serializer';
import { saveQuick, saveOptimized } from '../writer/save-pipeline';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, PDFString } from '../types';

const opts = { metadata: false, javascript: false, embeddedFiles: false, comments: false,
  annotations: false, unusedObjects: false, hiddenLayers: true, alternativeImages: false };
const hidden = 'CONFIDENTIAL-729';
const input = `BT /F1 12 Tf 1 0 0 1 20 160 Tm (PUBLIC-ALPHA) Tj ET\n/OC /Hidden BDC q BT /F1 12 Tf 1 0 0 1 20 100 Tm (${hidden}) Tj ET Q EMC\nBT /F1 12 Tf 1 0 0 1 20 40 Tm (PUBLIC-OMEGA) Tj ET`;
async function fixture(content = input) {
  const pdf = await PDFDocument.create(); pdf.addPage([220, 220]);
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  const info = doc.xref.trailerDict.getRef('Info')!;
  const information = doc.objects.get(info.toKey()) as PDFDict;
  for (const key of [...information.keys()]) information.delete(key);
  const group = new PDFRef(900, 0), font = new PDFRef(901, 0);
  doc.objects.set(group.toKey(), new PDFDict([['Type', new PDFName('OCG')], ['Name', new PDFString('Hidden layer')]]));
  doc.objects.set(font.toKey(), new PDFDict([['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')], ['BaseFont', new PDFName('Helvetica')]]));
  doc.catalog.set('OCProperties', new PDFDict([['OCGs', new PDFArray([group])], ['D', new PDFDict([['OFF', new PDFArray([group])]])]]));
  const page = doc.pages[0];
  page.resources.set('Properties', new PDFDict([['Hidden', group]]));
  page.resources.set('Font', new PDFDict([['F1', font]]));
  page.dict.set('Resources', page.resources);
  await updatePageContent(page.contentRefs, new TextEncoder().encode(content), doc.objects, false);
  return doc;
}

async function multiPageFixture(contents: string[]) {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < contents.length; index++) pdf.addPage([220, 220]);
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  const information = doc.objects.get(doc.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;
  for (const key of [...information.keys()]) information.delete(key);
  const group = new PDFRef(900, 0), font = new PDFRef(901, 0);
  doc.objects.set(group.toKey(), new PDFDict([['Type', new PDFName('OCG')], ['Name', new PDFString('Hidden layer')]]));
  doc.objects.set(font.toKey(), new PDFDict([['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')], ['BaseFont', new PDFName('Helvetica')]]));
  doc.catalog.set('OCProperties', new PDFDict([['OCGs', new PDFArray([group])], ['D', new PDFDict([['OFF', new PDFArray([group])]])]]));
  for (let index = 0; index < contents.length; index++) {
    const page = doc.pages[index];
    page.resources.set('Properties', new PDFDict([['Hidden', group]]));
    page.resources.set('Font', new PDFDict([['F1', font]]));
    page.dict.set('Resources', page.resources);
    await updatePageContent(page.contentRefs, new TextEncoder().encode(contents[index]), doc.objects, false);
  }
  return doc;
}

describe('sanitizing isolated hidden text layers', () => {
  it('removes hidden text from multiple pages while preserving every visible page', async () => {
    const second = 'SECOND-PRIVATE-841';
    const visibleOnly = 'BT /F1 12 Tf 1 0 0 1 20 80 Tm (THIRD-PUBLIC) Tj ET';
    const before = await serializeDocument(await multiPageFixture([input, input.replace(hidden, second), visibleOnly]));
    const doc = await parsePDF(before);
    const result = await sanitizationEngine.sanitize(doc, opts);
    expect(result.detail.layersRemoved).toBe(1);
    const saved = await saveQuick(doc);
    expect(new TextDecoder().decode(saved)).not.toContain(hidden);
    expect(new TextDecoder().decode(saved)).not.toContain(second);
    expect((await PDFDocument.load(saved, { updateMetadata: false })).getPageCount()).toBe(3);
    const reopened = await parsePDF(saved);
    expect(reopened.catalog.has('OCProperties')).toBe(false);
    expect(new TextDecoder().decode((reopened.objects.get(reopened.pages[2].contentRefs[0].toKey()) as PDFStream).getBytes())).toContain('THIRD-PUBLIC');
    if (spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).error || spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).error) return;
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-hidden-pages-'));
    try {
      const a = join(dir, 'before.pdf'), b = join(dir, 'after.pdf');
      writeFileSync(a, before); writeFileSync(b, saved);
      if (!spawnSync('qpdf', ['--version'], { stdio: 'ignore' }).error) {
        execFileSync('qpdf', ['--check', a], { stdio: 'ignore' });
        execFileSync('qpdf', ['--check', b], { stdio: 'ignore' });
      }
      const text = execFileSync('pdftotext', [b, '-'], { encoding: 'utf8' });
      expect(text).toContain('PUBLIC-ALPHA'); expect(text).toContain('PUBLIC-OMEGA'); expect(text).toContain('THIRD-PUBLIC');
      expect(text).not.toContain(hidden); expect(text).not.toContain(second);
      for (const dpi of [36, 72, 150, 300]) {
        execFileSync('pdftoppm', ['-r', String(dpi), a, join(dir, 'before')], { stdio: 'ignore' });
        execFileSync('pdftoppm', ['-r', String(dpi), b, join(dir, 'after')], { stdio: 'ignore' });
        for (let page = 1; page <= 3; page++) {
          expect(readFileSync(join(dir, `after-${page}.ppm`)).equals(readFileSync(join(dir, `before-${page}.ppm`)))).toBe(true);
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it('refuses hidden text independently retained on another page without modification', async () => {
    const visible = `BT /F1 12 Tf 1 0 0 1 20 80 Tm (${hidden}) Tj ET`;
    const doc = await multiPageFixture([input, visible]);
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, opts)).rejects.toThrow(/hidden layer|optional content/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('refuses a hidden value split across visible pages without modification', async () => {
    const block = (text: string) => `BT /F1 12 Tf 1 0 0 1 20 80 Tm (${text}) Tj ET`;
    const doc = await multiPageFixture([input, block('CONFIDENTIAL-'), block('729')]);
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, opts)).rejects.toThrow(/hidden layer|optional content/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('keeps a verified compressed visible-only page unchanged', async () => {
    const visible = 'BT /F1 12 Tf 1 0 0 1 20 80 Tm (PUBLIC-ONLY) Tj ET';
    const doc = await multiPageFixture([input, visible]);
    const ref = doc.pages[1].contentRefs[0], decoded = new TextEncoder().encode(visible);
    const compressed = new Uint8Array(deflateSync(decoded));
    doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([
      ['Length', new PDFNumber(compressed.length)], ['Filter', new PDFName('FlateDecode')],
    ]), compressed, decoded));
    await sanitizationEngine.sanitize(doc, opts);
    const reopened = await parsePDF(await saveQuick(doc));
    const stream = reopened.objects.get(reopened.pages[1].contentRefs[0].toKey()) as PDFStream;
    expect(stream.dict.getName('Filter')).toBe('FlateDecode');
    expect(stream.rawBytes).toEqual(compressed);
    expect(new TextDecoder().decode(stream.getBytes())).toContain('PUBLIC-ONLY');
  });

  it('refuses a content stream shared by two pages without modification', async () => {
    const doc = await multiPageFixture([input, input]);
    const first = doc.pages[0].contentRefs[0], second = doc.pages[1];
    second.dict.set('Contents', first);
    second.contentRefs.splice(0, second.contentRefs.length, first);
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, opts)).rejects.toThrow(/hidden layer|optional content/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('preserves an independently blank page without creating content', async () => {
    const doc = await multiPageFixture([input, input]);
    const blank = doc.pages[1];
    blank.dict.delete('Contents');
    blank.contentRefs.splice(0, blank.contentRefs.length);
    blank.resources = new PDFDict();
    blank.dict.set('Resources', blank.resources);
    await sanitizationEngine.sanitize(doc, opts);
    const reopened = await parsePDF(await saveQuick(doc));
    expect(reopened.pages).toHaveLength(2);
    expect(reopened.pages[1].contentRefs).toHaveLength(0);
    expect(reopened.pages[1].dict.has('Contents')).toBe(false);
  });

  it('handles a resources dictionary shared only between the edited pages', async () => {
    const doc = await multiPageFixture([input, input.replace(hidden, 'SECOND-PRIVATE-841')]);
    doc.pages[1].resources = doc.pages[0].resources;
    doc.pages[1].dict.set('Resources', doc.pages[0].resources);
    await sanitizationEngine.sanitize(doc, opts);
    const saved = await saveQuick(doc);
    const reopened = await parsePDF(saved);
    expect(reopened.pages).toHaveLength(2);
    expect(new TextDecoder().decode(saved)).not.toContain(hidden);
    expect(new TextDecoder().decode(saved)).not.toContain('SECOND-PRIVATE-841');
    expect(reopened.pages.every(page => !page.resources.has('Properties'))).toBe(true);
  });

  it('rejects a page resources dictionary reachable through another retained object', async () => {
    const doc = await multiPageFixture([input, input]);
    doc.pages[1].dict.set('CropBox', doc.pages[0].resources);
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, opts)).rejects.toThrow(/hidden layer|optional content/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it.each(['single page', 'multiple pages'] as const)(
    'refuses a hidden block that restores its outer graphics state too early on %s', async scope => {
      const leaking = input.replace('BDC q BT', 'BDC q Q 1 0 0 rg q BT');
      const doc = scope === 'single page' ? await fixture(leaking) : await multiPageFixture([leaking, input]);
      const before = await serializeDocument(doc);
      await expect(sanitizationEngine.sanitize(doc, opts)).rejects.toThrow(/hidden layer|optional content/i);
      expect(await serializeDocument(doc)).toEqual(before);
      expect(doc.requiresFullRewrite).toBeUndefined();
    },
  );

  it('allows a hidden block with nested graphics state fully contained by the outer save', async () => {
    const nested = input.replace('BDC q BT', 'BDC q q BT').replace('ET Q EMC', 'ET Q Q EMC');
    const doc = await fixture(nested);
    await sanitizationEngine.sanitize(doc, opts);
    const reopened = await parsePDF(await saveQuick(doc));
    const stream = reopened.objects.get(reopened.pages[0].contentRefs[0].toKey()) as PDFStream;
    expect(new TextDecoder().decode(stream.getBytes())).not.toContain(hidden);
  });
  it.each([
    ['retained content operand', '314159265', '314159265', undefined],
    ['retained content operand with leading zeroes', '000314159265', '000314159265', undefined],
    ['retained content operand with an explicit plus sign', '+314159265', '+314159265', undefined],
    ['retained decimal as exponent', '1e-7', '0.0000001', undefined],
    ['retained page number', '314159265', undefined, 314159265],
    ['writer-rounded page number', '0.12346', undefined, 0.123456],
    ['retained exponent as decimal', '0.0000001', undefined, 1e-7],
    ['short number colliding with ordinary geometry', '12', undefined, undefined],
  ])('refuses a hidden numeric value copied as %s without mutation', async (_name, secret, operand, pageNumber) => {
    let content = input.replace(hidden, secret);
    if (operand) content = content.replace('20 40 Tm', `${operand} 40 Tm`);
    const doc = await fixture(content);
    if (pageNumber !== undefined) {
      const box = doc.pages[0].dict.get('MediaBox') as PDFArray;
      box.items[2] = new PDFNumber(pageNumber);
    }
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, opts)).rejects.toThrow(/hidden layer|optional content/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
    const reopened = await parsePDF(await saveQuick(doc));
    expect(reopened.catalog.has('OCProperties')).toBe(true);
    const original = reopened.objects.get(reopened.pages[0].contentRefs[0].toKey()) as PDFStream;
    expect(new TextDecoder().decode(original.getBytes())).toContain(`(${secret}) Tj`);
  });

  it('refuses when the replacement stream length would reproduce a removed number', async () => {
    const [before, after] = input.split(`/OC /Hidden BDC q BT /F1 12 Tf 1 0 0 1 20 100 Tm (${hidden}) Tj ET Q EMC`);
    const secret = String(new TextEncoder().encode(before + after).length);
    const doc = await fixture(input.replace(hidden, secret));
    const original = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, opts)).rejects.toThrow(/hidden layer|optional content/i);
    expect(await serializeDocument(doc)).toEqual(original);
  });

  it('removes a numeric hidden value when no checked retained value matches', async () => {
    const secret = '987654321';
    const doc = await fixture(input.replace(hidden, secret));
    await sanitizationEngine.sanitize(doc, opts);
    const saved = await saveQuick(doc);
    expect(new TextDecoder().decode(saved)).not.toContain(secret);
    const reopened = await parsePDF(saved);
    expect(reopened.catalog.has('OCProperties')).toBe(false);
    const content = reopened.objects.get(reopened.pages[0].contentRefs[0].toKey()) as PDFStream;
    expect(new TextDecoder().decode(content.getBytes())).toContain('PUBLIC-ALPHA');
  });

  it('removes private text from the rewritten PDF and preserves the visible rendering', async () => {
    const before = await serializeDocument(await fixture());
    expect(new TextDecoder().decode(before)).toContain(hidden);
    const doc = await parsePDF(before);
    expect(new TextDecoder().decode(doc.rawBytes)).toContain(hidden);
    const result = await sanitizationEngine.sanitize(doc, opts);
    expect(result.detail.layersRemoved).toBe(1);
    expect(doc.requiresFullRewrite).toBe(true);
    const saved = await saveQuick(doc);
    const optimized = await saveOptimized(doc);
    expect(new TextDecoder().decode(optimized)).not.toContain(hidden);
    const text = new TextDecoder().decode(saved);
    expect(text).not.toContain(hidden);
    expect(text).toContain('PUBLIC-ALPHA');
    expect(text).toContain('PUBLIC-OMEGA');
    expect(text).not.toContain('/OCProperties');
    expect((await PDFDocument.load(saved)).getPageCount()).toBe(1);
    const reopened = await parsePDF(saved);
    expect(reopened.catalog.has('OCProperties')).toBe(false);
    if (spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).error) return;
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-hidden-layer-'));
    try {
      const a = join(dir, 'before.pdf'), b = join(dir, 'after.pdf');
      writeFileSync(a, before); writeFileSync(b, saved);
      execFileSync('pdftoppm', ['-r', '72', '-singlefile', a, join(dir, 'before')], { stdio: 'ignore' });
      execFileSync('pdftoppm', ['-r', '72', '-singlefile', b, join(dir, 'after')], { stdio: 'ignore' });
      expect(readFileSync(join(dir, 'after.ppm'))).toEqual(readFileSync(join(dir, 'before.ppm')));
      const extracted = execFileSync('pdftotext', [b, '-'], { encoding: 'utf8' });
      expect(extracted).toContain('PUBLIC-ALPHA'); expect(extracted).toContain('PUBLIC-OMEGA');
      expect(extracted).not.toContain(hidden);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['FlateDecode', 'Fl'])('safely removes hidden text from a verified %s stream and preserves visible output', async filter => {
    const original = await fixture();
    const page = original.pages[0];
    const ref = page.dict.getRef('Contents')!;
    const decoded = new TextEncoder().encode(input);
    const compressed = new Uint8Array(deflateSync(decoded));
    original.objects.set(ref.toKey(), new PDFStream(new PDFDict([
      ['Length', new PDFNumber(compressed.length)], ['Filter', new PDFName(filter)],
    ]), compressed, decoded));
    const before = await serializeDocument(original);
    const doc = await parsePDF(before);
    const result = await sanitizationEngine.sanitize(doc, opts);
    expect(result.detail.layersRemoved).toBe(1);
    const saved = await saveQuick(doc);
    const optimized = await saveOptimized(doc);
    expect(new TextDecoder().decode(optimized)).not.toContain(hidden);
    const reopened = await parsePDF(saved);
    const output = new TextDecoder().decode((reopened.objects.get(reopened.pages[0].contentRefs[0].toKey()) as PDFStream).getBytes());
    expect(output).toContain('PUBLIC-ALPHA'); expect(output).toContain('PUBLIC-OMEGA');
    expect(output).not.toContain(hidden);
    expect(new TextDecoder().decode(saved)).not.toContain(hidden);
    expect((await PDFDocument.load(saved)).getPageCount()).toBe(1);
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-hidden-flate-'));
    try {
      const a = join(dir, 'before.pdf'), b = join(dir, 'after.pdf');
      writeFileSync(a, before); writeFileSync(b, saved);
      if (!spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).error) {
        execFileSync('pdftoppm', ['-r', '72', '-singlefile', a, join(dir, 'before')], { stdio: 'ignore' });
        execFileSync('pdftoppm', ['-r', '72', '-singlefile', b, join(dir, 'after')], { stdio: 'ignore' });
        expect(readFileSync(join(dir, 'after.ppm'))).toEqual(readFileSync(join(dir, 'before.ppm')));
        const extracted = execFileSync('pdftotext', [b, '-'], { encoding: 'utf8' });
        expect(extracted).toContain('PUBLIC-ALPHA'); expect(extracted).toContain('PUBLIC-OMEGA');
        expect(extracted).not.toContain(hidden);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['corrupt checksum', 'trailing bytes', 'stale cache'] as const)('rejects %s in a compressed stream before mutation', async kind => {
    const doc = await fixture();
    const page = doc.pages[0];
    const ref = page.dict.getRef('Contents')!;
    const decoded = new TextEncoder().encode(input);
    let compressed = new Uint8Array(deflateSync(decoded));
    if (kind === 'corrupt checksum') compressed[compressed.length - 1] ^= 1;
    if (kind === 'trailing bytes') compressed = new Uint8Array([...compressed, 0, 1]);
    const cache = kind === 'stale cache' ? new TextEncoder().encode('stale') : null;
    doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([
      ['Length', new PDFNumber(compressed.length)], ['Filter', new PDFName('FlateDecode')],
    ]), compressed, cache));
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, opts)).rejects.toThrow(/hidden layer|optional content/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('removes the hidden text through the default Sanitize operation', async () => {
    const before = await serializeDocument(await fixture());
    const doc = await parsePDF(before);
    const result = await sanitizationEngine.sanitize(doc);
    expect(result.detail.layersRemoved).toBe(1);
    const saved = await saveQuick(doc);
    const text = new TextDecoder().decode(saved);
    expect(text).not.toContain(hidden);
    expect(text).toContain('PUBLIC-ALPHA');
  });

  it.each([
    ['unisolated graphics state', input.replace('BDC q BT', 'BDC BT').replace('ET Q EMC', 'ET EMC')],
    ['unknown operator', input.replace('ET Q EMC', 'ET /Im1 Do Q EMC')],
    ['duplicate visible text', input.replace('PUBLIC-OMEGA', hidden)],
    ['duplicate text split across visible operations', input.replace('(PUBLIC-OMEGA) Tj', '(CONFIDENTIAL-) Tj (729) Tj')],
    ['malformed string', input.replace(`(${hidden})`, `(${hidden}`)],
    ['unsupported text encoding', input.replace(`(${hidden})`, '(private\\351)')],
  ])('rejects %s without changing the original document', async (_name, content) => {
    const doc = await fixture(content);
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, opts)).rejects.toThrow(/hidden layer|optional content/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('rejects finalized signed bytes before mutating the live document', async () => {
    const doc = await fixture();
    doc.rawBytes = new TextEncoder().encode('%PDF /ByteRange [0 1 3 4] /Contents <AB>');
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, opts)).rejects.toThrow(/hidden layer|optional content/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
    expect(doc.catalog.has('OCProperties')).toBe(true);
  });

  it('rejects contradictory ON/OFF configuration without changing the document', async () => {
    const doc = await fixture();
    const properties = doc.catalog.getDict('OCProperties')!;
    const group = properties.getArray('OCGs')!.items[0];
    properties.getDict('D')!.set('ON', new PDFArray([group]));
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, opts)).rejects.toThrow(/hidden layer|optional content/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('refuses a copy of the removed layer name retained in metadata', async () => {
    const doc = await fixture();
    const info = doc.xref.trailerDict.getRef('Info')!;
    (doc.objects.get(info.toKey()) as PDFDict).set('Title', new PDFString('Hidden layer'));
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, opts)).rejects.toThrow(/hidden layer|optional content/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('refuses a copy of removed text retained as a metadata key', async () => {
    const doc = await fixture();
    const info = doc.xref.trailerDict.getRef('Info')!;
    const dictionary = doc.objects.get(info.toKey()) as PDFDict;
    dictionary.set(hidden, new PDFString('other'));
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, opts)).rejects.toThrow(/hidden layer|optional content/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('refuses a copy of removed text retained in metadata', async () => {
    const doc = await fixture();
    const info = doc.xref.trailerDict.getRef('Info')!;
    const dictionary = doc.objects.get(info.toKey()) as PDFDict;
    dictionary.set('Title', PDFString.fromText(hidden));
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, opts)).rejects.toThrow(/hidden layer|optional content/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });
  it('refuses split retained metadata without altering the original', async () => {
    const doc = await fixture();
    const info = doc.xref.trailerDict.getRef('Info')!;
    const dictionary = doc.objects.get(info.toKey()) as PDFDict;
    dictionary.set('Title', new PDFString('CONFIDENTIAL-'));
    dictionary.set('Author', new PDFString('729'));
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, opts)).rejects.toThrow(/cannot safely retain.*metadata/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
    const saved = await saveQuick(doc);
    const text = new TextDecoder().decode(saved);
    expect(text).toContain('CONFIDENTIAL-');
    expect(text).toContain('729');
    const reopened = await parsePDF(saved);
    const savedInfo = reopened.objects.get(reopened.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;
    expect(savedInfo.getString('Title')).toBe('CONFIDENTIAL-');
    expect(savedInfo.getString('Author')).toBe('729');
  });

  it('removes split metadata when metadata cleanup is requested', async () => {
    const doc = await fixture();
    const info = doc.xref.trailerDict.getRef('Info')!;
    const dictionary = doc.objects.get(info.toKey()) as PDFDict;
    dictionary.set('Title', new PDFString('CONFIDENTIAL-'));
    dictionary.set('Author', new PDFString('729'));
    await sanitizationEngine.sanitize(doc, { ...opts, metadata: true });
    const saved = await saveQuick(doc);
    const text = new TextDecoder().decode(saved);
    expect(text).not.toContain('CONFIDENTIAL-');
    expect(text).not.toContain('729');
  });

  it('retains provably non-textual standard metadata when requested', async () => {
    const doc = await fixture();
    const info = doc.xref.trailerDict.getRef('Info')!;
    const dictionary = doc.objects.get(info.toKey()) as PDFDict;
    dictionary.set('Trapped', new PDFName('False'));
    await sanitizationEngine.sanitize(doc, opts);
    const reopened = await parsePDF(await saveQuick(doc));
    const savedInfo = reopened.objects.get(reopened.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;
    expect(savedInfo.getName('Trapped')).toBe('False');
  });

});
