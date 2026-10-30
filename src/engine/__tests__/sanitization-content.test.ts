import { installSignatureBase } from '../signatures/crypto/signing-pipeline';
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName as LibName, PDFDict as LibDict } from 'pdf-lib';
import { parsePDF } from '../parser/parser';
import { updatePageContent } from '../editor/stream-compiler';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, PDFString } from '../types';
import { sanitizationEngine } from '../security/sanitization/sanitization-engine';
import { javaScriptSecurityEngine } from '../security/javascript/javascript-engine';
import { serializeDocument } from '../writer/serializer';
import { saveQuick, SignedDocumentEditError } from '../writer/save-pipeline';
import { createSignatureField, importFromPem, signDocumentCryptographic, validateDocumentSignatures } from '../signatures';
import { getTestCredentials } from './signatures/test-credentials';
import { deflateSync } from 'node:zlib';

const noCleanup = {
  metadata: false, javascript: false, embeddedFiles: false, comments: false,
  annotations: false, unusedObjects: false, hiddenLayers: false, alternativeImages: false,
};
async function fixture() {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]).drawText('Visible document text');
  return parsePDF(await pdf.save({ useObjectStreams: false }));
}

describe('sanitization content boundaries', () => {
  it.each(['direct', 'indirect'] as const)('refuses a shared %s comment content without mutation', async mode => {
    const doc = await fixture();
    const text = new PDFString('PRIVATE_SHARED_COMMENT_CONTENT');
    const ref = new PDFRef(910, 0);
    if (mode === 'indirect') doc.objects.set(ref.toKey(), text);
    const shared = mode === 'indirect' ? ref : text;
    doc.pages[0].dict.set('Annots', new PDFArray([new PDFDict([
      ['Subtype', new PDFName('Text')], ['Contents', shared],
    ])]));
    doc.catalog.set('RetainedContent', shared);
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, comments: true })).rejects.toThrow(/shared/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('refuses a comment appearance shared with a retained page resource', async () => {
    const doc = await fixture(), ref = new PDFRef(910, 0);
    const bytes = new TextEncoder().encode('PRIVATE_SHARED_APPEARANCE');
    doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(bytes.length)]]), bytes));
    doc.pages[0].dict.set('Annots', new PDFArray([new PDFDict([
      ['Subtype', new PDFName('Text')], ['AP', new PDFDict([['N', ref]])],
    ])]));
    doc.pages[0].resources.set('RetainedAppearance', ref);
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, comments: true })).rejects.toThrow(/shared/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('refuses comment content shared with a retained annotation on another page', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]); pdf.addPage([200, 200]);
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    const ref = new PDFRef(910, 0);
    doc.objects.set(ref.toKey(), new PDFString('PRIVATE_CROSS_PAGE_COMMENT'));
    doc.pages[0].dict.set('Annots', new PDFArray([new PDFDict([
      ['Subtype', new PDFName('Text')], ['Contents', ref],
    ])]));
    doc.pages[1].dict.set('Annots', new PDFArray([new PDFDict([
      ['Subtype', new PDFName('Link')], ['Contents', ref],
    ])]));
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, comments: true })).rejects.toThrow(/shared/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('refuses an appearance image shared with retained page resources', async () => {
    const doc = await fixture(), appearance = new PDFRef(910, 0), image = new PDFRef(911, 0);
    const imageBytes = new TextEncoder().encode('PRIVATE_ANNOTATION_IMAGE');
    doc.objects.set(image.toKey(), new PDFStream(new PDFDict([
      ['Subtype', new PDFName('Image')], ['Length', new PDFNumber(imageBytes.length)],
    ]), imageBytes));
    const appearanceBytes = new TextEncoder().encode('/Im0 Do');
    doc.objects.set(appearance.toKey(), new PDFStream(new PDFDict([
      ['Length', new PDFNumber(appearanceBytes.length)],
      ['Resources', new PDFDict([['XObject', new PDFDict([['Im0', image]])]])],
    ]), appearanceBytes));
    doc.pages[0].dict.set('Annots', new PDFArray([new PDFDict([
      ['Subtype', new PDFName('Text')], ['AP', new PDFDict([['N', appearance]])],
    ])]));
    doc.pages[0].resources.set('RetainedImage', image);
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, comments: true })).rejects.toThrow(/shared/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it.each(['Pattern', 'Shading'] as const)('refuses a shared appearance %s stream', async resourceType => {
    const doc = await fixture(), appearance = new PDFRef(910, 0), data = new PDFRef(911, 0);
    const privateBytes = new TextEncoder().encode(`PRIVATE_APPEARANCE_${resourceType.toUpperCase()}`);
    doc.objects.set(data.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(privateBytes.length)]]), privateBytes));
    const bytes = new TextEncoder().encode('q Q');
    doc.objects.set(appearance.toKey(), new PDFStream(new PDFDict([
      ['Length', new PDFNumber(bytes.length)], ['Resources', new PDFDict([[resourceType, new PDFDict([['R0', data]])]])],
    ]), bytes));
    doc.pages[0].dict.set('Annots', new PDFArray([new PDFDict([
      ['Subtype', new PDFName('Text')], ['AP', new PDFDict([['N', appearance]])],
    ])]));
    doc.pages[0].resources.set('RetainedPrivateResource', data);
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, comments: true })).rejects.toThrow(/shared/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('refuses a shading function stream shared with page resources', async () => {
    const doc = await fixture(), appearance = new PDFRef(910, 0), fn = new PDFRef(911, 0);
    const privateBytes = new TextEncoder().encode('PRIVATE_SHADING_FUNCTION');
    doc.objects.set(fn.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(privateBytes.length)]]), privateBytes));
    const bytes = new TextEncoder().encode('/S0 sh');
    doc.objects.set(appearance.toKey(), new PDFStream(new PDFDict([
      ['Length', new PDFNumber(bytes.length)], ['Resources', new PDFDict([
        ['Shading', new PDFDict([['S0', new PDFDict([['Function', fn]])]])],
      ])],
    ]), bytes));
    doc.pages[0].dict.set('Annots', new PDFArray([new PDFDict([
      ['Subtype', new PDFName('Text')], ['AP', new PDFDict([['N', appearance]])],
    ])]));
    doc.pages[0].resources.set('RetainedFunction', fn);
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, comments: true })).rejects.toThrow(/shared/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it.each(['Shading', 'Pattern'] as const)('refuses a shared appearance %s ICC color profile', async resourceType => {
    const doc = await fixture(), appearance = new PDFRef(910, 0), profile = new PDFRef(911, 0);
    const profileBytes = new TextEncoder().encode('PRIVATE_APPEARANCE_COLOR_PROFILE');
    doc.objects.set(profile.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(profileBytes.length)]]), profileBytes));
    const shading = new PDFDict([
      ['ShadingType', new PDFNumber(2)], ['ColorSpace', new PDFArray([new PDFName('ICCBased'), profile])],
    ]);
    const resource = resourceType === 'Shading' ? shading : new PDFDict([
      ['PatternType', new PDFNumber(2)], ['Shading', shading],
    ]);
    const bytes = new TextEncoder().encode('PRIVATE_UNSHARED_APPEARANCE');
    doc.objects.set(appearance.toKey(), new PDFStream(new PDFDict([
      ['Length', new PDFNumber(bytes.length)], ['Resources', new PDFDict([[resourceType, new PDFDict([['R0', resource]])]])],
    ]), bytes));
    doc.pages[0].dict.set('Annots', new PDFArray([new PDFDict([
      ['Subtype', new PDFName('Text')], ['AP', new PDFDict([['N', appearance]])],
    ])]));
    doc.pages[0].resources.set('RetainedColorProfile', profile);
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, comments: true })).rejects.toThrow(/shared/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('removes an appearance with an unshared ICC profile', async () => {
    const doc = await fixture(), appearance = new PDFRef(910, 0), profile = new PDFRef(911, 0);
    const profileBytes = new TextEncoder().encode('PRIVATE_UNSHARED_ICC_PROFILE');
    doc.objects.set(profile.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(profileBytes.length)]]), profileBytes));
    const bytes = new TextEncoder().encode('PRIVATE_UNSHARED_APPEARANCE');
    doc.objects.set(appearance.toKey(), new PDFStream(new PDFDict([
      ['Length', new PDFNumber(bytes.length)], ['ColorSpace', new PDFArray([new PDFName('ICCBased'), profile])],
    ]), bytes));
    doc.pages[0].dict.set('Annots', new PDFArray([new PDFDict([
      ['Subtype', new PDFName('Text')], ['AP', new PDFDict([['N', appearance]])],
    ])]));
    const { detail } = await sanitizationEngine.sanitize(doc, { ...noCleanup, comments: true });
    expect(detail.commentsRemoved).toBe(1);
    const output = new TextDecoder().decode(await saveQuick(doc));
    expect(output).not.toContain('PRIVATE_UNSHARED_APPEARANCE');
    expect(output).not.toContain('PRIVATE_UNSHARED_ICC_PROFILE');
  });

  it.each(['Separation', 'DeviceN', 'Indexed'] as const)(
    'refuses shared appearance %s color-space data', async kind => {
      const doc = await fixture(), appearance = new PDFRef(910, 0), data = new PDFRef(911, 0);
      const privateBytes = new TextEncoder().encode('PRIVATE_COLOR_SPACE_DATA');
      doc.objects.set(data.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(privateBytes.length)]]), privateBytes));
      const color = kind === 'Separation' ? new PDFArray([new PDFName(kind), new PDFName('Spot'), new PDFName('DeviceRGB'), data])
        : kind === 'DeviceN' ? new PDFArray([new PDFName(kind), new PDFArray([new PDFName('Spot')]), new PDFName('DeviceRGB'), data])
          : new PDFArray([new PDFName(kind), new PDFName('DeviceRGB'), new PDFNumber(1), data]);
      const bytes = new TextEncoder().encode('/S0 sh');
      doc.objects.set(appearance.toKey(), new PDFStream(new PDFDict([
        ['Length', new PDFNumber(bytes.length)], ['Resources', new PDFDict([
          ['Shading', new PDFDict([['S0', new PDFDict([['ShadingType', new PDFNumber(2)], ['ColorSpace', color]])]])],
        ])],
      ]), bytes));
      doc.pages[0].dict.set('Annots', new PDFArray([new PDFDict([
        ['Subtype', new PDFName('Text')], ['AP', new PDFDict([['N', appearance]])],
      ])]));
      doc.pages[0].resources.set('RetainedColorData', data);
      const before = await serializeDocument(doc);
      await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, comments: true })).rejects.toThrow(/shared/i);
      expect(await serializeDocument(doc)).toEqual(before);
      expect(doc.requiresFullRewrite).toBeUndefined();
    },
  );

  it('refuses an unrecognized appearance color space before mutation', async () => {
    const doc = await fixture(), appearance = new PDFRef(910, 0);
    const bytes = new TextEncoder().encode('q Q');
    doc.objects.set(appearance.toKey(), new PDFStream(new PDFDict([
      ['Length', new PDFNumber(bytes.length)], ['ColorSpace', new PDFArray([new PDFName('PrivateSpace')])],
    ]), bytes));
    doc.pages[0].dict.set('Annots', new PDFArray([new PDFDict([
      ['Subtype', new PDFName('Text')], ['AP', new PDFDict([['N', appearance]])],
    ])]));
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, comments: true })).rejects.toThrow(/inspect/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('removes an unshared comment appearance while retaining shared fonts', async () => {
    const doc = await fixture(), appearance = new PDFRef(910, 0), font = new PDFRef(911, 0);
    doc.objects.set(font.toKey(), new PDFDict([['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')], ['BaseFont', new PDFName('Helvetica')]]));
    const bytes = new TextEncoder().encode('PRIVATE_UNSHARED_APPEARANCE');
    doc.objects.set(appearance.toKey(), new PDFStream(new PDFDict([
      ['Length', new PDFNumber(bytes.length)],
      ['Resources', new PDFDict([['Font', new PDFDict([['F1', font]])]])],
    ]), bytes));
    doc.pages[0].dict.set('Annots', new PDFArray([new PDFDict([
      ['Subtype', new PDFName('Text')], ['AP', new PDFDict([['N', appearance]])], ['P', doc.pages[0].ref],
    ])]));
    doc.pages[0].resources.set('RetainedFont', font);
    const { detail } = await sanitizationEngine.sanitize(doc, { ...noCleanup, comments: true });
    expect(detail.commentsRemoved).toBe(1);
    const output = new TextDecoder().decode(await saveQuick(doc));
    expect(output).not.toContain('PRIVATE_UNSHARED_APPEARANCE');
    expect(output).toContain('Helvetica');
  });

  it('refuses an appearance soft-mask group shared with page resources', async () => {
    const doc = await fixture(), appearance = new PDFRef(910, 0), group = new PDFRef(911, 0);
    const groupBytes = new TextEncoder().encode('PRIVATE_APPEARANCE_SOFTMASK');
    doc.objects.set(group.toKey(), new PDFStream(new PDFDict([
      ['Subtype', new PDFName('Form')], ['Length', new PDFNumber(groupBytes.length)],
    ]), groupBytes));
    const bytes = new TextEncoder().encode('/GS0 gs');
    doc.objects.set(appearance.toKey(), new PDFStream(new PDFDict([
      ['Length', new PDFNumber(bytes.length)], ['Resources', new PDFDict([
        ['ExtGState', new PDFDict([['GS0', new PDFDict([['SMask', new PDFDict([['G', group]])]])]])],
      ])],
    ]), bytes));
    doc.pages[0].dict.set('Annots', new PDFArray([new PDFDict([
      ['Subtype', new PDFName('Text')], ['AP', new PDFDict([['N', appearance]])],
    ])]));
    doc.pages[0].resources.set('RetainedMaskGroup', group);
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, comments: true })).rejects.toThrow(/shared/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it.each(['TR', 'TR2', 'BG', 'BG2', 'UCR', 'UCR2'] as const)(
    'refuses a shared appearance ExtGState %s function stream', async key => {
      const doc = await fixture(), appearance = new PDFRef(910, 0), fn = new PDFRef(911, 0);
      const privateBytes = new TextEncoder().encode('PRIVATE_APPEARANCE_TRANSFER_FUNCTION');
      doc.objects.set(fn.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(privateBytes.length)]]), privateBytes));
      const bytes = new TextEncoder().encode('/GS0 gs');
      doc.objects.set(appearance.toKey(), new PDFStream(new PDFDict([
        ['Length', new PDFNumber(bytes.length)], ['Resources', new PDFDict([
          ['ExtGState', new PDFDict([['GS0', new PDFDict([[key, fn]])]])],
        ])],
      ]), bytes));
      doc.pages[0].dict.set('Annots', new PDFArray([new PDFDict([
        ['Subtype', new PDFName('Text')], ['AP', new PDFDict([['N', appearance]])],
      ])]));
      doc.pages[0].resources.set('RetainedFunction', fn);
      const before = await serializeDocument(doc);
      await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, comments: true })).rejects.toThrow(/shared/i);
      expect(await serializeDocument(doc)).toEqual(before);
      expect(doc.requiresFullRewrite).toBeUndefined();
    },
  );

  it('accepts shared default and identity transfer functions without private data', async () => {
    const doc = await fixture(), appearance = new PDFRef(910, 0);
    const defaults = new PDFArray([new PDFName('Identity'), new PDFName('Default')]);
    const state = new PDFDict([['TR', defaults], ['BG2', new PDFName('Default')]]);
    const bytes = new TextEncoder().encode('PRIVATE_UNSHARED_APPEARANCE');
    doc.objects.set(appearance.toKey(), new PDFStream(new PDFDict([
      ['Length', new PDFNumber(bytes.length)], ['Resources', new PDFDict([
        ['ExtGState', new PDFDict([['GS0', state]])],
      ])],
    ]), bytes));
    doc.pages[0].dict.set('Annots', new PDFArray([new PDFDict([
      ['Subtype', new PDFName('Text')], ['AP', new PDFDict([['N', appearance]])],
    ])]));
    doc.pages[0].resources.set('RetainedState', state);
    const { detail } = await sanitizationEngine.sanitize(doc, { ...noCleanup, comments: true });
    expect(detail.commentsRemoved).toBe(1);
    const output = new TextDecoder().decode(await saveQuick(doc));
    expect(output).not.toContain('PRIVATE_UNSHARED_APPEARANCE');
    expect(output).toContain('Identity');
  });

  it('refuses an appearance transfer-function array containing a shared stream', async () => {
    const doc = await fixture(), appearance = new PDFRef(910, 0), fn = new PDFRef(911, 0);
    const privateBytes = new TextEncoder().encode('PRIVATE_APPEARANCE_ARRAY_FUNCTION');
    doc.objects.set(fn.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(privateBytes.length)]]), privateBytes));
    const bytes = new TextEncoder().encode('/GS0 gs');
    doc.objects.set(appearance.toKey(), new PDFStream(new PDFDict([
      ['Length', new PDFNumber(bytes.length)], ['Resources', new PDFDict([
        ['ExtGState', new PDFDict([['GS0', new PDFDict([['TR', new PDFArray([new PDFName('Identity'), fn])]])]])],
      ])],
    ]), bytes));
    doc.pages[0].dict.set('Annots', new PDFArray([new PDFDict([
      ['Subtype', new PDFName('Text')], ['AP', new PDFDict([['N', appearance]])],
    ])]));
    doc.pages[0].resources.set('RetainedFunction', fn);
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, comments: true })).rejects.toThrow(/shared/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('refuses a Type3 glyph stream shared with retained page content', async () => {
    const doc = await fixture(), appearance = new PDFRef(910, 0), glyph = new PDFRef(911, 0);
    const glyphBytes = new TextEncoder().encode('PRIVATE_TYPE3_GLYPH_CONTENT');
    doc.objects.set(glyph.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(glyphBytes.length)]]), glyphBytes));
    const font = new PDFDict([
      ['Type', new PDFName('Font')], ['Subtype', new PDFName('Type3')],
      ['CharProcs', new PDFDict([['secret', glyph]])],
    ]);
    const bytes = new TextEncoder().encode('/F3 12 Tf');
    doc.objects.set(appearance.toKey(), new PDFStream(new PDFDict([
      ['Length', new PDFNumber(bytes.length)], ['Resources', new PDFDict([['Font', new PDFDict([['F3', font]])]])],
    ]), bytes));
    doc.pages[0].dict.set('Annots', new PDFArray([new PDFDict([
      ['Subtype', new PDFName('Text')], ['AP', new PDFDict([['N', appearance]])],
    ])]));
    doc.pages[0].resources.set('RetainedType3Font', font);
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, comments: true })).rejects.toThrow(/shared/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it.each(['ToUnicode', 'FontFile'] as const)('refuses shared custom font %s data', async key => {
    const doc = await fixture(), appearance = new PDFRef(910, 0), privateData = new PDFRef(911, 0);
    const privateBytes = new TextEncoder().encode('PRIVATE_CUSTOM_FONT_DATA');
    doc.objects.set(privateData.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(privateBytes.length)]]), privateBytes));
    const font = new PDFDict([
      ['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')], ['BaseFont', new PDFName('Helvetica')],
    ]);
    if (key === 'ToUnicode') font.set('ToUnicode', privateData);
    else font.set('FontDescriptor', new PDFDict([['FontFile', privateData]]));
    const bytes = new TextEncoder().encode('/F1 12 Tf');
    doc.objects.set(appearance.toKey(), new PDFStream(new PDFDict([
      ['Length', new PDFNumber(bytes.length)], ['Resources', new PDFDict([['Font', new PDFDict([['F1', font]])]])],
    ]), bytes));
    doc.pages[0].dict.set('Annots', new PDFArray([new PDFDict([
      ['Subtype', new PDFName('Text')], ['AP', new PDFDict([['N', appearance]])],
    ])]));
    doc.pages[0].resources.set('RetainedFontData', privateData);
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, comments: true })).rejects.toThrow(/shared/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it.each(['HT', 'PrivateCustom'] as const)('refuses shared appearance ExtGState %s data', async key => {
    const doc = await fixture(), appearance = new PDFRef(910, 0), data = new PDFRef(911, 0);
    const privateBytes = new TextEncoder().encode('PRIVATE_APPEARANCE_EXTGSTATE_DATA');
    doc.objects.set(data.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(privateBytes.length)]]), privateBytes));
    const bytes = new TextEncoder().encode('/GS0 gs');
    doc.objects.set(appearance.toKey(), new PDFStream(new PDFDict([
      ['Length', new PDFNumber(bytes.length)], ['Resources', new PDFDict([
        ['ExtGState', new PDFDict([['GS0', new PDFDict([[key, data]])]])],
      ])],
    ]), bytes));
    doc.pages[0].dict.set('Annots', new PDFArray([new PDFDict([
      ['Subtype', new PDFName('Text')], ['AP', new PDFDict([['N', appearance]])],
    ])]));
    doc.pages[0].resources.set('RetainedStateData', data);
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, comments: true })).rejects.toThrow(/shared/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('preserves shared ordinary ExtGState fonts, dash arrays and scalar styles', async () => {
    const doc = await fixture(), appearance = new PDFRef(910, 0), font = new PDFRef(911, 0);
    doc.objects.set(font.toKey(), new PDFDict([['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')], ['BaseFont', new PDFName('Helvetica')]]));
    const state = new PDFDict([
      ['Font', new PDFArray([font, new PDFNumber(12)])],
      ['D', new PDFArray([new PDFArray([new PDFNumber(2), new PDFNumber(1)]), new PDFNumber(0)])],
      ['BM', new PDFName('Normal')],
    ]);
    const bytes = new TextEncoder().encode('PRIVATE_APPEARANCE');
    doc.objects.set(appearance.toKey(), new PDFStream(new PDFDict([
      ['Length', new PDFNumber(bytes.length)], ['Resources', new PDFDict([
        ['ExtGState', new PDFDict([['GS0', state]])],
      ])],
    ]), bytes));
    doc.pages[0].dict.set('Annots', new PDFArray([new PDFDict([
      ['Subtype', new PDFName('Text')], ['AP', new PDFDict([['N', appearance]])],
    ])]));
    doc.pages[0].resources.set('RetainedState', state);
    const { detail } = await sanitizationEngine.sanitize(doc, { ...noCleanup, comments: true });
    expect(detail.commentsRemoved).toBe(1);
    const output = new TextDecoder().decode(await saveQuick(doc));
    expect(output).not.toContain('PRIVATE_APPEARANCE');
    expect(output).toContain('Helvetica');
  });

  it('bounds appearance-resource inspection and refuses without mutation', async () => {
    const doc = await fixture(), appearance = new PDFRef(910, 0), zero = new PDFNumber(0);
    const bytes = new TextEncoder().encode('q Q');
    doc.objects.set(appearance.toKey(), new PDFStream(new PDFDict([
      ['Length', new PDFNumber(bytes.length)], ['Resources', new PDFDict([
        ['ExtGState', new PDFDict([['GS0', new PDFDict([['D', new PDFArray(new Array(100_001).fill(zero))]])]])],
      ])],
    ]), bytes));
    doc.pages[0].dict.set('Annots', new PDFArray([new PDFDict([
      ['Subtype', new PDFName('Text')], ['AP', new PDFDict([['N', appearance]])],
    ])]));
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, comments: true })).rejects.toThrow(/inspect/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  }, 30000);

  it('refuses shared appearance marked-content ActualText properties', async () => {
    const doc = await fixture(), appearance = new PDFRef(910, 0), properties = new PDFRef(911, 0);
    doc.objects.set(properties.toKey(), new PDFDict([['ActualText', new PDFString('PRIVATE_APPEARANCE_ACTUAL_TEXT')]]));
    const bytes = new TextEncoder().encode('/Span /MC0 BDC EMC');
    doc.objects.set(appearance.toKey(), new PDFStream(new PDFDict([
      ['Length', new PDFNumber(bytes.length)], ['Resources', new PDFDict([
        ['Properties', new PDFDict([['MC0', properties]])],
      ])],
    ]), bytes));
    doc.pages[0].dict.set('Annots', new PDFArray([new PDFDict([
      ['Subtype', new PDFName('Text')], ['AP', new PDFDict([['N', appearance]])],
    ])]));
    doc.pages[0].resources.set('RetainedProperties', properties);
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, comments: true })).rejects.toThrow(/shared/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('refuses an unknown appearance resource before modifying the document', async () => {
    const doc = await fixture(), appearance = new PDFRef(910, 0), privateData = new PDFRef(911, 0);
    doc.objects.set(privateData.toKey(), new PDFString('PRIVATE_UNKNOWN_APPEARANCE_RESOURCE'));
    const bytes = new TextEncoder().encode('q Q');
    doc.objects.set(appearance.toKey(), new PDFStream(new PDFDict([
      ['Length', new PDFNumber(bytes.length)], ['Resources', new PDFDict([['CustomResource', privateData]])],
    ]), bytes));
    doc.pages[0].dict.set('Annots', new PDFArray([new PDFDict([
      ['Subtype', new PDFName('Text')], ['AP', new PDFDict([['N', appearance]])],
    ])]));
    doc.pages[0].resources.set('RetainedPrivateResource', privateData);
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, comments: true })).rejects.toThrow(/inspect/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it.each(['comments', 'annotations', 'javascript'] as const)(
    'rejects %s cleanup before editing a genuinely signed document', async kind => {
      const doc = await fixture();
      doc.pages[0].dict.set('Annots', new PDFArray([new PDFDict([
        ['Subtype', new PDFName('Text')], ['Contents', new PDFString('SIGNED_PRIVATE_COMMENT')],
      ])]));
      doc.catalog.set('OpenAction', new PDFDict([
        ['S', new PDFName('JavaScript')], ['JS', new PDFString('app.alert(1)')],
      ]));
      const field = createSignatureField(doc, 0, { x: 20, y: 20, width: 100, height: 40 }, 'Signer');
      await installSignatureBase(doc, await serializeDocument(doc));
      const bundle = await importFromPem(getTestCredentials().pem, 'test');
      const signed = await signDocumentCryptographic(doc, field, bundle.key!.privateKey, {
        certificateDer: bundle.leaf!.der, hashAlgorithm: 'sha256', contentsSize: 4096, enableTimestamp: false,
      });
      const reopened = await parsePDF(signed.bytes);
      const before = await serializeDocument(reopened);
      const cleanup = sanitizationEngine.sanitize(reopened, { ...noCleanup, [kind]: true });
      if (kind === 'annotations') await expect(cleanup).rejects.toThrow(/shared|signed/i);
      else await expect(cleanup).rejects.toThrow(SignedDocumentEditError);
      expect(await serializeDocument(reopened)).toEqual(before);
      expect(reopened.requiresFullRewrite).toBeUndefined();
      expect(await saveQuick(reopened)).toEqual(signed.bytes);
      const report = await validateDocumentSignatures(reopened, { allowSelfSigned: true });
      expect(report.signatures.some(item => item.digestMatch && item.cmsSignatureOk === true)).toBe(true);
    }, 30000,
  );

  it.each(['remove', 'disable'] as const)(
    'rejects direct %s action cleanup on a genuinely signed document', async method => {
      const doc = await fixture();
      doc.catalog.set('OpenAction', new PDFDict([
        ['S', new PDFName('JavaScript')], ['JS', new PDFString('app.alert(1)')],
      ]));
      const field = createSignatureField(doc, 0, { x: 20, y: 20, width: 100, height: 40 }, 'Signer');
      await installSignatureBase(doc, await serializeDocument(doc));
      const bundle = await importFromPem(getTestCredentials().pem, 'test');
      const signed = await signDocumentCryptographic(doc, field, bundle.key!.privateKey, {
        certificateDer: bundle.leaf!.der, hashAlgorithm: 'sha256', contentsSize: 4096, enableTimestamp: false,
      });
      const reopened = await parsePDF(signed.bytes);
      const before = await serializeDocument(reopened);
      expect(() => method === 'remove'
        ? javaScriptSecurityEngine.removeJavaScript(reopened)
        : javaScriptSecurityEngine.disableActions(reopened, ['JavaScript'])).toThrow(SignedDocumentEditError);
      expect(await serializeDocument(reopened)).toEqual(before);
      expect(reopened.requiresFullRewrite).toBeUndefined();
      expect(await saveQuick(reopened)).toEqual(signed.bytes);
    }, 30000,
  );

  it('preserves a signed document on no-op comment and JavaScript cleanup', async () => {
    const doc = await fixture();
    const field = createSignatureField(doc, 0, { x: 20, y: 20, width: 100, height: 40 }, 'Signer');
    await installSignatureBase(doc, await serializeDocument(doc));
    const bundle = await importFromPem(getTestCredentials().pem, 'test');
    const signed = await signDocumentCryptographic(doc, field, bundle.key!.privateKey, {
      certificateDer: bundle.leaf!.der, hashAlgorithm: 'sha256', contentsSize: 4096, enableTimestamp: false,
    });
    const reopened = await parsePDF(signed.bytes);
    expect(javaScriptSecurityEngine.removeJavaScript(reopened).removed).toBe(0);
    const result = await sanitizationEngine.sanitize(reopened, { ...noCleanup, comments: true, javascript: true });
    expect(result.report).toEqual(['Nothing to sanitize']);
    expect(reopened.requiresFullRewrite).toBeUndefined();
    expect(await saveQuick(reopened)).toEqual(signed.bytes);
    const report = await validateDocumentSignatures(reopened, { allowSelfSigned: true });
    expect(report.signatures.some(item => item.digestMatch && item.cmsSignatureOk === true)).toBe(true);
  }, 30000);

  it('reports a signed metadata cleanup with no metadata as a no-op', async () => {
    const doc = await fixture();
    doc.xref.trailerDict.delete('Info');
    doc.catalog.delete('Metadata');
    doc.info = {};
    const field = createSignatureField(doc, 0, { x: 20, y: 20, width: 100, height: 40 }, 'Signer');
    await installSignatureBase(doc, await serializeDocument(doc));
    const bundle = await importFromPem(getTestCredentials().pem, 'test');
    const signed = await signDocumentCryptographic(doc, field, bundle.key!.privateKey, {
      certificateDer: bundle.leaf!.der, hashAlgorithm: 'sha256', contentsSize: 4096, enableTimestamp: false,
    });
    const reopened = await parsePDF(signed.bytes);
    expect(reopened.xref.trailerDict.has('Info')).toBe(false);
    expect(reopened.catalog.has('Metadata')).toBe(false);
    const result = await sanitizationEngine.sanitize(reopened, { ...noCleanup, metadata: true });
    expect(result.report).toEqual(['Nothing to sanitize']);
    expect(result.detail).toEqual({
      actions: ['Nothing to sanitize'], metadataRemoved: false, javascriptRemoved: 0,
      attachmentsRemoved: 0, commentsRemoved: 0, annotationsRemoved: 0,
      unusedObjectsRemoved: 0, layersRemoved: 0,
    });
    expect(reopened.requiresFullRewrite).toBeUndefined();
    expect(await saveQuick(reopened)).toEqual(signed.bytes);
    const report = await validateDocumentSignatures(reopened, { allowSelfSigned: true });
    expect(report.signatures.some(item => item.digestMatch && item.cmsSignatureOk === true)).toBe(true);
  }, 30000);

  it('rejects removing an empty action dictionary from a signed document even with no actions counted', async () => {
    const doc = await fixture();
    doc.catalog.set('AA', new PDFDict());
    const field = createSignatureField(doc, 0, { x: 20, y: 20, width: 100, height: 40 }, 'Signer');
    await installSignatureBase(doc, await serializeDocument(doc));
    const bundle = await importFromPem(getTestCredentials().pem, 'test');
    const signed = await signDocumentCryptographic(doc, field, bundle.key!.privateKey, {
      certificateDer: bundle.leaf!.der, hashAlgorithm: 'sha256', contentsSize: 4096, enableTimestamp: false,
    });
    const reopened = await parsePDF(signed.bytes);
    expect(() => javaScriptSecurityEngine.removeJavaScript(reopened)).toThrow(SignedDocumentEditError);
    expect(reopened.catalog.has('AA')).toBe(true);
    expect(reopened.requiresFullRewrite).toBeUndefined();
    expect(await saveQuick(reopened)).toEqual(signed.bytes);
  }, 30000);

  it('does not garbage-collect objects from a signed document before rejecting cleanup', async () => {
    const doc = await fixture();
    const field = createSignatureField(doc, 0, { x: 20, y: 20, width: 100, height: 40 }, 'Signer');
    await installSignatureBase(doc, await serializeDocument(doc));
    const bundle = await importFromPem(getTestCredentials().pem, 'test');
    const signed = await signDocumentCryptographic(doc, field, bundle.key!.privateKey, {
      certificateDer: bundle.leaf!.der, hashAlgorithm: 'sha256', contentsSize: 4096, enableTimestamp: false,
    });
    const reopened = await parsePDF(signed.bytes);
    const orphan = new PDFRef(990, 0);
    reopened.objects.set(orphan.toKey(), new PDFString('UNUSED_DRAFT_DATA'));
    await expect(sanitizationEngine.sanitize(reopened, { ...noCleanup, unusedObjects: true })).rejects.toThrow(SignedDocumentEditError);
    expect(reopened.objects.get(orphan.toKey())).toBeInstanceOf(PDFString);
    expect(reopened.requiresFullRewrite).toBeUndefined();
    expect(await saveQuick(reopened)).toEqual(signed.bytes);
  }, 30000);

  it('removes alternate image references from nested direct dictionaries', async () => {
    const doc = await fixture();
    const alternate = new PDFDict([
      ['Alternates', new PDFArray([new PDFString('PRIVATE_ALTERNATE_IMAGE_MARKER')])],
      ['Keep', new PDFString('RETAINED_RESOURCE')],
    ]);
    doc.pages[0].resources.set('PrivateResource', new PDFDict([
      ['Items', new PDFArray([alternate, alternate])],
    ]));
    const { report } = await sanitizationEngine.sanitize(doc, { ...noCleanup, alternativeImages: true });
    expect(report).toContain('Removed 1 alternative image reference(s)');
    const bytes = await saveQuick(doc);
    const serialized = new TextDecoder().decode(bytes);
    expect(serialized).not.toContain('PRIVATE_ALTERNATE_IMAGE_MARKER');
    expect(serialized).toContain('RETAINED_RESOURCE');
    const reopened = await parsePDF(bytes);
    const nested = reopened.pages[0].resources.getDict('PrivateResource')?.getArray('Items');
    expect((nested?.get(0) as PDFDict).has('Alternates')).toBe(false);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });

  it('preserves nested alternate references when their cleanup is disabled', async () => {
    const doc = await fixture();
    doc.pages[0].resources.set('PrivateResource', new PDFDict([
      ['Nested', new PDFDict([['Alternates', new PDFArray([new PDFString('KEEP_ALTERNATE')])]])],
    ]));
    await sanitizationEngine.sanitize(doc, { ...noCleanup });
    const bytes = await saveQuick(doc);
    expect(new TextDecoder().decode(bytes)).toContain('KEEP_ALTERNATE');
    const reopened = await parsePDF(bytes);
    expect(reopened.pages[0].resources.getDict('PrivateResource')?.getDict('Nested')?.has('Alternates')).toBe(true);
  });

  it('refuses alternative image cleanup when its data is retained by another reference', async () => {
    const doc = await fixture();
    const ref = new PDFRef(910, 0);
    const bytes = new TextEncoder().encode('SHARED_ALTERNATE_IMAGE_MARKER');
    doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([
      ['Subtype', new PDFName('Image')], ['Length', new PDFNumber(bytes.length)],
    ]), bytes));
    doc.pages[0].resources.set('PrivateResource', new PDFDict([
      ['Alternates', new PDFArray([new PDFDict([['Image', ref]])])], ['Retained', ref],
    ]));
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, alternativeImages: true })).rejects.toThrow(/shared/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('allows an alternative image to share non-image resources with retained content', async () => {
    const doc = await fixture();
    const image = new PDFRef(910, 0), profile = new PDFRef(911, 0);
    const imageBytes = new TextEncoder().encode('REMOVED_ALT_IMAGE_DATA');
    const profileBytes = new TextEncoder().encode('RETAINED_COLOR_PROFILE');
    doc.objects.set(profile.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(profileBytes.length)]]), profileBytes));
    doc.objects.set(image.toKey(), new PDFStream(new PDFDict([
      ['Subtype', new PDFName('Image')], ['ColorSpace', profile], ['Length', new PDFNumber(imageBytes.length)],
    ]), imageBytes));
    doc.pages[0].resources.set('PrivateResource', new PDFDict([
      ['Alternates', new PDFArray([new PDFDict([['Image', image]])])], ['Profile', profile],
    ]));
    await sanitizationEngine.sanitize(doc, { ...noCleanup, alternativeImages: true });
    const output = new TextDecoder().decode(await saveQuick(doc));
    expect(output).not.toContain('REMOVED_ALT_IMAGE_DATA');
    expect(output).toContain('RETAINED_COLOR_PROFILE');
  });

  it('refuses cleanup when an alternative image mask remains reachable', async () => {
    const doc = await fixture();
    const image = new PDFRef(910, 0), mask = new PDFRef(911, 0);
    const imageBytes = new TextEncoder().encode('ALTERNATE_IMAGE_DATA');
    const maskBytes = new TextEncoder().encode('PRIVATE_ALTERNATE_MASK');
    doc.objects.set(mask.toKey(), new PDFStream(new PDFDict([
      ['Subtype', new PDFName('Image')], ['Length', new PDFNumber(maskBytes.length)],
    ]), maskBytes));
    doc.objects.set(image.toKey(), new PDFStream(new PDFDict([
      ['Subtype', new PDFName('Image')], ['SMask', mask], ['Length', new PDFNumber(imageBytes.length)],
    ]), imageBytes));
    doc.pages[0].resources.set('PrivateResource', new PDFDict([
      ['Alternates', new PDFArray([new PDFDict([['Image', image]])])], ['RetainedMask', mask],
    ]));
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, alternativeImages: true })).rejects.toThrow(/shared/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('allows a shared color-key mask that carries no image pixels', async () => {
    const doc = await fixture();
    const image = new PDFRef(910, 0), colorKey = new PDFRef(911, 0);
    const imageBytes = new TextEncoder().encode('REMOVED_COLORKEY_IMAGE');
    doc.objects.set(colorKey.toKey(), new PDFArray([new PDFNumber(0), new PDFNumber(0)]));
    doc.objects.set(image.toKey(), new PDFStream(new PDFDict([
      ['Subtype', new PDFName('Image')], ['Mask', colorKey], ['Length', new PDFNumber(imageBytes.length)],
    ]), imageBytes));
    doc.pages[0].resources.set('PrivateResource', new PDFDict([
      ['Alternates', new PDFArray([new PDFDict([['Image', image]])])], ['RetainedMask', colorKey],
    ]));
    await sanitizationEngine.sanitize(doc, { ...noCleanup, alternativeImages: true });
    const bytes = await saveQuick(doc);
    expect(new TextDecoder().decode(bytes)).not.toContain('REMOVED_COLORKEY_IMAGE');
    expect((await parsePDF(bytes)).pages[0].resources.getDict('PrivateResource')?.get('RetainedMask')).toBeDefined();
  });

  it('refuses an uninspectable alternative image mask without mutation', async () => {
    const doc = await fixture();
    const image = new PDFRef(910, 0);
    const imageBytes = new TextEncoder().encode('PRIVATE_IMAGE');
    doc.objects.set(image.toKey(), new PDFStream(new PDFDict([
      ['Subtype', new PDFName('Image')], ['SMask', new PDFString('UNKNOWN')], ['Length', new PDFNumber(imageBytes.length)],
    ]), imageBytes));
    doc.pages[0].resources.set('PrivateResource', new PDFDict([
      ['Alternates', new PDFArray([new PDFDict([['Image', image]])])],
    ]));
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, alternativeImages: true })).rejects.toThrow(/mask/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('refuses alternative cleanup before changing a genuinely signed PDF', async () => {
    const doc = await fixture();
    doc.pages[0].resources.set('PrivateResource', new PDFDict([
      ['Alternates', new PDFArray([new PDFString('SIGNED_ALTERNATE')])],
    ]));
    const field = createSignatureField(doc, 0, { x: 20, y: 20, width: 100, height: 40 }, 'Signer');
    await installSignatureBase(doc, await serializeDocument(doc));
    const bundle = await importFromPem(getTestCredentials().pem, 'test');
    const signed = await signDocumentCryptographic(doc, field, bundle.key!.privateKey, {
      certificateDer: bundle.leaf!.der, hashAlgorithm: 'sha256', contentsSize: 4096, enableTimestamp: false,
    });
    const reopened = await parsePDF(signed.bytes);
    await expect(sanitizationEngine.sanitize(reopened, { ...noCleanup, alternativeImages: true })).rejects.toThrow(SignedDocumentEditError);
    expect(reopened.requiresFullRewrite).toBeUndefined();
    expect(await saveQuick(reopened)).toEqual(signed.bytes);
    const report = await validateDocumentSignatures(reopened, { allowSelfSigned: true });
    expect(report.signatures.some(item => item.digestMatch && item.cmsSignatureOk === true)).toBe(true);
  }, 30000);

  it('leaves a signed PDF unchanged when alternative cleanup has nothing to remove', async () => {
    const doc = await fixture();
    const field = createSignatureField(doc, 0, { x: 20, y: 20, width: 100, height: 40 }, 'Signer');
    await installSignatureBase(doc, await serializeDocument(doc));
    const bundle = await importFromPem(getTestCredentials().pem, 'test');
    const signed = await signDocumentCryptographic(doc, field, bundle.key!.privateKey, {
      certificateDer: bundle.leaf!.der, hashAlgorithm: 'sha256', contentsSize: 4096, enableTimestamp: false,
    });
    const reopened = await parsePDF(signed.bytes);
    const result = await sanitizationEngine.sanitize(reopened, { ...noCleanup, alternativeImages: true });
    expect(result.report).toEqual(['Nothing to sanitize']);
    expect(reopened.requiresFullRewrite).toBeUndefined();
    expect(await saveQuick(reopened)).toEqual(signed.bytes);
    const report = await validateDocumentSignatures(reopened, { allowSelfSigned: true });
    expect(report.signatures.some(item => item.digestMatch && item.cmsSignatureOk === true)).toBe(true);
  }, 30000);

  it('refuses to sanitize when a real page is missing from the cached page list', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    pdf.addPage([200, 200]);
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    doc.pages[1].dict.set('Annots', new PDFArray([new PDFDict([
      ['Subtype', new PDFName('Text')], ['Contents', new PDFString('MISSED_PRIVATE_COMMENT')],
    ])]));
    doc.pages.pop();
    const before = await serializeDocument(doc);
    expect(new TextDecoder().decode(before)).toContain('MISSED_PRIVATE_COMMENT');
    await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, comments: true })).rejects.toThrow(/page tree/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('removes direct comment annotations from saved output', async () => {
    const doc = await fixture();
    doc.pages[0].dict.set('Annots', new PDFArray([new PDFDict([
      ['Type', new PDFName('Annot')], ['Subtype', new PDFName('Text')],
      ['Contents', new PDFString('PRIVATE_DIRECT_COMMENT')],
    ])]));
    const { detail } = await sanitizationEngine.sanitize(doc, { ...noCleanup, comments: true });
    expect(detail.commentsRemoved).toBe(1);
    const output = await serializeDocument(doc);
    expect(new TextDecoder().decode(output)).not.toContain('PRIVATE_DIRECT_COMMENT');
    const reopened = await parsePDF(output);
    expect(reopened.pages[0].dict.getArray('Annots')?.length ?? 0).toBe(0);
  });

  it('refuses to remove a comment shared with retained document data', async () => {
    const doc = await fixture();
    const ref = new PDFRef(910, 0);
    doc.objects.set(ref.toKey(), new PDFDict([
      ['Type', new PDFName('Annot')], ['Subtype', new PDFName('Text')],
      ['Contents', new PDFString('SHARED_COMMENT')],
    ]));
    doc.pages[0].dict.set('Annots', new PDFArray([ref]));
    doc.catalog.set('Retained', ref);
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, comments: true })).rejects.toThrow(/shared/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('refuses a directly shared comment without modifying the shared annotation array', async () => {
    const doc = await fixture();
    const annotation = new PDFDict([
      ['Subtype', new PDFName('Text')], ['Contents', new PDFString('DIRECT_SHARED_COMMENT')],
    ]);
    const annotations = new PDFArray([annotation]);
    doc.pages[0].dict.set('Annots', annotations);
    doc.catalog.set('Retained', annotations);
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, comments: true })).rejects.toThrow(/shared/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(annotations.length).toBe(1);
  });

  it('removes comments while keeping unrelated annotations', async () => {
    const doc = await fixture();
    const comment = new PDFRef(910, 0);
    doc.objects.set(comment.toKey(), new PDFDict([
      ['Subtype', new PDFName('Text')], ['Contents', new PDFString('PRIVATE_COMMENT')],
    ]));
    doc.pages[0].dict.set('Annots', new PDFArray([
      comment, new PDFDict([['Subtype', new PDFName('Link')], ['Contents', new PDFString('KEEP_LINK')]]),
    ]));
    await sanitizationEngine.sanitize(doc, { ...noCleanup, comments: true });
    const bytes = await serializeDocument(doc);
    expect(new TextDecoder().decode(bytes)).not.toContain('PRIVATE_COMMENT');
    expect(new TextDecoder().decode(bytes)).toContain('KEEP_LINK');
    expect((await parsePDF(bytes)).pages[0].dict.getArray('Annots')?.length).toBe(1);
  });

  it('refuses malformed annotations before any cleanup', async () => {
    const doc = await fixture();
    doc.pages[0].dict.set('Annots', new PDFArray([new PDFName('Unknown')]));
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, metadata: true, comments: true })).rejects.toThrow(/annotation/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('rejects hidden-layer cleanup before changing metadata or exposing its contents', async () => {
    const doc = await fixture();
    const layer = new PDFRef(911, 0);
    doc.objects.set(layer.toKey(), new PDFDict([['Type', new PDFName('OCG')], ['Name', new PDFString('Private layer')]]));
    doc.catalog.set('OCProperties', new PDFDict([
      ['OCGs', new PDFArray([layer])],
      ['D', new PDFDict([['OFF', new PDFArray([layer])]])],
    ]));
    doc.pages[0].resources.set('Properties', new PDFDict([['PrivateLayer', layer]]));
    await updatePageContent(doc.pages[0].contentRefs,
      new TextEncoder().encode('/OC /PrivateLayer BDC BT (HIDDEN_PRIVATE_TEXT) Tj ET EMC'), doc.objects, false);
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, metadata: true, hiddenLayers: true })).rejects.toThrow(/optional content|hidden layer/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.catalog.has('OCProperties')).toBe(true);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('refuses referenced optional content even when the catalog has no layer configuration', async () => {
    const doc = await fixture();
    doc.pages[0].resources.set('Properties', new PDFDict([['Private', new PDFDict([['Type', new PDFName('OCG')]])]]));
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, hiddenLayers: true })).rejects.toThrow(/optional content/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('allows other cleanup when hidden-layer removal is explicitly disabled', async () => {
    const doc = await fixture();
    const layer = new PDFRef(911, 0);
    doc.objects.set(layer.toKey(), new PDFDict([['Type', new PDFName('OCG')], ['Name', new PDFString('Retain layer')]]));
    doc.catalog.set('OCProperties', new PDFDict([['OCGs', new PDFArray([layer])]]));
    doc.pages[0].resources.set('Properties', new PDFDict([['Layer', layer]]));
    await updatePageContent(doc.pages[0].contentRefs,
      new TextEncoder().encode('/OC /Layer BDC BT (LAYER_CONTENT_RETAINED) Tj ET EMC'), doc.objects, false);
    const metadata = new PDFRef(912, 0);
    const metadataBytes = new TextEncoder().encode('<xmp>REMOVE_METADATA</xmp>');
    doc.objects.set(metadata.toKey(), new PDFStream(new PDFDict([
      ['Type', new PDFName('Metadata')], ['Subtype', new PDFName('XML')],
      ['Length', new PDFNumber(metadataBytes.length)],
    ]), metadataBytes, metadataBytes));
    doc.catalog.set('Metadata', metadata);
    const result = await sanitizationEngine.sanitize(doc, { ...noCleanup, metadata: true, hiddenLayers: false });
    expect(result.detail.metadataRemoved).toBe(true);
    expect(result.detail.layersRemoved).toBe(0);
    const bytes = await serializeDocument(doc);
    expect(new TextDecoder().decode(bytes)).not.toContain('REMOVE_METADATA');
    expect(new TextDecoder().decode(bytes)).toContain('LAYER_CONTENT_RETAINED');
    const reopened = await parsePDF(bytes);
    expect(reopened.catalog.has('OCProperties')).toBe(true);
    expect(reopened.pages[0].resources.getDict('Properties')?.has('Layer')).toBe(true);
  });

  it.each(['invalid XMP', 'chained XMP', 'invalid Info'] as const)(
    'refuses %s instead of claiming metadata was removed', async kind => {
      const doc = await fixture();
      if (kind === 'invalid XMP') doc.catalog.set('Metadata', new PDFString('PRIVATE_METADATA'));
      if (kind === 'chained XMP') {
        const first = new PDFRef(910, 0), second = new PDFRef(911, 0);
        const bytes = new TextEncoder().encode('PRIVATE_METADATA');
        doc.objects.set(first.toKey(), second);
        doc.objects.set(second.toKey(), new PDFStream(new PDFDict(), bytes, bytes));
        doc.catalog.set('Metadata', first);
      }
      if (kind === 'invalid Info') doc.xref.trailerDict.set('Info', new PDFString('PRIVATE_METADATA'));
      const before = await serializeDocument(doc);
      await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, metadata: true })).rejects.toThrow(/metadata/i);
      expect(await serializeDocument(doc)).toEqual(before);
      expect(doc.requiresFullRewrite).toBeUndefined();
    },
  );

  it.each(['page', 'nested resource'] as const)(
    'removes indirect component metadata on a %s from a saved and reopened PDF', async location => {
      const doc = await fixture();
      const bytes = new TextEncoder().encode('<xmp>PRIVATE_COMPONENT_METADATA</xmp>');
      const ref = new PDFRef(910, 0);
      doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([
        ['Type', new PDFName('Metadata')], ['Subtype', new PDFName('XML')],
        ['Length', new PDFNumber(bytes.length)],
      ]), bytes, bytes));
      if (location === 'page') doc.pages[0].dict.set('Metadata', ref);
      else doc.pages[0].resources.set('Properties', new PDFDict([
        ['Component', new PDFDict([['Metadata', ref]])],
      ]));
      const before = await serializeDocument(doc);
      expect(new TextDecoder().decode(before)).toContain('PRIVATE_COMPONENT_METADATA');
      doc.rawBytes = before;
      const result = await sanitizationEngine.sanitize(doc, { ...noCleanup, metadata: true });
      expect(result.detail.metadataRemoved).toBe(true);
      expect(doc.requiresFullRewrite).toBe(true);
      const output = await saveQuick(doc);
      expect(new TextDecoder().decode(output)).not.toContain('PRIVATE_COMPONENT_METADATA');
      const reopened = await parsePDF(output);
      const independent = await PDFDocument.load(output, { updateMetadata: false });
      if (location === 'page') {
        expect(reopened.pages[0].dict.has('Metadata')).toBe(false);
        expect(independent.getPage(0).node.has(LibName.of('Metadata'))).toBe(false);
      } else {
        const props = reopened.pages[0].resources.getDict('Properties')!;
        expect(props.getDict('Component')!.has('Metadata')).toBe(false);
        const resources = independent.getPage(0).node.Resources()!;
        const properties = resources.lookup(LibName.of('Properties'), LibDict);
        expect(properties.lookup(LibName.of('Component'), LibDict).has(LibName.of('Metadata'))).toBe(false);
      }
    },
  );

  it.each(['page', 'nested resource'] as const)(
    'refuses malformed component metadata on a %s without changing the document', async location => {
      const doc = await fixture();
      const metadata = new PDFString('PRIVATE_COMPONENT_METADATA');
      if (location === 'page') doc.pages[0].dict.set('Metadata', metadata);
      else doc.pages[0].resources.set('Properties', new PDFDict([
        ['Component', new PDFDict([['Metadata', metadata]])],
      ]));
      const before = await serializeDocument(doc);
      await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, metadata: true })).rejects.toThrow(/component.*metadata/i);
      expect(await serializeDocument(doc)).toEqual(before);
      expect(doc.requiresFullRewrite).toBeUndefined();
    },
  );

  it('removes one metadata stream shared by catalog and multiple component metadata entries', async () => {
    const doc = await fixture();
    const bytes = new TextEncoder().encode('<xmp>SHARED_METADATA_MARKER</xmp>');
    const ref = new PDFRef(910, 0);
    doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([
      ['Type', new PDFName('Metadata')], ['Subtype', new PDFName('XML')], ['Length', new PDFNumber(bytes.length)],
    ]), bytes, bytes));
    doc.catalog.set('Metadata', ref);
    doc.pages[0].dict.set('Metadata', ref);
    doc.pages[0].resources.set('Properties', new PDFDict([['Metadata', ref]]));
    await sanitizationEngine.sanitize(doc, { ...noCleanup, metadata: true });
    const output = await saveQuick(doc);
    expect(new TextDecoder().decode(output)).not.toContain('SHARED_METADATA_MARKER');
    const reopened = await parsePDF(output);
    expect(reopened.catalog.has('Metadata')).toBe(false);
    expect(reopened.pages[0].dict.has('Metadata')).toBe(false);
    expect(reopened.pages[0].resources.getDict('Properties')!.has('Metadata')).toBe(false);
  });

  it('removes compressed component metadata after a complete rewrite', async () => {
    const doc = await fixture();
    const decoded = new TextEncoder().encode('<xmp>COMPRESSED_COMPONENT_PRIVATE</xmp>');
    const bytes = new Uint8Array(deflateSync(decoded));
    const ref = new PDFRef(910, 0);
    doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([
      ['Type', new PDFName('Metadata')], ['Subtype', new PDFName('XML')],
      ['Filter', new PDFName('FlateDecode')], ['Length', new PDFNumber(bytes.length)],
    ]), bytes, decoded));
    doc.pages[0].dict.set('Metadata', ref);
    await installSignatureBase(doc, await serializeDocument(doc));
    await sanitizationEngine.sanitize(doc, { ...noCleanup, metadata: true });
    const output = await saveQuick(doc);
    const independent = await PDFDocument.load(output, { updateMetadata: false });
    expect(independent.getPage(0).node.has(LibName.of('Metadata'))).toBe(false);
    expect((await parsePDF(output)).pages[0].dict.has('Metadata')).toBe(false);
    expect(Buffer.from(output).includes(Buffer.from(bytes))).toBe(false);
  });

  it.each(['missing', 'chained', 'wrong stream type'] as const)(
    'refuses %s component metadata without changing the document', async kind => {
      const doc = await fixture();
      const ref = new PDFRef(910, 0);
      if (kind === 'chained') {
        const next = new PDFRef(911, 0);
        doc.objects.set(ref.toKey(), next);
        doc.objects.set(next.toKey(), new PDFStream(new PDFDict(), new Uint8Array(), new Uint8Array()));
      } else if (kind === 'wrong stream type') {
        doc.objects.set(ref.toKey(), new PDFStream(new PDFDict(), new Uint8Array(), new Uint8Array()));
      }
      doc.pages[0].dict.set('Metadata', ref);
      const before = await serializeDocument(doc);
      await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, metadata: true })).rejects.toThrow(/component.*metadata|unresolved/i);
      expect(await serializeDocument(doc)).toEqual(before);
      expect(doc.requiresFullRewrite).toBeUndefined();
    },
  );

  it('refuses component metadata shared with retained non-metadata content', async () => {
    const doc = await fixture();
    const bytes = new TextEncoder().encode('<xmp>SHARED_PRIVATE_MARKER</xmp>');
    const ref = new PDFRef(910, 0);
    doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([
      ['Type', new PDFName('Metadata')], ['Subtype', new PDFName('XML')], ['Length', new PDFNumber(bytes.length)],
    ]), bytes, bytes));
    doc.pages[0].dict.set('Metadata', ref);
    doc.catalog.set('Retained', ref);
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, metadata: true })).rejects.toThrow(/component.*metadata/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it.each(['direct type', 'indirect type'] as const)(
    'refuses a reachable metadata stream outside a supported Metadata edge (%s)', async kind => {
      const doc = await fixture();
      const bytes = new TextEncoder().encode('<xmp>UNREMOVED_TYPED_XMP</xmp>');
      const ref = new PDFRef(910, 0), typeRef = new PDFRef(911, 0);
      if (kind === 'indirect type') doc.objects.set(typeRef.toKey(), new PDFName('Metadata'));
      doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([
        ['Type', kind === 'indirect type' ? typeRef : new PDFName('Metadata')],
        ['Subtype', new PDFName('XML')], ['Length', new PDFNumber(bytes.length)],
      ]), bytes, bytes));
      doc.catalog.set('PrivateExtension', ref);
      const before = await serializeDocument(doc);
      expect(new TextDecoder().decode(before)).toContain('UNREMOVED_TYPED_XMP');
      await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, metadata: true })).rejects.toThrow(/component.*metadata/i);
      expect(await serializeDocument(doc)).toEqual(before);
      expect(doc.requiresFullRewrite).toBeUndefined();
      const reopened = await parsePDF(before);
      expect(reopened.catalog.getRef('PrivateExtension')?.toKey()).toBe(ref.toKey());
    },
  );

  it.each(['indirect', 'direct'] as const)(
    'refuses metadata stream dictionary values shared with retained data (%s)', async kind => {
      const doc = await fixture();
      const bytes = new TextEncoder().encode('<xmp>PRIVATE_COMPONENT_XML</xmp>');
      const metadataRef = new PDFRef(910, 0), childRef = new PDFRef(911, 0);
      const child = new PDFString('SHARED_METADATA_CHILD');
      if (kind === 'indirect') doc.objects.set(childRef.toKey(), child);
      const shared = kind === 'indirect' ? childRef : child;
      doc.objects.set(metadataRef.toKey(), new PDFStream(new PDFDict([
        ['Type', new PDFName('Metadata')], ['Subtype', new PDFName('XML')],
        ['Length', new PDFNumber(bytes.length)], ['PrivateExtra', shared],
      ]), bytes, bytes));
      doc.pages[0].dict.set('Metadata', metadataRef);
      doc.catalog.set('PrivateExtension', shared);
      const before = await serializeDocument(doc);
      await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, metadata: true })).rejects.toThrow(/component.*metadata/i);
      expect(await serializeDocument(doc)).toEqual(before);
      expect(doc.requiresFullRewrite).toBeUndefined();
      expect(new TextDecoder().decode(before)).toContain('SHARED_METADATA_CHILD');
      expect((await parsePDF(before)).catalog.has('PrivateExtension')).toBe(true);
    },
  );

  it('removes unshared metadata stream dictionary descendants from saved output', async () => {
    const doc = await fixture();
    const bytes = new TextEncoder().encode('<xmp>REMOVED_COMPONENT_XML</xmp>');
    const metadataRef = new PDFRef(910, 0), childRef = new PDFRef(911, 0);
    doc.objects.set(childRef.toKey(), new PDFString('REMOVED_METADATA_CHILD'));
    doc.objects.set(metadataRef.toKey(), new PDFStream(new PDFDict([
      ['Type', new PDFName('Metadata')], ['Subtype', new PDFName('XML')],
      ['Length', new PDFNumber(bytes.length)], ['PrivateExtra', childRef],
    ]), bytes, bytes));
    doc.pages[0].dict.set('Metadata', metadataRef);
    const result = await sanitizationEngine.sanitize(doc, { ...noCleanup, metadata: true });
    expect(result.detail.metadataRemoved).toBe(true);
    const output = await saveQuick(doc);
    expect(new TextDecoder().decode(output)).not.toContain('REMOVED_METADATA_CHILD');
    expect((await parsePDF(output)).pages[0].dict.has('Metadata')).toBe(false);
  });

  it.each(['indirect', 'direct'] as const)(
    'refuses catalog metadata descendants shared with retained data (%s)', async kind => {
      const doc = await fixture();
      const bytes = new TextEncoder().encode('<xmp>PRIVATE_CATALOG_XML</xmp>');
      const metadataRef = new PDFRef(910, 0), childRef = new PDFRef(911, 0);
      const child = new PDFString('SHARED_CATALOG_METADATA_CHILD');
      if (kind === 'indirect') doc.objects.set(childRef.toKey(), child);
      const shared = kind === 'indirect' ? childRef : child;
      doc.objects.set(metadataRef.toKey(), new PDFStream(new PDFDict([
        ['Type', new PDFName('Metadata')], ['Subtype', new PDFName('XML')],
        ['Length', new PDFNumber(bytes.length)], ['PrivateExtra', shared],
      ]), bytes, bytes));
      doc.catalog.set('Metadata', metadataRef);
      doc.catalog.set('PrivateExtension', shared);
      const before = await serializeDocument(doc);
      await expect(sanitizationEngine.sanitize(doc, { ...noCleanup, metadata: true })).rejects.toThrow(/component.*metadata/i);
      expect(await serializeDocument(doc)).toEqual(before);
      expect(doc.requiresFullRewrite).toBeUndefined();
    },
  );

  it('refuses component metadata removal from a real signed PDF and preserves its signature', async () => {
    const doc = await fixture();
    const bytes = new TextEncoder().encode('<xmp>SIGNED_COMPONENT_PRIVATE</xmp>');
    const ref = new PDFRef(910, 0);
    doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([
      ['Type', new PDFName('Metadata')], ['Subtype', new PDFName('XML')], ['Length', new PDFNumber(bytes.length)],
    ]), bytes, bytes));
    doc.pages[0].dict.set('Metadata', ref);
    const field = createSignatureField(doc, 0, { x: 20, y: 20, width: 100, height: 40 }, 'Signer');
    await installSignatureBase(doc, await serializeDocument(doc));
    const credentials = getTestCredentials();
    const bundle = await importFromPem(credentials.pem, 'test');
    const signed = await signDocumentCryptographic(doc, field, bundle.key!.privateKey, {
      certificateDer: bundle.leaf!.der, hashAlgorithm: 'sha256', contentsSize: 4096, enableTimestamp: false,
    });
    const reopened = await parsePDF(signed.bytes);
    await expect(sanitizationEngine.sanitize(reopened, { ...noCleanup, metadata: true })).rejects.toThrow(SignedDocumentEditError);
    expect(reopened.requiresFullRewrite).toBeUndefined();
    expect(await saveQuick(reopened)).toEqual(signed.bytes);
    const report = await validateDocumentSignatures(reopened, { allowSelfSigned: true });
    expect(report.signatures.some(item => item.digestMatch && item.cmsSignatureOk === true)).toBe(true);
  }, 30000);

  it('allows explicitly disabled metadata cleanup while preserving component metadata', async () => {
    const doc = await fixture();
    const bytes = new TextEncoder().encode('<xmp>RETAIN_COMPONENT_METADATA</xmp>');
    const ref = new PDFRef(910, 0);
    doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([
      ['Type', new PDFName('Metadata')], ['Subtype', new PDFName('XML')],
      ['Length', new PDFNumber(bytes.length)],
    ]), bytes, bytes));
    doc.pages[0].dict.set('Metadata', ref);
    doc.pages[0].dict.set('Annots', new PDFArray([new PDFDict([
      ['Subtype', new PDFName('Text')], ['Contents', new PDFString('PRIVATE_COMMENT')],
    ])]));
    const result = await sanitizationEngine.sanitize(doc, { ...noCleanup, comments: true });
    expect(result.detail.commentsRemoved).toBe(1);
    expect(result.detail.metadataRemoved).toBe(false);
    const output = await serializeDocument(doc);
    expect(new TextDecoder().decode(output)).toContain('RETAIN_COMPONENT_METADATA');
    expect(new TextDecoder().decode(output)).not.toContain('PRIVATE_COMMENT');
  });

  it('does not inspect or remove a typed metadata stream when metadata cleanup is disabled', async () => {
    const doc = await fixture();
    const bytes = new TextEncoder().encode('<xmp>KEEP_TYPED_XMP</xmp>');
    const ref = new PDFRef(910, 0);
    doc.objects.set(ref.toKey(), new PDFStream(new PDFDict([
      ['Type', new PDFName('Metadata')], ['Subtype', new PDFName('XML')],
      ['Length', new PDFNumber(bytes.length)],
    ]), bytes, bytes));
    doc.catalog.set('PrivateExtension', ref);
    const result = await sanitizationEngine.sanitize(doc, { ...noCleanup, unusedObjects: true });
    expect(result.detail.metadataRemoved).toBe(false);
    const output = await saveQuick(doc);
    expect(new TextDecoder().decode(output)).toContain('KEEP_TYPED_XMP');
    expect((await parsePDF(output)).catalog.getRef('PrivateExtension')?.toKey()).toBe(ref.toKey());
  });
});
