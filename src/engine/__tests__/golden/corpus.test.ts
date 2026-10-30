import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvas, ImageData, loadImage } from '@napi-rs/canvas/node-canvas';
import { PDFDocument, StandardFonts, TextRenderingMode, beginText, endText, moveText, rgb, setFontAndSize, setTextRenderingMode, showText } from 'pdf-lib';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPageContentBytes, parsePDF } from '../../parser/parser';
import { renderPage } from '../../render/renderer';
import { findAndReplace } from '../../editor/text-editor';
import { updatePageContent } from '../../editor/stream-compiler';
import { detectFormFieldsOnPage } from '../../forms/detect-fields';
import { setFormFieldValue } from '../../forms/apply-field';
import { rotatePageBy } from '../../writer/page-operations';
import { serializeDocument } from '../../writer/serializer';
import { saveQuick } from '../../writer/save-pipeline';
import { signDocumentTransaction } from '../../session/signature-transaction';
import { detectSignatureFieldsOnPage, importFromPem } from '../../signatures';
import { validateDocumentSignatures } from '../../signatures/validation/validation-engine';
import { getTestCredentials } from '../signatures/test-credentials';

const hasPoppler = spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status === 0;

async function syntheticFixture(kind: 'text' | 'image' | 'form' | 'scan') {
  const source = await PDFDocument.create();
  const page = source.addPage([200, 160]);
  const font = await source.embedFont(StandardFonts.Helvetica);
  page.drawRectangle({ x: 10, y: 10, width: 40, height: 30, color: rgb(1, 0, 0) });
  page.drawText('Corpus original', { x: 20, y: 125, size: 12, font });
  if (kind === 'image' || kind === 'scan') {
    const canvas = createCanvas(16, 16);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 0, 16, 16);
    const image = await source.embedPng(canvas.toBuffer('image/png'));
    page.drawImage(image, { x: 100, y: 20, width: 50, height: 40 });
  }
  if (kind === 'scan') {
    const fontName = page.node.newFontDictionary(font.name, font.ref);
    page.pushOperators(beginText(), setFontAndSize(fontName, 12), moveText(25, 90),
      setTextRenderingMode(TextRenderingMode.Invisible), showText(font.encodeText('Synthetic OCR layer')), endText());
  }
  if (kind === 'form') {
    const field = source.getForm().createTextField('corpus.name');
    field.addToPage(page, { x: 70, y: 60, width: 100, height: 25, font });
    field.setText('Before');
  }
  return source.save({ useObjectStreams: false });
}

function installCanvas() {
  vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), { style: {} }) });
  vi.stubGlobal('ImageData', ImageData);
  vi.stubGlobal('OffscreenCanvas', function (width: number, height: number) { return createCanvas(width, height); });
}

afterEach(() => vi.unstubAllGlobals());

