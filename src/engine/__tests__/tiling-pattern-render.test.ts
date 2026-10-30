import { afterEach, it, expect, vi } from 'vitest';
import { createCanvas, ImageData, loadImage } from '@napi-rs/canvas/node-canvas';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rawPDF } from './audit-p1-fixtures';
import { parsePDF } from '../parser/parser';
import { renderPage } from '../render/renderer';
import { PDFArray, PDFName, PDFNumber, PDFStream } from '../types';
import { serializeDocument } from '../writer/serializer';

afterEach(() => vi.unstubAllGlobals());
function fixture({ paintType = 1, alpha = 1, tile = '0.9 0.8 0.7 rg 0 0 8 6 re f 0 0 1 rg 0 0 3 2 re f',
  bbox = '0 0 8 6', xStep = 10, yStep = 8, matrix = '1 0 0 -1 3 91', prefix = '', pageOverride = '', imageTile = false, withMask = false, alias = false, rotation = 0 } = {}) {
  const page = pageOverride || `q 5 10 80 60 re W n /GS gs ${prefix} /Pattern cs /P0 scn 0 0 100 100 re f Q 1 0 0 rg 0 0 4 4 re f`;
  if (imageTile) tile = 'q 8 0 0 6 0 0 cm /Im0 Do Q';
  const image = 'FF000000FF000000FFFFFFFF>';
  const mask = '00FF80FF>';
  return rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Rotate ${rotation} /Resources << /Pattern << /P0 4 0 R >> ${alias ? '/ColorSpace << /Alias /Pattern >>' : ''} /ExtGState << /GS << /ca ${alpha} >> >> >> /Contents 5 0 R >>`,
    `<< /Type /Pattern /PatternType 1 /PaintType ${paintType} /TilingType 1 /BBox [${bbox}] /XStep ${xStep} /YStep ${yStep} /Matrix [${matrix}] /Resources << ${imageTile ? '/XObject << /Im0 6 0 R >>' : ''} >> /Length ${tile.length} >>\nstream\n${tile}\nendstream`,
    `<< /Length ${page.length} >>\nstream\n${page}\nendstream`,
    ...(imageTile ? [`<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 ${withMask ? '/SMask 7 0 R' : ''} /Filter /ASCIIHexDecode /Length ${image.length} >>\nstream\n${image}\nendstream`] : []),
    ...(imageTile && withMask ? [`<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${mask.length} >>\nstream\n${mask}\nendstream`] : []),
  ]);
}
function setup() {
  vi.stubGlobal('document', { createElement: () => Object.assign(createCanvas(1, 1), {style:{}}) });
  vi.stubGlobal('ImageData', ImageData);
  vi.stubGlobal('OffscreenCanvas', function(width: number, height: number) { return createCanvas(width, height); });
}
it('renders colored tiling patterns with cell gaps, matrix, clipping and restored color', async () => {
  setup();
  const dir = mkdtempSync(join(tmpdir(), 'pattern-'));
  try {
    const bytes = fixture(); writeFileSync(join(dir, 'input.pdf'), bytes);
    execFileSync('pdftoppm', ['-f','1','-singlefile','-r','72','-png',join(dir,'input.pdf'),join(dir,'ref')]);
    const expected = await loadImage(readFileSync(join(dir,'ref.png')));
    const ref = createCanvas(100,100), refCtx = ref.getContext('2d'); refCtx.drawImage(expected,0,0);
    const out = (await renderPage(await parsePDF(bytes),0,{scale:1,devicePixelRatio:1})).canvas.getContext('2d')!;
    const sample = (x:number,y:number) => Array.from(out.getImageData(x,y,1,1).data);
    const reference = (x:number,y:number) => Array.from(refCtx.getImageData(x,y,1,1).data);
    for (const [x,y] of [[14,30],[14,33],[15,40],[5,10],[95,95],[1,98]]) {
      const a=sample(x,y), b=reference(x,y);
      for (let i=0;i<3;i++) expect(Math.abs(a[i]-b[i]), `pixel ${x},${y} component ${i}`).toBeLessThan(5);
    }
  } finally { rmSync(dir, {recursive:true,force:true}); }
});
it('rejects uncolored patterns rather than painting them as black', async () => {
  setup();
  await expect(renderPage(await parsePDF(fixture({paintType:2})),0,{scale:1,devicePixelRatio:1})).rejects.toThrow(/pattern/i);
});
it('does not change the serialized PDF when painting an image pattern', async () => {
  setup();
  const doc = await parsePDF(fixture({imageTile:true, withMask:true}));
  const before = await serializeDocument(doc);
  await renderPage(doc,0,{scale:1,devicePixelRatio:1});
  expect(await serializeDocument(doc)).toEqual(before);
});
it('rejects partially transparent pattern paint rather than flattening incorrectly', async () => {
  setup();
  await expect(renderPage(await parsePDF(fixture({alpha:0.6})),0,{scale:1,devicePixelRatio:1})).rejects.toThrow(/transparency.*pattern/i);
});
it.each([
  ['translated negative bbox', { bbox: '-3 -2 5 4', tile: '0.9 0.8 0.7 rg -3 -2 8 6 re f 0 0 1 rg -3 -2 3 2 re f' }],
  ['transformed page coordinates', { prefix: '1.5 0 0 1.5 7 11 cm' }],
  ['even-odd patterned fill', { pageOverride: '/Pattern cs /P0 scn 0 0 100 100 re 30 30 40 40 re f*' }],
  ['initial gray after color-space switch', { pageOverride: '/Pattern cs /P0 scn 0 0 40 100 re f 1 0 0 rg /DeviceGray cs 40 0 60 100 re f' }],
  ['pattern restored after scoped color change', { pageOverride: '/Pattern cs /P0 scn q 1 0 0 rg 0 0 40 100 re f Q 40 0 60 100 re f' }],
  ['pattern colorspace alias', { alias: true, pageOverride: '/Alias cs /P0 scn 0 0 100 100 re f' }],
  ['rotated page', { rotation: 90 }],
  ['image resources scoped inside pattern', { imageTile: true }],
  ['image soft-mask in pattern resources', { imageTile: true, withMask: true }],
])('matches Poppler in %s', async (_name, config) => {
  setup();
  const dir = mkdtempSync(join(tmpdir(), 'pattern-phase-'));
  try {
    const bytes = fixture(config); writeFileSync(join(dir,'in.pdf'),bytes);
    execFileSync('pdftoppm',['-f','1','-singlefile','-r','72','-png',join(dir,'in.pdf'),join(dir,'ref')]);
    const expected = await loadImage(readFileSync(join(dir,'ref.png')));
    const canvas = createCanvas(100,100), c=canvas.getContext('2d'); c.drawImage(expected,0,0);
    const ref=c.getImageData(0,0,100,100).data;
    const out=(await renderPage(await parsePDF(bytes),0,{scale:1,devicePixelRatio:1})).canvas.getContext('2d')!.getImageData(0,0,100,100).data;
    let sum=0; for(let i=0;i<ref.length;i+=4) for(let j=0;j<3;j++) sum+=Math.abs(ref[i+j]-out[i+j]);
    if (_name.startsWith('image')) {
      let stable=0, error=0;
      for (let y=11;y<89;y++) for(let x=6;x<84;x++) {
        const i=(y*100+x)*4;
        const same = [-4,4,-400,400].every(offset => [0,1,2].every(k => ref[i+k]===ref[i+offset+k]));
        if (same) {stable++; for(let k=0;k<3;k++) error+=Math.abs(ref[i+k]-out[i+k]);}
      }
      expect(stable).toBeGreaterThan(1000);
      expect(error/(stable*3)).toBeLessThan(3);
    } else expect(sum/(100*100*3)).toBeLessThan(3);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

it.each([
  ['negative x step', { xStep: -10 }],
  ['negative y step', { yStep: -8 }],
  ['overlapping cells', { xStep: 4 }],
  ['degenerate matrix', { matrix: '0 0 0 0 0 0' }],
  ['nested pattern', { tile: '/Pattern cs /P0 scn 0 0 8 6 re f' }],
  ['excessive pattern operations', { tile: Array(10001).fill('q').join(' ') }],
  ['excessive pattern stream bytes', { tile: ' '.repeat(65_537) }],
  ['missing XObject', { tile: '/Missing Do' }],
  ['missing graphics state', { tile: '/Missing gs 0 0 8 6 re f' }],
  ['invalid path operand', { tile: '/Unknown 0 8 6 re f' }],
  ['unbalanced graphics state', { tile: 'q 0 0 8 6 re f' }],
])('explicitly rejects %s', async (_name, config) => {
  setup();
  await expect(renderPage(await parsePDF(fixture(config)), 0, {scale: 1, devicePixelRatio: 1})).rejects.toThrow();
});

it('rejects pattern strokes with dash and line style instead of painting a solid stroke', async () => {
  setup();
  const pageOverride = '/Pattern CS /P0 SCN [3 2] 0 d 1 J 2 j 8 M 1 0 0 2 0 0 cm 10 w 15 15 70 40 re S';
  await expect(renderPage(await parsePDF(fixture({pageOverride})),0,{scale:1,devicePixelRatio:1})).rejects.toThrow(/pattern stroke/i);
});

it('rejects a pattern path whose transform changes after its construction', async () => {
  setup();
  const pageOverride = '/Pattern cs /P0 scn 0 0 40 40 re 2 0 0 2 11 13 cm f';
  await expect(renderPage(await parsePDF(fixture({pageOverride})),0,{scale:1,devicePixelRatio:1})).rejects.toThrow(/pattern.*transform/i);
});

it('rejects non-finite derived scale from tiny positive steps', async () => {
  setup();
  const doc = await parsePDF(fixture());
  const pattern = [...doc.objects.values()].find(value => value instanceof PDFStream && value.dict.getNumber('PatternType') === 1) as PDFStream;
  pattern.dict.set('XStep', new PDFNumber(Number.MIN_VALUE));
  pattern.dict.set('YStep', new PDFNumber(Number.MIN_VALUE));
  pattern.dict.set('BBox', new PDFArray([0, 0, Number.MIN_VALUE, Number.MIN_VALUE].map(value => new PDFNumber(value))));
  await expect(renderPage(doc, 0, {scale: 1, devicePixelRatio: 1})).rejects.toThrow(/pattern/i);
});

it('does not carry pattern work budgets across separate renders using the same options', async () => {
  setup();
  const doc = await parsePDF(fixture({xStep: 1000, yStep: 1000}));
  const options = {scale: 1, devicePixelRatio: 1};
  for (let i=0; i<4; i++) await expect(renderPage(doc, 0, options)).resolves.toBeDefined();
});

it('rejects cumulative tile raster work within one render', async () => {
  setup();
  const pageOverride = '/Pattern cs /P0 scn ' + Array(4).fill('0 0 100 100 re f').join(' ');
  const doc = await parsePDF(fixture({xStep: 1000, yStep: 1000, pageOverride}));
  await expect(renderPage(doc, 0, {scale: 1, devicePixelRatio: 1})).rejects.toThrow(/pattern.*budget/i);
});

it('explicitly rejects a pattern inside a soft-mask form with its own resource scope', async () => {
  setup();
  const mask = '/Pattern cs /P0 scn 0 0 20 20 re f';
  const page = '/M gs 1 0 0 rg 0 0 100 100 re f';
  const tile = '1 g 0 0 10 10 re f';
  const bytes = rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /ExtGState << /M << /SMask << /S /Luminosity /G 4 0 R >> >> >> >> /Contents 5 0 R >>',
    `<< /Type /XObject /Subtype /Form /BBox [0 0 20 20] /Group << /S /Transparency /I true /CS /DeviceRGB >> /Resources << /Pattern << /P0 6 0 R >> >> /Length ${mask.length} >>\nstream\n${mask}\nendstream`,
    `<< /Length ${page.length} >>\nstream\n${page}\nendstream`,
    `<< /Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources << >> /Length ${tile.length} >>\nstream\n${tile}\nendstream`,
  ]);
  await expect(renderPage(await parsePDF(bytes),0,{scale:1,devicePixelRatio:1})).rejects.toThrow(/pattern.*soft.mask/i);
});

it('rejects an unsupported pattern image color space', async () => {
  setup();
  const doc = await parsePDF(fixture({imageTile:true}));
  const image = [...doc.objects.values()].find(value => value instanceof PDFStream && value.dict.getName('Subtype') === 'Image') as PDFStream;
  image.dict.set('ColorSpace', new PDFName('UnsupportedColorSpace'));
  await expect(renderPage(doc, 0, {scale:1, devicePixelRatio:1})).rejects.toThrow(/pattern image color space/i);
});

it('rejects a mismatched JPEG frame before native image decoding', async () => {
  setup();
  const doc = await parsePDF(fixture({imageTile:true}));
  const image = [...doc.objects.values()].find(value => value instanceof PDFStream && value.dict.getName('Subtype') === 'Image') as PDFStream;
  image.rawBytes = createCanvas(64, 64).toBuffer('image/jpeg');
  image.decodedBytes = null;
  image.dict.set('Width', new PDFNumber(1)); image.dict.set('Height', new PDFNumber(1));
  image.dict.set('Filter', new PDFName('DCTDecode'));
  const decode = vi.fn(); vi.stubGlobal('createImageBitmap', decode);
  await expect(renderPage(doc, 0, {scale:1, devicePixelRatio:1})).rejects.toThrow(/JPEG tiling pattern/i);
  expect(decode).not.toHaveBeenCalled();
});

it('rejects an unsupported image filter within a pattern rather than drawing a placeholder', async () => {
  setup();
  const doc = await parsePDF(fixture({imageTile:true}));
  const image = [...doc.objects.values()].find(value => value instanceof PDFStream && value.dict.getName('Subtype') === 'Image') as PDFStream;
  image.dict.set('Filter', new PDFName('UnsupportedFilter'));
  await expect(renderPage(doc, 0, {scale:1, devicePixelRatio:1})).rejects.toThrow();
});

it('rejects a truncated pattern image soft mask instead of treating it as opaque', async () => {
  setup();
  const doc = await parsePDF(fixture({imageTile:true, withMask:true}));
  const mask = [...doc.objects.values()].find(value => value instanceof PDFStream && value.dict.getName('Subtype') === 'Image' && value.dict.getName('ColorSpace') === 'DeviceGray') as PDFStream;
  mask.decodedBytes = new Uint8Array(0);
  await expect(renderPage(doc, 0, {scale:1, devicePixelRatio:1})).rejects.toThrow(/truncated.*mask/i);
});

it('rejects oversized pattern image work before decoding', async () => {
  setup();
  const doc = await parsePDF(fixture({imageTile:true}));
  const image = [...doc.objects.values()].find(value => value instanceof PDFStream && value.dict.getName('Subtype') === 'Image') as PDFStream;
  image.dict.set('Width', new PDFNumber(20000)); image.dict.set('Height', new PDFNumber(20000));
  await expect(renderPage(doc, 0, {scale:1, devicePixelRatio:1})).rejects.toThrow(/image.*budget/i);
});

it('resolves patterns in a transformed Form resource scope', async () => {
  setup();
  const content = 'q 1 0 0 1 10 15 cm /F Do Q';
  const form = '/Pattern cs /P0 scn 0 0 60 60 re f';
  const tile = '0 0 1 rg 0 0 6 6 re f';
  const bytes = rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /F 4 0 R >> >> /Contents 5 0 R >>`,
    `<< /Type /XObject /Subtype /Form /BBox [0 0 60 60] /Matrix [1 0 0 1 7 3] /Resources << /Pattern << /P0 6 0 R >> >> /Length ${form.length} >>\nstream\n${form}\nendstream`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 6 6] /XStep 8 /YStep 8 /Matrix [1 0 0 1 2 1] /Resources << >> /Length ${tile.length} >>\nstream\n${tile}\nendstream`,
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'pattern-form-'));
  try {
    writeFileSync(join(dir,'in.pdf'),bytes);
    execFileSync('pdftoppm',['-f','1','-singlefile','-r','72','-png',join(dir,'in.pdf'),join(dir,'ref')]);
    const bitmap = await loadImage(readFileSync(join(dir,'ref.png'))), reference = createCanvas(100,100);
    reference.getContext('2d').drawImage(bitmap,0,0);
    const ref = reference.getContext('2d').getImageData(0,0,100,100).data;
    const actual = (await renderPage(await parsePDF(bytes),0,{scale:1,devicePixelRatio:1})).canvas.getContext('2d')!.getImageData(0,0,100,100).data;
    let delta=0; for(let i=0;i<ref.length;i+=4) for(let c=0;c<3;c++) delta+=Math.abs(ref[i+c]-actual[i+c]);
    expect(delta/(100*100*3)).toBeLessThan(3);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
