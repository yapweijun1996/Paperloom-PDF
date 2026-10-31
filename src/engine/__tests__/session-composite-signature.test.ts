import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas/node-canvas';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePDF } from '../parser/parser';
import { SessionDocumentEditor } from '../session/document-edit';
import { assertVisualSignatureAppearancePresent, findVisualSignatureRefs, placeVisualSignature, removeVisualSignature } from '../session/signature-edit';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, PDFString } from '../types';
import { serializeDocument } from '../writer/serializer';
import { renderPage } from '../render/renderer';
import { rawPDF } from './audit-p1-fixtures';
import { applySignatureFieldAppearance } from '../signatures/fields/appearance-stream';
import type { VisualSignature } from '../signatures/visual/visual-types';

const content = 'q 1 0 0 rg 10 20 20 40 re f BT /F1 5 Tf 11 25 Td (Alice Date) Tj ET Q';
const fixture = (mark = content) => {
  mark = `q 1 1 1 rg 10 20 20 40 re f Q ${mark}`;
  return rawPDF([
  '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] >> >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << >> /Annots [5 0 R] >>',
  `<< /Type /XObject /Subtype /Form /BBox [10 20 30 60] /Matrix [0 1 -1 0 60 -10] /Resources << /Font << /F1 6 0 R >> >> /Length ${mark.length} >>\nstream\n${mark}\nendstream`,
  '<< /Type /Annot /Subtype /Widget /FT /Sig /T (Sig) /Rect [100 100 300 180] /F 4 /PaperloomSignatureId (sig) /AP << /N 4 0 R >> >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
]); };
const signature: VisualSignature = { id: 'sig', pageIndex: 0, x: 110, y: 115, width: 200, height: 80,
  rotation: 0, opacity: 1, locked: false, appearanceType: 'typed', appearanceId: 'lib' };
function annotation(doc: Awaited<ReturnType<typeof parsePDF>>): PDFDict {
  const ref = findVisualSignatureRefs(doc, new Set(['sig'])).get('sig')!;
  return doc.objects.get(ref.toKey()) as PDFDict;
}