describe('synthetic cross-reader PDF corpus', () => {
  it.skipIf(!hasPoppler || spawnSync('openssl', ['version'], { stdio: 'ignore' }).status !== 0 ||
    spawnSync('pdfsig', ['-v'], { stdio: 'ignore' }).status !== 0)(
    'edits, signs, saves and independently verifies a signed fixture', async () => {
      const doc = await parsePDF(await syntheticFixture('text'));
      const page = doc.pages[0];
      const edit = findAndReplace(getPageContentBytes(page, doc.objects), page, doc.objects, 'original', 'signed', true);
      expect(edit.replacedCount).toBe(1);
      await updatePageContent(page.contentRefs, edit.newContentBytes, doc.objects);
      rotatePageBy(doc, 0, 90);
      const credentials = getTestCredentials();
      const identity = await importFromPem(credentials.pem, 'test');
      const signed = await signDocumentTransaction(doc, {
        pageIndex: 0, selectedFieldId: null, point: { x: 70, y: 70 },
        privateKey: identity.key!.privateKey, signOptions: { certificateDer: credentials.certificateDer }, isCurrent: () => true,
      });
      const output = await saveQuick(doc);
      expect(output).toEqual(signed.result.bytes);
      const reopened = await parsePDF(output);
      expect(reopened.pages[0].rotate).toBe(90);
      expect(detectSignatureFieldsOnPage(reopened, 0).some(field => field.signed)).toBe(true);
      expect((await validateDocumentSignatures(reopened)).signatures[0].digestMatch).toBe(true);
      expect((await PDFDocument.load(output)).getPage(0).getRotation().angle).toBe(90);
      const directory = mkdtempSync(join(tmpdir(), 'paperloom-signed-corpus-'));
      try {
        const file = join(directory, 'signed.pdf');
        writeFileSync(file, output);
        expect(execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' })).toContain('Corpus signed');
        expect(execFileSync('pdfsig', [file], { encoding: 'utf8' })).toMatch(/Signature is Valid/i);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }, 30_000,
  );
  it.skipIf(!hasPoppler).each(['text', 'image', 'form', 'scan'] as const)(
    'opens, edits, saves and independently renders the %s fixture', async kind => {
      const doc = await parsePDF(await syntheticFixture(kind));
      expect(doc.pages).toHaveLength(1);
      const page = doc.pages[0];
      const content = getPageContentBytes(page, doc.objects);
      const edit = findAndReplace(content, page, doc.objects, 'original', 'updated', true);
      expect(edit.replacedCount).toBe(1);
      await updatePageContent(page.contentRefs, edit.newContentBytes, doc.objects);
      if (kind === 'form') {
        const widget = detectFormFieldsOnPage(doc, 0)[0];
        expect(widget).toBeDefined();
        setFormFieldValue(doc, widget, 'After');
      }
      rotatePageBy(doc, 0, 90);
      const output = await serializeDocument(doc);
      const reopened = await parsePDF(output);
      expect(reopened.pages[0].rotate).toBe(90);
      const independent = await PDFDocument.load(output);
      expect(independent.getPage(0).getRotation().angle).toBe(90);
      if (kind === 'form') expect(independent.getForm().getTextField('corpus.name').getText()).toBe('After');

      const directory = mkdtempSync(join(tmpdir(), 'paperloom-corpus-'));
      try {
        const file = join(directory, `${kind}.pdf`), imagePrefix = join(directory, 'reference');
        writeFileSync(file, output);
        const text = execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' });
        expect(text).toContain('Corpus updated');
        expect(text).not.toContain('Corpus original');
        if (kind === 'scan') expect(text).toContain('Synthetic OCR layer');
        execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', '-png', file, imagePrefix], { stdio: 'pipe' });
        const reference = await loadImage(readFileSync(`${imagePrefix}.png`));
        installCanvas();
        const actual = (await renderPage(reopened, 0, { scale: 1, devicePixelRatio: 1, renderWidgets: true })).canvas;
        expect([actual.width, actual.height]).toEqual([reference.width, reference.height]);
        const referenceCanvas = createCanvas(reference.width, reference.height);
        referenceCanvas.getContext('2d').drawImage(reference, 0, 0);
        const classify = (rgba: Uint8ClampedArray) => {
          if (rgba[0] > 245 && rgba[1] > 245 && rgba[2] > 245) return 'white';
          if (rgba[0] > 245 && rgba[1] < 10 && rgba[2] < 10) return 'red';
          if (rgba[0] < 10 && rgba[1] < 10 && rgba[2] > 245) return 'blue';
          return null;
        };
        const actualContext = actual.getContext('2d')!;
        const referenceContext = referenceCanvas.getContext('2d');
        if (kind === 'scan') {
          // The OCR layer uses Tr 3 and lies over a white patch. Its text must
          // remain extractable without becoming visible after save/reopen.
          const referencePatch = referenceContext.getImageData(88, 20, 18, 110).data;
          const actualPatch = actualContext.getImageData(88, 20, 18, 110).data;
          for (let i = 0; i < referencePatch.length; i += 4) {
            if (referencePatch[i] > 250 && referencePatch[i + 1] > 250 && referencePatch[i + 2] > 250) {
              expect([actualPatch[i], actualPatch[i + 1], actualPatch[i + 2]]).toEqual([255, 255, 255]);
            }
          }
        }
        const counts = { white: 0, red: 0, blue: 0 };
        for (let y = 2; y < actual.height - 2; y += 3) for (let x = 2; x < actual.width - 2; x += 3) {
          const expected = classify(referenceContext.getImageData(x, y, 1, 1).data);
          const observed = classify(actualContext.getImageData(x, y, 1, 1).data);
          // Poppler and Canvas round the last edge pixel differently. Sample
          // reference interiors to avoid treating that boundary as content loss.
          const interior = expected && [[-2, 0], [2, 0], [0, -2], [0, 2]].every(([dx, dy]) =>
            classify(referenceContext.getImageData(x + dx, y + dy, 1, 1).data) === expected);
          if (interior && expected && observed) { expect(observed).toBe(expected); counts[expected]++; }
        }
        expect(counts.white).toBeGreaterThan(100);
        expect(counts.red).toBeGreaterThan(30);
        if (kind === 'image' || kind === 'scan') expect(counts.blue).toBeGreaterThan(30);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }, 30_000);
});
