import { describe, it, expect } from 'vitest';
import { parsePDF, getPageContentBytes } from '../parser/parser';
import { interpretPage } from '../content/interpreter';
import { buildDocumentFlow } from '../flow';
import { parseAcroFormCatalog, detectFormFieldsOnPage } from '../forms/detect-fields';
import { parseSoftMask, effectiveAlpha } from '../render/soft-mask';
import { parseTilingPattern, isPatternColorSpace } from '../render/patterns';
import { applyLigatures, shapeGlyphIdsWithLigatures } from '../fonts/gsub';
import { parseMft2Table, transformDeviceToPCS, transformPCSToDevice } from '../color/icc-lut';
import { parseGPOSPairAdjustments } from '../fonts/gpos';
import { setFormFieldValue } from '../forms/apply-field';
import { parseICCProfile } from '../color/icc-profile';
import type { TextRun } from '../content/interpreter';
import {
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFArray,
  PDFString,
  type PDFDocumentData,
} from '../types';

const MINIMAL_PDF = new TextEncoder().encode(
  '%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>\nendobj\n4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000219 00000 n \ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n268\n%%EOF\n',
);

function mockTextRun(text: string): TextRun {
  return {
    type: 'text',
    text,
    fontName: 'F1',
    fontSize: 12,
    fillColor: [0, 0, 0],
    fillAlpha: 1,
    blendMode: 'Normal',
    softMask: null,
    clipPaths: [],
    textMatrix: { a: 12, b: 0, c: 0, d: 12, e: 72, f: 720 },
    glyphs: [{
      unicode: text,
      charCode: text.charCodeAt(0),
      x: 72,
      y: 720,
      width: text.length * 6,
      fontSize: 12,
      textSpaceWidth: 0.5,
      tRm: { a: 12, b: 0, c: 0, d: 12, e: 72, f: 720 },
    }],
    x: 72,
    y: 708,
    width: text.length * 6,
    height: 12,
  };
}

function buildFormDocument(): PDFDocumentData {
  const pageRef = new PDFRef(3, 0);
  const widgetRef = new PDFRef(7, 0);
  const fieldRef = widgetRef;

  const pageDict = new PDFDict();
  pageDict.set('Type', new PDFName('Page'));
  pageDict.set('Parent', new PDFRef(2, 0));
  pageDict.set('MediaBox', new PDFArray([
    new PDFNumber(0), new PDFNumber(0), new PDFNumber(612), new PDFNumber(792),
  ]));
  pageDict.set('Annots', new PDFArray([widgetRef]));

  const widgetDict = new PDFDict();
  widgetDict.set('Subtype', new PDFName('Widget'));
  widgetDict.set('FT', new PDFName('Tx'));
  widgetDict.set('T', new PDFString('name'));
  widgetDict.set('P', pageRef);
  widgetDict.set('Rect', new PDFArray([
    new PDFNumber(100), new PDFNumber(100), new PDFNumber(300), new PDFNumber(120),
  ]));
  widgetDict.set('V', new PDFString('Jane Doe'));

  const acroDict = new PDFDict();
  acroDict.set('Fields', new PDFArray([fieldRef]));

  const catalog = new PDFDict();
  catalog.set('Type', new PDFName('Catalog'));
  catalog.set('Pages', new PDFRef(2, 0));
  catalog.set('AcroForm', acroDict);

  const objects = new Map<string, import('../types').PDFObject>();
  objects.set('1_0', catalog);
  objects.set('3_0', pageDict);
  objects.set('7_0', widgetDict);
  objects.set('acro_0', acroDict);

  return {
    version: '1.7',
    objects,
    xref: { entries: new Map(), trailerDict: new PDFDict() },
    catalog,
    pages: [{
      index: 0,
      ref: pageRef,
      dict: pageDict,
      mediaBox: { x: 0, y: 0, width: 612, height: 792 },
      cropBox: { x: 0, y: 0, width: 612, height: 792 },
      rotate: 0,
      resources: new PDFDict(),
      contentRefs: [],
    }],
    info: {},
    rawBytes: new Uint8Array(0),
  };
}

