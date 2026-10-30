import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName } from 'pdf-lib';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { readFileSync } from 'node:fs';

async function fixture() {
  const pdf = await PDFDocument.create(), page = pdf.addPage([100, 100]);
  const canvas = createCanvas(8, 8), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f4e5da'; ctx.fillRect(0, 0, 8, 8);
  ctx.fillStyle = 'rgba(70,130,210,0.5)'; ctx.fillRect(0, 0, 3, 4);
  const image = await pdf.embedPng(canvas.toBuffer('image/png'));
  const tile = pdf.context.flateStream('q 100 0 0 100 0 0 cm /Im0 Do Q', {
    Type: 'Pattern', PatternType: 1, PaintType: 1, TilingType: 1,
    BBox: [0, 0, 100, 100], XStep: 102, YStep: 102, Matrix: [1, 0, 0, -1, 0, 100],
    Resources: { XObject: { Im0: image.ref } },
  });
  const patternRef = pdf.context.register(tile);
  page.node.Resources().set(PDFName.of('Pattern'), pdf.context.obj({P0: patternRef}));
  page.node.addContentStream(pdf.context.register(pdf.context.flateStream('/Pattern cs /P0 scn 0 0 100 100 re f')));
  return Buffer.from(await pdf.save({useObjectStreams:false}));
}

test('colored image tiling pattern stays visible in page, thumbnail and PNG export', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('button',{name:'Open a PDF file'})).toHaveAttribute('aria-disabled','false');
  await page.locator('input[type=file]').setInputFiles({name:'generated.pdf',mimeType:'application/pdf',buffer:await fixture()});
  const surface = page.locator('[data-page-render-surface] canvas.pdf-canvas');
  await expect(surface).toBeVisible();
  const rgba = await surface.evaluate(canvas => Array.from(canvas.getContext('2d').getImageData(canvas.width - 5,canvas.height - 5,1,1).data));
  expect(rgba[0]).toBeGreaterThan(150); expect(rgba[1]).toBeGreaterThan(120);
  const thumb = page.getByAltText('Page 1', {exact:true}); await expect(thumb).toBeVisible();
  const thumbPixel = await thumb.evaluate(img => {const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const g=c.getContext('2d');g.drawImage(img,0,0);return Array.from(g.getImageData(c.width-3,c.height-3,1,1).data)});
  expect(thumbPixel[0]).toBeGreaterThan(150); expect(thumbPixel[1]).toBeGreaterThan(120);
  await page.getByTitle('Export to PNG, JPEG, SVG, or text').click();
  const panel=page.getByRole('dialog',{name:'Export Document'}); await panel.getByRole('button',{name:/^PNG Image/}).click();
  const [download]=await Promise.all([page.waitForEvent('download'),panel.getByRole('button',{name:'Export as PNG Image'}).click()]);
  const image=await loadImage(readFileSync(await download.path())), output=createCanvas(image.width,image.height), outputCtx=output.getContext('2d');
  outputCtx.drawImage(image,0,0); const pixel=outputCtx.getImageData(image.width-5,image.height-5,1,1).data;
  expect(pixel[0]).toBeGreaterThan(150); expect(pixel[1]).toBeGreaterThan(120);
});