afterEach(() => vi.unstubAllGlobals());
describe('field signature composite appearance', () => {
  it('preserves the complete source and its resources across conversion, repeated edits and save', async () => {
    const doc = await parsePDF(fixture());
    const original = doc.objects.get('4_0') as PDFStream;
    const before = Array.from(original.rawBytes);
    const editor = new SessionDocumentEditor();
    await editor.edit(doc, 'move', staged => placeVisualSignature(staged, signature, ''));
    const stamp = annotation(doc);
    expect(stamp.getName('Subtype')).toBe('Stamp');
    const source = stamp.getRef('PaperloomCompositeAppearance')!;
    expect(source).toBeInstanceOf(PDFRef);
    const form = doc.objects.get(source.toKey()) as PDFStream;
    expect(Array.from(form.rawBytes)).toEqual(before);
    expect(form.dict.getArray('BBox')!.asNumbers()).toEqual([10, 20, 30, 60]);
    expect(form.dict.getArray('Matrix')!.asNumbers()).toEqual([0, 1, -1, 0, 60, -10]);
    expect(form.dict.getDict('Resources')!.getDict('Font')!.getRef('F1')).toEqual(new PDFRef(6, 0));
    expect((doc.objects.get('5_0') as PDFDict).has('AP')).toBe(false);
    expect(Array.from(original.rawBytes)).toEqual(before);
    await editor.edit(doc, 'move-again', staged => placeVisualSignature(staged, { ...signature, x: 120, rotation: 30 }, ''));
    expect(annotation(doc).getRef('PaperloomCompositeAppearance')).toEqual(source);
    const wrapper = doc.objects.get(annotation(doc).getDict('AP')!.getRef('N')!.toKey()) as PDFStream;
    const groupRef = wrapper.dict.getDict('Resources')!.getDict('XObject')!.getRef('PaperloomGroup')!;
    const group = doc.objects.get(groupRef.toKey()) as PDFStream;
    expect(group.dict.getDict('Resources')!.getDict('XObject')!.getRef('PaperloomSource')).toEqual(source);
    const reopened = await parsePDF(await serializeDocument(doc));
    expect(annotation(reopened).getRef('PaperloomCompositeAppearance')).toEqual(source);
    expect((reopened.objects.get(source.toKey()) as PDFStream).dict.getArray('BBox')!.asNumbers()).toEqual([10, 20, 30, 60]);
    expect(await editor.undo(doc)).toBe(true);
    expect(annotation(doc).getRef('PaperloomCompositeAppearance')).toEqual(source);
    expect(await editor.undo(doc)).toBe(true);
    expect(annotation(doc).getName('Subtype')).toBe('Widget');
  });

  it('keeps a shared original Form intact and fails closed for a missing composite source', async () => {
    const doc = await parsePDF(fixture());
    const original = doc.objects.get('4_0') as PDFStream;
    const originalBytes = original.rawBytes.slice();
    const sibling = new PDFDict([...((doc.objects.get('5_0') as PDFDict).entries())]);
    sibling.set('T', new PDFString('Sibling'));
    sibling.set('PaperloomSignatureId', new PDFString('sibling'));
    doc.objects.set('7_0', sibling);
    const annots = doc.pages[0].dict.getArray('Annots')!;
    annots.push(new PDFRef(7, 0));
    await new SessionDocumentEditor().edit(doc, 'move', staged => placeVisualSignature(staged, signature, ''));
    const preserved = doc.objects.get('7_0') as PDFDict;
    expect(preserved.getDict('AP')!.getRef('N')).toEqual(new PDFRef(4, 0));
    expect((doc.objects.get('4_0') as PDFStream).rawBytes).toEqual(originalBytes);
    const saved = await serializeDocument(doc);
    const draft = new SessionDocumentEditor();
    const missing = { ...signature, id: 'absent', requiresCompositeAppearance: true };
    await expect(draft.edit(doc, 'edit-missing', staged => placeVisualSignature(staged, missing, ''))).rejects.toThrow(/appearance is unavailable/i);
    expect(await serializeDocument(doc)).toEqual(saved);
    expect(draft.canUndo).toBe(false);
    expect(doc.pages[0].dict.get('Annots')).toBeInstanceOf(PDFArray);
  });

  it.each([[false, false], [true, false], [false, true], [true, true]])('rejects duplicate IDs on another page=%s with a stamp=%s', async (crossPage, stamp) => {
    const doc = await parsePDF(fixture());
    const sibling = new PDFDict([...((doc.objects.get('5_0') as PDFDict).entries())]);
    sibling.set('V', new PDFDict());
    if (stamp) {
      (doc.objects.get('5_0') as PDFDict).set('V', new PDFDict());
      sibling.set('Subtype', new PDFName('Stamp'));
      sibling.set('NM', new PDFString('sig'));
      sibling.delete('PaperloomSignatureId');
    }
    doc.objects.set('7_0', sibling);
    if (crossPage) {
      const page = { ...doc.pages[0], dict: new PDFDict([...doc.pages[0].dict.entries()]) };
      page.dict.set('Annots', new PDFArray([new PDFRef(7, 0)]));
      doc.pages.push(page);
    } else doc.pages[0].dict.getArray('Annots')!.push(new PDFRef(7, 0));
    const editor = new SessionDocumentEditor();
    await expect(editor.edit(doc, 'delete', async staged => removeVisualSignature(staged, 'sig'))).rejects.toThrow(/duplicate/i);
    await expect(editor.edit(doc, 'move', async staged => placeVisualSignature(staged, signature, ''))).rejects.toThrow(/duplicate/i);
    expect((doc.objects.get('5_0') as PDFDict).has('AP')).toBe(true);
    expect((doc.objects.get('7_0') as PDFDict).has('AP')).toBe(true);
    expect(editor.canUndo).toBe(false);
  });

  it.each(['missing annotation', 'stamp without source', 'stamp with broken source', 'widget without appearance'])(
    'rejects required composite deletion for %s atomically', async mode => {
      const doc = await parsePDF(fixture());
      const widget = doc.objects.get('5_0') as PDFDict;
      if (mode === 'missing annotation') widget.delete('PaperloomSignatureId');
      if (mode === 'widget without appearance') widget.delete('AP');
      if (mode.startsWith('stamp')) {
        widget.set('Subtype', new PDFName('Stamp'));
        widget.set('NM', new PDFString('sig'));
        widget.delete('PaperloomSignatureId');
        if (mode === 'stamp with broken source') widget.set('PaperloomCompositeAppearance', new PDFRef(999, 0));
      }
      const before = await serializeDocument(doc);
      const editor = new SessionDocumentEditor();
      await expect(editor.edit(doc, 'delete', async staged => removeVisualSignature(staged, 'sig', true))).rejects.toThrow();
      expect(await serializeDocument(doc)).toEqual(before);
      expect(editor.canUndo).toBe(false);
    },
  );

  it('allows valid composite deletion without creating a source copy and leaves unmarked missing IDs compatible', async () => {
    const doc = await parsePDF(fixture());
    const count = doc.objects.size;
    await new SessionDocumentEditor().edit(doc, 'delete', async staged => removeVisualSignature(staged, 'sig', true));
    expect((doc.objects.get('5_0') as PDFDict).has('AP')).toBe(false);
    expect(doc.objects.size).toBe(count);
    expect(() => removeVisualSignature(doc, 'missing')).not.toThrow();
    const other = await parsePDF(fixture());
    await new SessionDocumentEditor().edit(other, 'move', staged => placeVisualSignature(staged, signature, ''));
    await new SessionDocumentEditor().edit(other, 'delete', async staged => removeVisualSignature(staged, 'sig', true));
    expect(findVisualSignatureRefs(other, new Set(['sig'])).size).toBe(0);
  });

  it.skipIf(spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status !== 0)(
    'matches Poppler before and after conversion with a nonzero BBox and rotation matrix', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'paperloom-composite-'));
      try {
        const doc = await parsePDF(fixture());
        const before = await serializeDocument(doc);
        await new SessionDocumentEditor().edit(doc, 'move', staged => placeVisualSignature(staged, { ...signature, x: 100, y: 100 }, ''));
        const after = await serializeDocument(doc);
        const pixels = async (name: string, bytes: Uint8Array) => {
          const path = join(dir, name); writeFileSync(`${path}.pdf`, bytes);
          execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', '-png', `${path}.pdf`, path], { stdio: 'pipe' });
          const image = await loadImage(readFileSync(`${path}.png`));
          const canvas = createCanvas(400, 400); canvas.getContext('2d').drawImage(image, 0, 0);
          return canvas.getContext('2d').getImageData(90, 210, 220, 100).data;
        };
        const expected = await pixels('before', before), actual = await pixels('after', after);
        let total = 0;
        for (let i = 0; i < expected.length; i += 4) for (let c = 0; c < 3; c++) total += Math.abs(expected[i + c] - actual[i + c]);
        expect(total / (expected.length / 4 * 3)).toBeLessThan(1);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
  );

  it.skipIf(spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status !== 0)(
    'applies opacity once to overlapping marks, matching Poppler and the internal renderer', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'paperloom-composite-alpha-'));
      try {
        const doc = await parsePDF(fixture('1 0 0 rg 10 20 20 40 re f 0 1 0 rg 10 20 10 40 re f'));
        await new SessionDocumentEditor().edit(doc, 'opacity', staged => placeVisualSignature(staged, { ...signature, x: 100, y: 100, opacity: .5 }, ''));
        const bytes = await serializeDocument(doc);
        const path = join(dir, 'alpha'); writeFileSync(`${path}.pdf`, bytes);
        execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', '-png', `${path}.pdf`, path], { stdio: 'pipe' });
        const image = await loadImage(readFileSync(`${path}.png`));
        const reference = createCanvas(400, 400); reference.getContext('2d').drawImage(image, 0, 0);
        const ref = reference.getContext('2d').getImageData(0, 0, 400, 400).data;
        let red = 0, green = 0;
        for (let i = 0; i < ref.length; i += 4) {
          if (ref[i] > 245 && Math.abs(ref[i + 1] - 127) < 5 && Math.abs(ref[i + 2] - 127) < 5) red++;
          if (ref[i + 1] > 245 && Math.abs(ref[i] - 127) < 5 && Math.abs(ref[i + 2] - 127) < 5) green++;
        }
        expect(red).toBeGreaterThan(100); expect(green).toBeGreaterThan(100);
        vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) });
        const actual = await renderPage(await parsePDF(bytes), 0, { scale: 1, devicePixelRatio: 1, renderWidgets: 'supported' });
        const ours = actual.canvas.getContext('2d')!.getImageData(0, 0, 400, 400).data;
        let total = 0;
        for (let i = 0; i < ref.length; i += 4) for (let c = 0; c < 3; c++) total += Math.abs(ref[i + c] - ours[i + c]);
        expect(total / (ref.length / 4 * 3)).toBeLessThan(1);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
  );

  it('preserves app-generated white background, border, JPEG, name and date', async () => {
    const doc = await parsePDF(fixture());
    const image = createCanvas(2, 2).toBuffer('image/jpeg');
    applySignatureFieldAppearance(doc, new PDFRef(5, 0), {
      width: 200, height: 80, imageJpegBytes: image, imagePixelWidth: 2, imagePixelHeight: 2,
      typedName: 'Alice', date: '2026-10-31', backgroundColor: [1, 1, 1], borderWidth: 1,
    });
    await new SessionDocumentEditor().edit(doc, 'move', staged => placeVisualSignature(staged, signature, ''));
    const source = annotation(doc).getRef('PaperloomCompositeAppearance')!;
    const stream = doc.objects.get(source.toKey()) as PDFStream;
    const text = new TextDecoder().decode(stream.getBytes());
    expect(text).toContain('(Alice)'); expect(text).toContain('(Date: 2026-10-31)');
    expect(text).toContain('/Im1 Do'); expect(text).toContain(' re S');
    expect(() => assertVisualSignatureAppearancePresent(doc, signature)).not.toThrow();
  });

  it.each(['byte-limit', 'instruction-limit', 'nested-arrays', 'jpeg-size-mismatch'])(
    'bounds inspection and rejects %s atomically', async mode => {
      const doc = await parsePDF(fixture());
      let stream = doc.objects.get('4_0') as PDFStream;
      if (mode === 'jpeg-size-mismatch') {
        const image = createCanvas(2, 2).toBuffer('image/jpeg');
        const ref = applySignatureFieldAppearance(doc, new PDFRef(5, 0), {
          width: 200, height: 80, imageJpegBytes: image, imagePixelWidth: 3, imagePixelHeight: 2,
          typedName: 'Alice', backgroundColor: [1, 1, 1],
        });
        stream = doc.objects.get(ref.toKey()) as PDFStream;
      } else {
        const extra = mode === 'byte-limit' ? ' '.repeat(1024 * 1024) :
          mode === 'instruction-limit' ? '0 0 0 rg '.repeat(8193) : '['.repeat(5000);
        stream.rawBytes = new TextEncoder().encode(`q 1 1 1 rg 10 20 20 40 re f ${extra} Q`);
        stream.decodedBytes = null; stream.dict.set('Length', new PDFNumber(stream.rawBytes.length));
      }
      if (mode === 'byte-limit') expect(stream.rawBytes.length).toBeGreaterThan(1024 * 1024);
      const before = await serializeDocument(doc), editor = new SessionDocumentEditor();
      const edit = editor.edit(doc, 'move', staged => placeVisualSignature(staged, signature, ''));
      if (mode === 'byte-limit') await expect(edit).rejects.toThrow('Signature appearance cannot be safely preserved.');
      else await expect(edit).rejects.toThrow();
      const after = await serializeDocument(doc);
      // Vitest's recursive typed-array comparison scales poorly on 1 MiB input;
      // Buffer.equals checks every byte in native code without changing coverage.
      expect(Buffer.from(after).equals(Buffer.from(before))).toBe(true);
      expect(editor.canUndo).toBe(false);
    },
  );

  it('checks original AP presence without blocking signed, read-only, or complex Forms', async () => {
    const doc = await parsePDF(fixture());
    const widget = doc.objects.get('5_0') as PDFDict;
    widget.set('V', new PDFDict()); widget.set('Ff', new PDFNumber(1));
    (doc.objects.get('4_0') as PDFStream).dict.set('Group', new PDFDict([['S', new PDFName('Transparency')]]));
    expect(() => assertVisualSignatureAppearancePresent(doc, signature)).not.toThrow();
    widget.delete('AP');
    expect(() => assertVisualSignatureAppearancePresent(doc, signature)).toThrow();
  });

  it('rejects stale page associations during conversion, deletion and presence checks', async () => {
    const doc = await parsePDF(fixture());
    const other = { ...doc.pages[0], dict: new PDFDict([...doc.pages[0].dict.entries()]) };
    other.dict.set('Annots', new PDFArray()); doc.pages.push(other);
    const before = await serializeDocument(doc), editor = new SessionDocumentEditor();
    await expect(editor.edit(doc, 'move', staged => placeVisualSignature(staged, { ...signature, pageIndex: 1 }, ''))).rejects.toThrow(/recorded page/i);
    await expect(editor.edit(doc, 'delete', async staged => removeVisualSignature(staged, 'sig', true, 1))).rejects.toThrow(/recorded page/i);
    expect(() => assertVisualSignatureAppearancePresent(doc, { ...signature, pageIndex: 1 })).toThrow(/recorded page/i);
    expect(await serializeDocument(doc)).toEqual(before); expect(editor.canUndo).toBe(false);
  });

  it.each(['group','multiply','multiply-after-background','missing-font','type3','missing-image','nested-form','mask','unknown-filter','malformed','no-background','incomplete-background'])(
    'rejects unsafe appearance %s without changing the PDF', async mode => {
      const doc = await parsePDF(fixture());
      const stream = doc.objects.get('4_0') as PDFStream;
      const resources = stream.dict.getDict('Resources')!;
      const setContent = (str: string) => { stream.rawBytes = new TextEncoder().encode(str); stream.decodedBytes = null; stream.dict.set('Length', new PDFNumber(stream.rawBytes.length)); };
      if (mode === 'group') stream.dict.set('Group', new PDFDict([['S', new PDFName('Transparency')]]));
      if (mode === 'multiply' || mode === 'multiply-after-background') {
        const group = new PDFDict([['M', new PDFDict([['BM', new PDFName('Multiply')], ['ca', new PDFNumber(.5)]])]]);
        resources.set('ExtGState', group);
        setContent(`${mode === 'multiply-after-background' ? 'q 1 1 1 rg 10 20 20 40 re f Q ' : ''}q /M gs 1 0 0 rg 10 20 20 40 re f 0 0 1 rg 20 20 10 40 re f Q`);
        const bytes = new TextEncoder().encode('0.9 0.7 0.2 rg 0 0 400 400 re f');
        doc.objects.set('8_0', new PDFStream(new PDFDict([['Length', new PDFNumber(bytes.length)]]), bytes, bytes));
        doc.pages[0].dict.set('Contents', new PDFRef(8, 0)); doc.pages[0].contentRefs = [new PDFRef(8, 0)];
      }
      if (mode === 'missing-font') resources.getDict('Font')!.set('F1', new PDFRef(999, 0));
      if (mode === 'type3') (doc.objects.get('6_0') as PDFDict).set('Subtype', new PDFName('Type3'));
      if (mode === 'missing-image' || mode === 'nested-form' || mode === 'mask') {
        const xobjects = new PDFDict();
        xobjects.set('Im', mode === 'missing-image' ? new PDFRef(999, 0) : new PDFRef(4, 0));
        if (mode === 'mask') {
          const imgDict = new PDFDict([['Type', new PDFName('XObject')], ['Subtype', new PDFName('Image')],
            ['Width', new PDFNumber(1)], ['Height', new PDFNumber(1)], ['BitsPerComponent', new PDFNumber(8)],
            ['ColorSpace', new PDFName('DeviceRGB')], ['Filter', new PDFName('DCTDecode')], ['SMask', new PDFRef(999, 0)]]);
          doc.objects.set('7_0', new PDFStream(imgDict, new Uint8Array())); xobjects.set('Im', new PDFRef(7, 0));
        }
        resources.set('XObject', xobjects); setContent('q 1 1 1 rg 10 20 20 40 re f /Im Do Q');
      }
      if (mode === 'unknown-filter') stream.dict.set('Filter', new PDFName('LZWDecode'));
      if (mode === 'malformed') setContent('q 1 1 1 rg 10 20 20 40 re f [[[[ Q');
      if (mode === 'no-background') setContent('q BT /F1 5 Tf 11 25 Td (Alice) Tj ET Q');
      if (mode === 'incomplete-background') setContent('q 1 1 1 rg 10 20 5 5 re f Q');
      const before = await serializeDocument(doc), editor = new SessionDocumentEditor();
      await expect(editor.edit(doc, 'move', staged => placeVisualSignature(staged, signature, ''))).rejects.toThrow();
      expect(await serializeDocument(doc)).toEqual(before); expect(editor.canUndo).toBe(false);
    },
  );

  it.each(['missing-id','missing-ap','dangling-font','missing-canonical','detached-canonical'])(
    'detects required appearance integrity failure: %s', async mode => {
      const doc = await parsePDF(fixture());
      const widget = doc.objects.get('5_0') as PDFDict;
      if (mode === 'missing-id') widget.delete('PaperloomSignatureId');
      if (mode === 'missing-ap') widget.delete('AP');
      if (mode === 'dangling-font') (doc.objects.get('4_0') as PDFStream).dict.getDict('Resources')!.getDict('Font')!.set('F1', new PDFRef(999, 0));
      if (mode === 'missing-canonical' || mode === 'detached-canonical') {
        await new SessionDocumentEditor().edit(doc, 'move', staged => placeVisualSignature(staged, signature, ''));
        const stamp = annotation(doc);
        if (mode === 'missing-canonical') stamp.set('PaperloomCompositeAppearance', new PDFRef(999, 0));
        else stamp.set('PaperloomCompositeAppearance', new PDFRef(4, 0));
      }
      const before = await serializeDocument(doc);
      expect(() => assertVisualSignatureAppearancePresent(doc, signature)).toThrow();
      expect(await serializeDocument(doc)).toEqual(before);
    },
  );

  it.each(['empty-ap','q-q-ap','wrong-name','extra-op','empty-group','q-q-group','wrong-source','changed-matrix','wrong-opacity','wrong-bbox','wrong-rect','non-isolated','extra-resource','compressed-wrapper'])(
    'rejects tampered composite wrapper %s without mutating the document', async mode => {
      const doc = await parsePDF(fixture()), placed = { ...signature, x: 100, y: 100, rotation: 37, opacity: .5 };
      await new SessionDocumentEditor().edit(doc, 'move', staged => placeVisualSignature(staged, placed, ''));
      const stamp = annotation(doc), ap = doc.objects.get(stamp.getDict('AP')!.getRef('N')!.toKey()) as PDFStream;
      const resources = ap.dict.getDict('Resources')!;
      const group = doc.objects.get(resources.getDict('XObject')!.getRef('PaperloomGroup')!.toKey()) as PDFStream;
      const setContent = (stream: PDFStream, text: string) => { stream.rawBytes = new TextEncoder().encode(text); stream.decodedBytes = null; stream.dict.set('Length', new PDFNumber(stream.rawBytes.length)); };
      if (mode === 'empty-ap') setContent(ap, '');
      if (mode === 'q-q-ap') setContent(ap, 'q Q\n');
      if (mode === 'wrong-name') setContent(ap, 'q /PaperloomOpacity gs /Wrong Do Q\n');
      if (mode === 'extra-op') setContent(ap, 'q /PaperloomOpacity gs /PaperloomGroup Do /PaperloomGroup Do Q\n');
      if (mode === 'empty-group') setContent(group, '');
      if (mode === 'q-q-group') setContent(group, 'q Q\n');
      if (mode === 'wrong-source') setContent(group, new TextDecoder().decode(group.rawBytes).replace('/PaperloomSource', '/Other'));
      if (mode === 'changed-matrix') setContent(group, new TextDecoder().decode(group.rawBytes).replace(' cm ', ' 2 0 0 2 0 0 cm '));
      if (mode === 'wrong-opacity') resources.getDict('ExtGState')!.getDict('PaperloomOpacity')!.set('ca', new PDFNumber(1));
      if (mode === 'wrong-bbox') ap.dict.set('BBox', new PDFArray([0, 0, 1, 1].map(n => new PDFNumber(n))));
      if (mode === 'wrong-rect') stamp.set('Rect', new PDFArray([0, 0, 1, 1].map(n => new PDFNumber(n))));
      if (mode === 'non-isolated') group.dict.getDict('Group')!.delete('I');
      if (mode === 'extra-resource') resources.getDict('XObject')!.set('Other', stamp.getRef('PaperloomCompositeAppearance')!);
      if (mode === 'compressed-wrapper') ap.dict.set('Filter', new PDFName('FlateDecode'));
      const before = await serializeDocument(doc);
      expect(() => assertVisualSignatureAppearancePresent(doc, placed)).toThrow();
      expect(await serializeDocument(doc)).toEqual(before);
    },
  );

  it.each([[0,1],[37,.5],[90,.25],[270,0]])('validates saved/recovered composite rotation=%s opacity=%s', async (rotation, opacity) => {
    const doc = await parsePDF(fixture());
    const original = doc.objects.get('4_0') as PDFStream;
    original.rawBytes = new TextEncoder().encode(new TextDecoder().decode(original.rawBytes).replace('10 20 20 40 re f', '0 0 100 100 re f'));
    original.decodedBytes = null; original.dict.set('Length', new PDFNumber(original.rawBytes.length));
    original.dict.set('BBox', new PDFArray([10.12345678,20.12345678,30.3456789,60.456789].map(n => new PDFNumber(n))));
    original.dict.set('Matrix', new PDFArray([.9833333333,.123456789,-.223456789,1.23456789,-17.54321987,9.12345678].map(n => new PDFNumber(n))));
    const placed = { ...signature, x: 100.1234567, y: 100.7654321, rotation, opacity };
    await new SessionDocumentEditor().edit(doc, 'move', staged => placeVisualSignature(staged, placed, ''));
    expect(() => assertVisualSignatureAppearancePresent(doc, placed)).not.toThrow();
    const recovered = await parsePDF(await serializeDocument(doc));
    expect(() => assertVisualSignatureAppearancePresent(recovered, placed)).not.toThrow();
  });

  it.each(['signed', 'readonly', 'parent-signed', 'parent-readonly', 'bad-parent', 'bad-value', 'bad-type', 'bad-ap', 'bad-geometry', 'bad-opacity'])(
    'rejects %s atomically', async mode => {
      const doc = await parsePDF(fixture());
      const widget = doc.objects.get('5_0') as PDFDict;
      if (mode === 'signed') widget.set('V', new PDFDict());
      if (mode === 'readonly') widget.set('Ff', new PDFNumber(1));
      if (mode === 'bad-parent') widget.set('Parent', new PDFRef(999, 0));
      if (mode === 'bad-value') widget.set('V', new PDFString('unknown'));
      if (mode === 'bad-type') widget.set('FT', new PDFName('Tx'));
      if (mode === 'bad-ap') widget.set('AP', new PDFDict());
      if (mode === 'bad-geometry') (doc.objects.get('4_0') as PDFStream).dict.delete('BBox');
      if (mode === 'parent-signed' || mode === 'parent-readonly') {
        const parent = new PDFDict();
        parent.set('FT', new PDFName('Sig'));
        parent.set(mode === 'parent-signed' ? 'V' : 'Ff', mode === 'parent-signed' ? new PDFDict() : new PDFNumber(1));
        doc.objects.set('7_0', parent); widget.set('Parent', new PDFRef(7, 0));
        widget.delete('FT');
      }
      const before = await serializeDocument(doc);
      const editor = new SessionDocumentEditor();
      await expect(editor.edit(doc, 'move', staged => placeVisualSignature(staged, { ...signature, opacity: mode === 'bad-opacity' ? 2 : 1 }, ''))).rejects.toThrow();
      expect(await serializeDocument(doc)).toEqual(before);
      expect(editor.canUndo).toBe(false);
      if (['signed', 'readonly', 'parent-signed', 'parent-readonly', 'bad-parent', 'bad-value', 'bad-type'].includes(mode)) {
        await expect(editor.edit(doc, 'delete', async staged => removeVisualSignature(staged, 'sig'))).rejects.toThrow();
        expect(await serializeDocument(doc)).toEqual(before);
      }
    },
  );
});