describe('integration roundtrip', () => {
  it('parse → interpret empty page', async () => {
    const doc = await parsePDF(MINIMAL_PDF);
    expect(doc.pages.length).toBe(1);

    const page = doc.pages[0];
    const content = getPageContentBytes(page, doc.objects);
    const interpreted = interpretPage(content, page, doc.objects);
    expect(interpreted.displayList).toBeDefined();
  });

  it('flow builds lines from text runs', () => {
    const runs = [mockTextRun('Hello PDF')];
    const flow = buildDocumentFlow(runs);
    expect(flow.lines.length).toBeGreaterThan(0);
    expect(flow.lines.some((line) => line.text.includes('Hello'))).toBe(true);
  });

  it('detects AcroForm widgets on page', () => {
    const doc = buildFormDocument();
    const catalog = parseAcroFormCatalog(doc);
    expect(catalog).not.toBeNull();
    expect(catalog!.fields.length).toBe(1);

    const widgets = detectFormFieldsOnPage(doc, 0);
    expect(widgets.length).toBe(1);
    expect(widgets[0].fieldName).toBe('name');
    expect(widgets[0].value).toBe('Jane Doe');
  });
});

describe('priority modules', () => {
  it('resolves soft mask alpha', () => {
    const dict = new PDFDict();
    dict.set('S', new PDFName('Luminosity'));
    dict.set('BC', new PDFArray([new PDFNumber(1), new PDFNumber(1), new PDFNumber(1)]));
    const info = parseSoftMask(dict);
    expect(info.subtype).toBe('Luminosity');
    expect(effectiveAlpha(1, dict)).toBeLessThan(1);
    expect(effectiveAlpha(1, null)).toBe(1);
  });

  it('identifies pattern color spaces', () => {
    expect(isPatternColorSpace('Pattern')).toBe(true);
    expect(isPatternColorSpace('DeviceRGB')).toBe(false);
    expect(parseTilingPattern(new PDFName('P1'), new Map())).toBeNull();
  });

  it('applies ligature substitution', () => {
    const rules = [{ components: [2, 3], ligatureGlyphId: 99 }];
    const ids = applyLigatures([1, 2, 3, 4], rules);
    expect(ids).toEqual([99, 4]);

    const shaped = shapeGlyphIdsWithLigatures([1, 2, 3], ['f', 'i', 'l'], rules);
    expect(shaped).toEqual([{ glyphId: 99, unicode: 'fil' }]);
  });

  it('parses mft2 table header', () => {
    const tag = new Uint8Array(64);
    tag[4] = 'm'.charCodeAt(0);
    tag[5] = 'f'.charCodeAt(0);
    tag[6] = 't'.charCodeAt(0);
    tag[7] = '2'.charCodeAt(0);
    tag[8] = 3;
    tag[9] = 3;
    tag[10] = 2;
    tag[11] = 2;
    tag[12] = 2;
    const table = parseMft2Table(tag);
    expect(table?.info.type).toBe('mft2');
    expect(table?.info.inputChannels).toBe(3);
  });

  it('GPOS pair adjustments returns array', () => {
    expect(parseGPOSPairAdjustments({
      tables: new Map(),
      rawData: new Uint8Array(0),
    } as import('../fonts/truetype-parser').TTFFont)).toEqual([]);
  });

  it('setFormFieldValue updates widget dict', () => {
    const doc = buildFormDocument();
    const widget = detectFormFieldsOnPage(doc, 0)[0];
    setFormFieldValue(doc, widget, 'Updated');
    expect(widget.value).toBe('Updated');
  });

  it('transforms ICC colors with sRGB fallback', () => {
    const header = new Uint8Array(132);
    header[8] = 2;
    const profile = parseICCProfile(header);
    expect(profile).not.toBeNull();
    const pcs = transformDeviceToPCS(profile!, [0.5, 0.5, 0.5]);
    expect(pcs.length).toBe(3);
    const device = transformPCSToDevice(profile!, pcs, 3);
    expect(device[0]).toBeCloseTo(0.5, 1);
  });
});
