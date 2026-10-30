/**
 * PDF Page Renderer
 *
 * Renders a parsed PDF page to an HTML5 Canvas using our own engine.
 * This replaces PDF.js entirely.
 *
 * Pipeline:
 *   1. Parse page content stream → CSInstructions
 *   2. Interpret instructions → display list (text, paths, images)
 *   3. Draw display list items to CanvasRenderingContext2D
 *
 * Supports:
 *   - Text rendering with font matching
 *   - Path construction and painting (fill, stroke, clip)
 *   - Image XObjects (JPEG, raw pixel data)
 *   - Color spaces (RGB, Gray, CMYK, Indexed, CalRGB, ICCBased)
 *   - Transparency (fill/stroke alpha, SMask)
 *   - Page rotation and scaling
 */

import { parsePDF, getPageContentBytes, resolveRef, getResource } from '../parser/parser';
import { OptionalContentVisibility, OptionalContentError } from '../content/optional-content';
import { isAnnotationVisible } from '../content/annotation-visibility';
import { interpretPage, resolveSoftMaskState, type DisplayItem, type TextRun, type PathItem, type ImageItem, type InlineImageItem, type FormItem, type ShadingItem, type GlyphPosition, type ClipPathNode } from '../content/interpreter';
import { parseContentStream } from '../content/operator-lexer';
import { buildDocumentFlow, buildFlowDrawIndex, type DocumentFlow, type TextLine } from '../flow';
import type { FlowGlyphDraw } from '../flow/flow-draw';
import { loadPageFonts, type FontData } from '../fonts/font-parser';
import { isTrueTypeFontData, getGlyphOutline } from '../fonts/truetype-parser';
import { getCSSFontFamily, getStandardFont } from '../fonts/standard14';
import { decodeImage, UnsupportedImageFilterError } from './image-decoder';
import { parseColorSpace, rgbToCSSColor } from './color-space';
import { applyClipPaths } from './clipping';
import { assertTextClippingSupported } from './text-clipping-guard';
import { buildTextClippingOutline } from './text-clipping-outline';
import { toCanvasBlendMode } from './transparency';
import { parseSoftMask, type SoftMaskSubtype } from './soft-mask';
import {
  PDFDict,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFStream,
  PDFArray,
  type PDFDocumentData,
  type PDFPageInfo,
} from '../types';
import { intersectPageBox } from '../editing/coordinates';
import { assertCanvasScale, checkedCanvasDimensions } from './canvas-limits';
import { identityMatrix, multiplyMatrices, type Matrix } from './graphics-state';

// ─── Render options ─────────────────────────────────────────────────────────

export interface RenderOptions {
  /** Scale factor (1.0 = 72 DPI, 2.0 = 144 DPI, etc.) */
  scale: number;
  /** Background color (default: white) */
  background?: string;
  /** Whether to render text (default: true) */
  renderText?: boolean;
  /** Whether to render paths (default: true) */
  renderPaths?: boolean;
  /** Whether to render images (default: true) */
  renderImages?: boolean;
  /** Draw all widget appearances, text fields, or supported non-signature form fields. */
  renderWidgets?: boolean | 'text' | 'form';
  /**
   * Override devicePixelRatio used for canvas backing store.
   * Pass `1` for export/compression so Retina screens don't inflate file size.
   */
  devicePixelRatio?: number;
  /** Omit one selected placement when preparing a cached edit-preview background. */
  omitImage?: ImageItem;
  /** Internal context propagated to page, form, annotation and mask rendering. */
  optionalContent?: OptionalContentVisibility;
}

// ─── Render result ──────────────────────────────────────────────────────────

export interface RenderResult {
  /** The rendered canvas */
  canvas: HTMLCanvasElement;
  /** Raw text runs from the content stream */
  textRuns: TextRun[];
  /** Logical lines (bold + regular grouped) for Word-style editing */
  textLines: TextLine[];
  /** Full document flow model */
  documentFlow: DocumentFlow;
  /** Font data loaded for this page */
  fonts: Map<string, FontData>;
  /** Page dimensions in PDF points */
  pageWidth: number;
  pageHeight: number;
}

// ─── Main render functions ──────────────────────────────────────────────────

/**
 * Render a single page from a parsed PDF document to a canvas.
 */
export async function renderPage(
  doc: PDFDocumentData,
  pageIndex: number,
  options: RenderOptions,
): Promise<RenderResult> {
  if (pageIndex < 0 || pageIndex >= doc.pages.length) {
    throw new Error(`Page index ${pageIndex} out of range (0-${doc.pages.length - 1})`);
  }

  const page = doc.pages[pageIndex];
  return renderPageToCanvas(page, doc.objects, { ...options, optionalContent: new OptionalContentVisibility(doc.catalog, doc.objects) });
}

function isOmittedImage(item: ImageItem, omitted?: ImageItem): boolean {
  return !!omitted && item.name === omitted.name &&
    item.sourceInstructionIndex === omitted.sourceInstructionIndex &&
    item.x === omitted.x && item.y === omitted.y &&
    item.width === omitted.width && item.height === omitted.height;
}

/** /FT is inherited from the field tree, and must not be guessed for widgets. */
function widgetFieldType(widget: PDFDict, objects: Map<string, PDFObject>): string | undefined {
  const seen = new Set<PDFDict>();
  let current: PDFObject | undefined = widget;
  while (current instanceof PDFDict && !seen.has(current)) {
    seen.add(current);
    const type = current.get('FT');
    if (type) {
      const resolved = resolveRef(type, objects);
      return resolved instanceof PDFName ? resolved.name : undefined;
    }
    const parent = current.get('Parent');
    current = parent ? resolveRef(parent, objects) : undefined;
  }
  return undefined;
}

export interface ImagePreviewLayers {
  background: HTMLCanvasElement;
  image: HTMLCanvasElement;
}

/** Render once per selected geometry; subsequent previews only move/scale DOM layers. */
export async function renderImagePreviewLayers(
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  item: ImageItem,
  scale: number,
  catalog?: PDFDict,
): Promise<ImagePreviewLayers> {
  const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
  assertCanvasScale(scale);
  assertCanvasScale(dpr);
  const size = checkedCanvasDimensions(item.width * scale * dpr, item.height * scale * dpr);
  const optionalContent = new OptionalContentVisibility(catalog, objects);
  const { canvas: background } = await renderPageToCanvas(page, objects, { scale, omitImage: item, optionalContent, renderWidgets: 'form' });
  const image = document.createElement('canvas');
  image.width = size.width;
  image.height = size.height;
  const ctx = image.getContext('2d')!;
  ctx.scale(image.width / item.width, -image.height / item.height);
  ctx.translate(-item.x, -item.y - item.height);
  const masks = await buildSoftMaskMap([item], page, objects, { scale, optionalContent });
  await drawImage(ctx, item, page, objects, masks);
  return { background, image };
}

/**
 * Render a page to a new canvas element.
 */
export async function renderPageToCanvas(
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  options: RenderOptions,
): Promise<RenderResult> {
  options = { ...options, optionalContent: options.optionalContent ?? new OptionalContentVisibility(undefined, objects) };
  const scale = options.scale ?? 1;
  const background = options.background ?? '#ffffff';
  const renderText = options.renderText ?? true;
  const renderPaths = options.renderPaths ?? true;
  const renderImages = options.renderImages ?? true;

  // Compute page dimensions (accounting for rotation)
  const { mediaBox, rotate } = page;
  const viewportBox = intersectPageBox(mediaBox, page.cropBox);
  const isRotated = rotate === 90 || rotate === 270;
  const pageWidth = isRotated ? viewportBox.height : viewportBox.width;
  const pageHeight = isRotated ? viewportBox.width : viewportBox.height;

  const dpr =
    options.devicePixelRatio ??
    (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
  assertCanvasScale(scale);
  assertCanvasScale(dpr);
  const logical = checkedCanvasDimensions(pageWidth * scale, pageHeight * scale);
  const size = checkedCanvasDimensions(logical.width * dpr, logical.height * dpr);
  const logicalWidth = logical.width;
  const logicalHeight = logical.height;

  // All limits are checked before assigning dimensions to a canvas.
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  canvas.style.width = `${logicalWidth}px`;
  canvas.style.height = `${logicalHeight}px`;

  const ctx = canvas.getContext('2d')!;

  // Fill background
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Set up coordinate transformation:
  // PDF coordinates: origin at bottom-left, Y goes up
  // Canvas coordinates: origin at top-left, Y goes down
  ctx.save();
  ctx.scale(scale * dpr, scale * dpr);

  // Apply page rotation
  applyPageRotation(ctx, rotate, viewportBox.width, viewportBox.height);

  // Flip Y axis: PDF bottom-left → canvas top-left
  ctx.transform(1, 0, 0, -1, -viewportBox.x, viewportBox.y + viewportBox.height);

  // Get content stream bytes
  const contentBytes = getPageContentBytes(page, objects);

  const fonts = loadPageFonts(page.resources, objects);
  // Resolve supported glyph clipping paths while interpreting; text extraction
  // does not need font outlines and continues without this rendering callback.
  const interpreted = interpretPage(contentBytes, page, objects, options.optionalContent, 0,
    runs => buildTextClippingOutline(runs, fonts));
  assertTextClippingSupported(interpreted.displayList);
  assertSoftMaskCTMSupported(contentBytes, page, objects, interpreted.displayList);

  // Build flow model before drawing — justified lines use flow positions
  const documentFlow = buildDocumentFlow(interpreted.textRuns);

  // Register embedded fonts in the browser
  if (typeof window !== 'undefined') {
    await registerEmbeddedFonts(fonts);
  }

  // OCR text remains in the returned flow for search, but it must neither draw
  // nor influence the visual positioning of painted text on the same line.
  const paintFlow = buildDocumentFlow(interpreted.displayList.filter((item): item is TextRun =>
    item.type === 'text' && (item.renderingMode ?? 0) % 4 !== 3));
  const flowDraw = buildFlowDrawIndex(paintFlow.lines, fonts);
  const drawnJustifiedRuns = new Set<TextRun>();
  const softMaskMap = await buildSoftMaskMap(interpreted.displayList, page, objects, options);

  // Render display list
  for (let i = 0; i < interpreted.displayList.length; i++) {
    const item = interpreted.displayList[i];

    switch (item.type) {
      case 'path':
        if (renderPaths) drawPath(ctx, item, softMaskMap);
        break;
      case 'text':
        if (renderText) {
          drawTextRunWithFlow(ctx, item, fonts, flowDraw, drawnJustifiedRuns, softMaskMap);
        }
        break;
      case 'image':
        if (renderImages && !isOmittedImage(item, options.omitImage)) await drawImage(ctx, item, page, objects, softMaskMap);
        break;
      case 'inline-image':
        if (renderImages) await drawImage(ctx, item, page, objects, softMaskMap);
        break;
      case 'form':
        await drawFormItem(ctx, item, page, objects, options);
        break;
      case 'shading':
        if (renderImages) drawShadingItem(ctx, item, page, objects);
        break;
    }
  }

  // Render Annotations (Appearance Streams)
  const annotsRef = page.dict.get('Annots');
  let annotsObj = annotsRef;
  if (annotsRef instanceof PDFRef) {
    annotsObj = resolveRef(annotsRef, objects);
  }
  
  if (annotsObj instanceof PDFArray) {
    for (const annotRef of annotsObj.items) {
      const annotDict = annotRef instanceof PDFRef ? resolveRef(annotRef, objects) : annotRef;
      if (!(annotDict instanceof PDFDict)) continue;
      if (!isAnnotationVisible(annotDict, objects)) continue;
      const annotLayer = annotDict.get('OC');
      if (annotLayer && options.optionalContent && !options.optionalContent.isVisible(annotLayer)) continue;

      // Editors can render existing form appearances without also painting
      // signature widgets that may have separate interactive overlays.
      const subtypeEntry = annotDict.get('Subtype');
      const subtype = subtypeEntry ? resolveRef(subtypeEntry, objects) : undefined;
      const subtypeName = subtype instanceof PDFName ? subtype.name : '';
      if (subtypeName === 'Link') continue;
      if (subtypeName === 'Widget') {
        if (!options.renderWidgets) continue;
        if (options.renderWidgets !== true) {
          const type = widgetFieldType(annotDict, objects);
          if (options.renderWidgets === 'text' ? type !== 'Tx' : !type || !['Tx', 'Btn', 'Ch'].includes(type)) continue;
        }
      }
      
      const apRef = annotDict.get('AP');
      let apDict = apRef;
      if (apRef instanceof PDFRef) apDict = resolveRef(apRef, objects);
      
      if (apDict instanceof PDFDict) {
        const nRef = apDict.get('N');
        let nStream = nRef;
        if (nRef instanceof PDFRef) nStream = resolveRef(nRef, objects);
        if (nStream instanceof PDFDict) {
          // An appearance dictionary can contain named states for any
          // annotation. /AS selects the displayed appearance; an absent or
          // unknown state cannot be guessed safely.
          const stateRef = annotDict.get('AS');
          const state = stateRef ? resolveRef(stateRef, objects) : undefined;
          const appearance = state instanceof PDFName ? nStream.get(state.name) : undefined;
          nStream = appearance ? resolveRef(appearance, objects) : undefined;
        }
        
        if (nStream instanceof PDFStream) {
          const appearanceLayer = nStream.dict.get('OC');
          if (appearanceLayer && options.optionalContent && !options.optionalContent.isVisible(appearanceLayer)) continue;
          // Interpret this Appearance stream
          const annotResources = nStream.dict.get('Resources') || annotDict.get('Resources') || page.resources;
          const mockPage = {
            ...page,
            resources: annotResources instanceof PDFRef ? resolveRef(annotResources, objects) as PDFDict : (annotResources as PDFDict) || new PDFDict(),
          };
          
          // Need to decode the stream if not already decoded
          if (!nStream.decodedBytes) {
             const { applyFilters } = await import('../parser/filters');
             nStream.decodedBytes = await applyFilters(
                 nStream.rawBytes,
                 nStream.getFilters(),
                 nStream.getDecodeParams()
             );
          }
          // Now getBytes() will safely return the uncompressed bytes
          
          const annotFonts = loadPageFonts(mockPage.resources, objects);
          const annotInterpreted = interpretPage(nStream.getBytes(), mockPage, objects, options.optionalContent, 0,
            runs => buildTextClippingOutline(runs, annotFonts));
          assertTextClippingSupported(annotInterpreted.displayList);
          assertNoNestedSoftMask(annotInterpreted.displayList);
          if (typeof window !== 'undefined') {
            await registerEmbeddedFonts(annotFonts);
          }
          
          ctx.save();

          // Honor annotation /CA so translucent highlights aren't solid bars
          const caObj = annotDict.get('CA');
          const annotOpacity = caObj instanceof PDFNumber ? caObj.value : 1;
          if (annotOpacity < 0.999) {
            ctx.globalAlpha = annotOpacity;
          }
          if (subtypeName === 'Highlight') {
            ctx.globalCompositeOperation = 'multiply';
          }

          // ISO 32000 maps the appearance's *transformed* BBox to /Rect, then
          // applies its /Matrix. Ignoring the matrix changes rotated and sheared
          // appearances even when both rectangles happen to have the same size.
          const rectEntry = annotDict.get('Rect');
          const bboxEntry = nStream.dict.get('BBox');
          const rectObj = rectEntry ? resolveRef(rectEntry, objects) : null;
          const bboxObj = bboxEntry ? resolveRef(bboxEntry, objects) : null;
          const matrixEntry = nStream.dict.get('Matrix');
          const matrixObj = matrixEntry ? resolveRef(matrixEntry, objects) : null;
          const readNumbers = (value: PDFObject | undefined | null, count: number): number[] | null => {
            if (!(value instanceof PDFArray) || value.length !== count) return null;
            const result = value.items.map(item => resolveRef(item, objects));
            if (result.some(item => !(item instanceof PDFNumber) || !Number.isFinite(item.value))) return null;
            return result.map(item => (item as PDFNumber).value);
          };
          const rect = readNumbers(rectObj, 4);
          const bbox = readNumbers(bboxObj, 4);
          const m = matrixEntry ? readNumbers(matrixObj, 6) : [1, 0, 0, 1, 0, 0];
          if (!rect || !bbox || !m) {
            ctx.restore();
            console.warn('[Renderer] Skipping annotation with invalid appearance geometry');
            continue;
          }
          const [x0, y0, x1, y1] = bbox;
          const points = [[x0, y0], [x0, y1], [x1, y0], [x1, y1]].map(([x, y]) => [
            m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5],
          ]);
          const minX = Math.min(...points.map(point => point[0]));
          const maxX = Math.max(...points.map(point => point[0]));
          const minY = Math.min(...points.map(point => point[1]));
          const maxY = Math.max(...points.map(point => point[1]));
          const rectWidth = Math.abs(rect[2] - rect[0]);
          const rectHeight = Math.abs(rect[3] - rect[1]);
          const transformedWidth = maxX - minX;
          const transformedHeight = maxY - minY;
          const scaleX = rectWidth / transformedWidth;
          const scaleY = rectHeight / transformedHeight;
          if (![minX, maxX, minY, maxY, rectWidth, rectHeight, transformedWidth,
            transformedHeight, scaleX, scaleY].every(Number.isFinite) ||
              transformedWidth <= 0 || transformedHeight <= 0 || scaleX <= 0 || scaleY <= 0) {
            ctx.restore();
            console.warn('[Renderer] Skipping annotation with degenerate appearance geometry');
            continue;
          }
          ctx.translate(Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]));
          ctx.scale(scaleX, scaleY);
          ctx.translate(-minX, -minY);
          ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
          ctx.beginPath();
          ctx.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
          ctx.clip();

          for (let j = 0; j < annotInterpreted.displayList.length; j++) {
            const item = annotInterpreted.displayList[j];
            switch (item.type) {
              case 'path': if (renderPaths) drawPath(ctx, item); break;
              case 'text': if (renderText) drawTextRun(ctx, item, annotFonts); break;
              case 'image': if (renderImages) await drawImage(ctx, item, mockPage, objects); break;
              case 'inline-image': if (renderImages) await drawImage(ctx, item, mockPage, objects); break;
              case 'form': await drawFormItem(ctx, item, mockPage, objects, options); break;
              case 'shading': if (renderImages) drawShadingItem(ctx, item, mockPage, objects); break;
            }
          }
          ctx.restore();
        }
      }
    }
  }

  ctx.restore();

  return {
    canvas,
    textRuns: interpreted.textRuns,
    textLines: documentFlow.lines,
    documentFlow,
    fonts,
    pageWidth,
    pageHeight,
  };
}

// ─── Page rotation ──────────────────────────────────────────────────────────

function applyPageRotation(
  ctx: CanvasRenderingContext2D,
  rotate: number,
  width: number,
  height: number,
): void {
  switch (rotate) {
    case 90:
      ctx.translate(height, 0);
      ctx.rotate(Math.PI / 2);
      break;
    case 180:
      ctx.translate(width, height);
      ctx.rotate(Math.PI);
      break;
    case 270:
      ctx.translate(0, width);
      ctx.rotate(-Math.PI / 2);
      break;
    default:
      break;
  }
}

// ─── Soft mask group rendering ────────────────────────────────────────────────

const softMaskBounds = new WeakMap<HTMLCanvasElement, { x: number; y: number; width: number; height: number }>();
const softMaskWork = new WeakMap<Map<PDFDict, HTMLCanvasElement>, { pixels: number }>();
// Mask compositing temporarily needs two more full-size RGBA surfaces.
const MAX_SOFT_MASK_DEVICE_PIXELS = 8_000_000;
const MAX_SOFT_MASK_WORK_PIXELS = 64_000_000;

function reserveSoftMaskWork(budget: { pixels: number }, pixels: number): void {
  if (!Number.isSafeInteger(pixels) || pixels < 0 || pixels > MAX_SOFT_MASK_WORK_PIXELS - budget.pixels) {
    throw new Error('Soft-mask rendering exceeds its cumulative work limit.');
  }
  budget.pixels += pixels;
}

function assertNoNestedSoftMask(items: readonly DisplayItem[]): void {
  if (items.some(item => item.softMask)) throw new Error('Unsupported nested or annotation soft mask.');
}

/** The interpreter currently does not retain the CTM in effect at /SMask gs.
 * A non-identity setup cannot be mapped reliably and must not be painted as
 * though the mask had been established in page coordinates. */
function assertSoftMaskCTMSupported(content: Uint8Array, page: PDFPageInfo,
  objects: Map<string, PDFObject>, items: readonly DisplayItem[]): void {
  if (!items.some(item => item.softMask)) return;
  if (content.length > 8 * 1024 * 1024) throw new Error('Soft-mask graphics-state inspection exceeds its byte limit.');
  const instructions = parseContentStream(content);
  if (instructions.length > 100_000) throw new Error('Soft-mask graphics-state inspection exceeds its instruction limit.');
  let matrix: Matrix = identityMatrix();
  let uncertain = false;
  const stack: Array<{ matrix: Matrix; uncertain: boolean }> = [];
  for (const { operator, operands } of instructions) {
    if (operator === 'q') stack.push({ matrix: { ...matrix }, uncertain });
    else if (operator === 'Q') {
      const previous = stack.pop();
      if (!previous) uncertain = true;
      else { matrix = previous.matrix; uncertain = previous.uncertain; }
    } else if (operator === 'cm') {
      if (operands.length !== 6 || operands.some(value => !(value instanceof PDFNumber) || !Number.isFinite(value.value))) {
        uncertain = true;
      } else {
        const [a, b, c, d, e, f] = operands.map(value => (value as PDFNumber).value);
        matrix = multiplyMatrices({ a, b, c, d, e, f }, matrix);
        if (!Object.values(matrix).every(Number.isFinite)) uncertain = true;
      }
    } else if (operator === 'gs') {
      const name = operands[0];
      if (!(name instanceof PDFName)) continue;
      const state = getResource(page.resources, 'ExtGState', name.name, objects);
      const mask = state instanceof PDFDict ? state.get('SMask') : undefined;
      if (mask === undefined || resolveSoftMaskState(mask, objects) === null) continue;
      if (uncertain || matrix.a !== 1 || matrix.b !== 0 || matrix.c !== 0 ||
          matrix.d !== 1 || matrix.e !== 0 || matrix.f !== 0) {
        throw new Error('Unsupported soft mask established under a transformed graphics state.');
      }
    }
  }
}

function maskLuminance(r: number, g: number, b: number): number {
  // PDF's DeviceRGB-to-DeviceGray approximation, not sRGB linear luminance.
  return 0.30 * r + 0.59 * g + 0.11 * b;
}

function maskToAlphaCanvas(source: HTMLCanvasElement, subtype: SoftMaskSubtype): HTMLCanvasElement {
  const w = source.width;
  const h = source.height;
  checkedCanvasDimensions(w, h);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const sctx = source.getContext('2d')!;
  const octx = out.getContext('2d')!;
  const img = sctx.getImageData(0, 0, w, h);
  const outData = octx.createImageData(w, h);

  for (let i = 0; i < img.data.length; i += 4) {
    const r = img.data[i] / 255;
    const g = img.data[i + 1] / 255;
    const b = img.data[i + 2] / 255;
    const a = img.data[i + 3] / 255;
    const alpha = subtype === 'Luminosity' ? maskLuminance(r, g, b) * a : a;
    const v = Math.round(alpha * 255);
    outData.data[i] = 255;
    outData.data[i + 1] = 255;
    outData.data[i + 2] = 255;
    outData.data[i + 3] = v;
  }

  octx.putImageData(outData, 0, 0);
  return out;
}

async function renderSoftMaskGroup(
  softMask: PDFDict,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  options: RenderOptions,
): Promise<HTMLCanvasElement | null> {
  const info = parseSoftMask(softMask);
  const subtype = softMask.getName('S');
  if (!['Alpha', 'Luminosity'].includes(subtype ?? '') || softMask.has('TR') || softMask.has('BC')) {
    throw new Error('Unsupported soft-mask subtype, transfer function or backdrop.');
  }
  const gRef = softMask.get('G');
  if (!gRef) throw new Error('Unsupported soft-mask group: missing Form XObject.');

  const gObj = resolveRef(gRef, objects);
  if (!(gObj instanceof PDFStream)) throw new Error('Unsupported soft-mask group: invalid Form XObject.');

  const dict = gObj.dict;
  const layer = dict.get('OC');
  if (layer && options.optionalContent && !options.optionalContent.isVisible(layer)) {
    throw new OptionalContentError('hidden optional-content soft-mask groups are unsupported');
  }
  const { width: w, height: h } = checkedCanvasDimensions(page.mediaBox.width, page.mediaBox.height);
  if (w * h > MAX_SOFT_MASK_DEVICE_PIXELS) throw new Error('Soft-mask canvas exceeds the supported pixel limit.');
  const rawBox = readFormGeometry(dict, objects, 'BBox', 4);
  const bbox = [Math.min(rawBox[0], rawBox[2]), Math.min(rawBox[1], rawBox[3]),
    Math.max(rawBox[0], rawBox[2]), Math.max(rawBox[1], rawBox[3])];
  if (bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) throw new Error('Invalid Form XObject /BBox: empty soft-mask bounds.');
  const matrix = readFormGeometry(dict, objects, 'Matrix', 6, [1, 0, 0, 1, 0, 0]);
  const groupValue = dict.get('Group');
  const group = groupValue ? resolveRef(groupValue, objects) : undefined;
  if (!(group instanceof PDFDict) || group.getName('S') !== 'Transparency' || group.getBool('I') !== true ||
      group.getBool('K') === true || !['DeviceRGB', 'DeviceGray'].includes(group.getName('CS') ?? '')) {
    throw new Error('Unsupported soft-mask transparency group.');
  }
  const rgbCanvas = document.createElement('canvas');
  rgbCanvas.width = w;
  rgbCanvas.height = h;
  const rgbCtx = rgbCanvas.getContext('2d')!;
  rgbCtx.save();
  rgbCtx.transform(1, 0, 0, -1, -page.mediaBox.x, page.mediaBox.y + page.mediaBox.height);
  rgbCtx.transform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);

  const formResourcesRef = dict.get('Resources');
  let formResources = page.resources;
  if (formResourcesRef) {
    const resolved = resolveRef(formResourcesRef, objects);
    if (resolved instanceof PDFDict) formResources = resolved;
  }

  if (!gObj.decodedBytes) {
    const { applyFilters } = await import('../parser/filters');
    gObj.decodedBytes = await applyFilters(
      gObj.rawBytes,
      gObj.getFilters(),
      gObj.getDecodeParams(),
    );
  }

  const formPage: PDFPageInfo = { ...page, resources: formResources };
  const formFonts = loadPageFonts(formResources, objects);
  const interpreted = interpretPage(gObj.getBytes(), formPage, objects, options.optionalContent, 0,
    runs => buildTextClippingOutline(runs, formFonts));
  assertTextClippingSupported(interpreted.displayList);
  assertNoNestedSoftMask(interpreted.displayList);
  if (typeof window !== 'undefined') {
    await registerEmbeddedFonts(formFonts);
  }

  rgbCtx.beginPath();
  rgbCtx.rect(bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]);
  rgbCtx.clip();

  const emptyMask = new Map<PDFDict, HTMLCanvasElement>();
  for (let i = 0; i < interpreted.displayList.length; i++) {
    const item = interpreted.displayList[i];
    switch (item.type) {
      case 'path': drawPath(rgbCtx, item, emptyMask); break;
      case 'text': drawTextRun(rgbCtx, item, formFonts, emptyMask); break;
      case 'image': await drawImage(rgbCtx, item, formPage, objects, emptyMask); break;
      case 'inline-image': await drawImage(rgbCtx, item, formPage, objects, emptyMask); break;
      case 'form': await drawFormItem(rgbCtx, item, formPage, objects, options); break;
      case 'shading': drawShadingItem(rgbCtx, item, formPage, objects); break;
    }
  }

  rgbCtx.restore();

  const alphaCanvas = maskToAlphaCanvas(rgbCanvas, info.subtype);
  softMaskBounds.set(alphaCanvas, { x: page.mediaBox.x, y: page.mediaBox.y,
    width: page.mediaBox.width, height: page.mediaBox.height });
  return alphaCanvas;
}

async function buildSoftMaskMap(
  items: DisplayItem[],
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  options: RenderOptions,
): Promise<Map<PDFDict, HTMLCanvasElement>> {
  const map = new Map<PDFDict, HTMLCanvasElement>();
  const budget = { pixels: 0 };
  softMaskWork.set(map, budget);
  const seen = new Set<PDFDict>();

  for (let i = 0; i < items.length; i++) {
    const sm = items[i].softMask;
    if (sm && !seen.has(sm)) {
      seen.add(sm);
      const size = checkedCanvasDimensions(page.mediaBox.width, page.mediaBox.height);
      reserveSoftMaskWork(budget, size.width * size.height * 2);
      const canvas = await renderSoftMaskGroup(sm, page, objects, options);
      if (canvas) map.set(sm, canvas);
    }
  }

  return map;
}

function drawWithSoftMask(
  ctx: CanvasRenderingContext2D,
  softMask: PDFDict | null,
  maskMap: Map<PDFDict, HTMLCanvasElement>,
  blendMode: string,
  paint: (target: CanvasRenderingContext2D) => void,
): void {
  if (!softMask) {
    paint(ctx);
    return;
  }
  const mask = maskMap.get(softMask);
  const maskBounds = mask && softMaskBounds.get(mask);
  if (!mask || !maskBounds) throw new Error('Unsupported unresolved soft mask.');
  const { width, height } = checkedCanvasDimensions(ctx.canvas.width, ctx.canvas.height);
  if (width * height > MAX_SOFT_MASK_DEVICE_PIXELS) throw new Error('Soft-mask canvas exceeds the supported pixel limit.');
  const budget = softMaskWork.get(maskMap);
  if (!budget) throw new Error('Unsupported soft-mask rendering context.');
  reserveSoftMaskWork(budget, width * height * 2);
  const foreground = document.createElement('canvas');
  foreground.width = width; foreground.height = height;
  const foregroundCtx = foreground.getContext('2d')!;
  const transform = ctx.getTransform();
  foregroundCtx.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
  paint(foregroundCtx);

  // Mask the isolated source rather than the page: destination-in on the page
  // itself would also erase previously painted content under this object.
  const deviceMask = document.createElement('canvas');
  deviceMask.width = width; deviceMask.height = height;
  const maskCtx = deviceMask.getContext('2d')!;
  maskCtx.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
  maskCtx.translate(maskBounds.x, maskBounds.y + maskBounds.height);
  maskCtx.scale(1, -1);
  maskCtx.drawImage(mask, 0, 0, maskBounds.width, maskBounds.height);
  foregroundCtx.setTransform(1, 0, 0, 1, 0, 0);
  foregroundCtx.globalCompositeOperation = 'destination-in';
  foregroundCtx.drawImage(deviceMask, 0, 0);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = toCanvasBlendMode(blendMode);
  ctx.drawImage(foreground, 0, 0);
  ctx.restore();
}

// ─── Path rendering ─────────────────────────────────────────────────────────

function drawPath(
  ctx: CanvasRenderingContext2D,
  item: PathItem,
  maskMap: Map<PDFDict, HTMLCanvasElement> = new Map(),
): void {
  if (item.segments.length === 0) return;

  drawWithSoftMask(ctx, item.softMask, maskMap, item.blendMode, ctx => {
    ctx.save();
    ctx.globalCompositeOperation = toCanvasBlendMode(item.blendMode);
    applyClipPaths(ctx, item.clipPaths);

    ctx.beginPath();

    for (let i = 0; i < item.segments.length; i++) {
      const seg = item.segments[i];
      switch (seg.type) {
        case 'M':
          ctx.moveTo(seg.points[0], seg.points[1]);
          break;
        case 'L':
          ctx.lineTo(seg.points[0], seg.points[1]);
          break;
        case 'C':
          ctx.bezierCurveTo(
            seg.points[0], seg.points[1],
            seg.points[2], seg.points[3],
            seg.points[4], seg.points[5],
          );
          break;
        case 'Z':
          ctx.closePath();
          break;
      }
    }

    if (item.paintType === 'fill' || item.paintType === 'both') {
      if (item.fillColor) {
        ctx.fillStyle = rgbToCSSColor(item.fillColor, item.fillAlpha);
        ctx.fill();
      }
    }

    if (item.paintType === 'stroke' || item.paintType === 'both') {
      if (item.strokeColor) {
        ctx.strokeStyle = rgbToCSSColor(item.strokeColor, item.strokeAlpha);
        ctx.lineWidth = item.lineWidth;
        ctx.stroke();
      }
    }

    ctx.restore();
  });
}

// ─── Text rendering ─────────────────────────────────────────────────────────

/** Strip PDF subset prefix (e.g. "ABCDEF+TimesNewRomanPSMT" → "TimesNewRomanPSMT"). */
function stripFontSubsetPrefix(baseFont: string): string {
  const plus = baseFont.indexOf('+');
  return plus >= 0 ? baseFont.slice(plus + 1) : baseFont;
}

/**
 * CSS/FontFace-safe family name.
 * PDF BaseFonts often look like "Times New Roman,Bold" — the comma breaks
 * unquoted CSS font-family lists, so we normalize style suffixes to spaces.
 */
function cssFontFamilyName(baseFont: string): string {
  let name = stripFontSubsetPrefix(baseFont) || baseFont;
  // "Family,Bold" / "Family,BoldItalic" → "Family Bold" / "Family BoldItalic"
  name = name.replace(/,(\s*)(Bold|Italic|BoldItalic|Oblique|Regular|Light|Medium|Black)/gi, ' $2');
  return name.trim();
}

function isDingbatOrSymbolFamily(baseFont: string): boolean {
  const lower = (stripFontSubsetPrefix(baseFont) || baseFont).toLowerCase();
  return lower.includes('zapf') || lower.includes('dingbat') || lower === 'symbol' || lower.endsWith('symbol');
}

// Some Linux canvas implementations do not resolve generic monospace to a
// metric-compatible face. These common substitutes retain Courier advances.
const COURIER_CANVAS_FAMILY = '"Courier New", Courier, "Liberation Mono", "Nimbus Mono PS", "Noto Sans Mono", monospace';

type FlowDrawIndex = ReturnType<typeof buildFlowDrawIndex>;

/** Canvas strokes in text space; PDF strokes in graphics-state space. Only
 * use a scalar correction when the relative transform is conformal. */
function configureTextStroke(ctx: CanvasRenderingContext2D, run: TextRun,
  textMatrix: Matrix, horizontalFit: number): void {
  const width = run.strokeLineWidth ?? 1;
  if (!Number.isFinite(width) || width < 0) throw new Error('Invalid text stroke width.');
  if (width === 0) throw new Error('Hairline text stroke is unsupported.');
  const c = run.strokeCTM ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const determinant = c.a * c.d - c.b * c.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
    throw new Error('Text stroke under a singular graphics transform is unsupported.');
  }
  const ax = (c.d * textMatrix.a - c.c * textMatrix.b) / determinant * horizontalFit;
  const ay = (-c.b * textMatrix.a + c.a * textMatrix.b) / determinant * horizontalFit;
  const bx = (c.d * textMatrix.c - c.c * textMatrix.d) / determinant;
  const by = (-c.b * textMatrix.c + c.a * textMatrix.d) / determinant;
  const sx = Math.hypot(ax, ay), sy = Math.hypot(bx, by);
  if (![sx, sy].every(Number.isFinite) || Math.min(sx, sy) < 1e-12 ||
      Math.abs(sx - sy) > Math.max(sx, sy) * 0.01 || Math.abs(ax * bx + ay * by) > sx * sy * 0.01) {
    throw new Error('Text stroke under a nonuniform text transform is unsupported.');
  }
  const scale = Math.sqrt(sx * sy);
  ctx.lineWidth = width / scale;
  ctx.strokeStyle = rgbToCSSColor(run.strokeColor ?? [0, 0, 0], run.strokeAlpha ?? 1);
  ctx.lineCap = (['butt', 'round', 'square'] as const)[run.strokeLineCap ?? 0] ?? 'butt';
  ctx.lineJoin = (['miter', 'round', 'bevel'] as const)[run.strokeLineJoin ?? 0] ?? 'miter';
  ctx.miterLimit = run.strokeMiterLimit ?? 10;
  ctx.setLineDash((run.strokeDashPattern ?? []).map(value => value / scale));
  ctx.lineDashOffset = (run.strokeDashPhase ?? 0) / scale;
}

function paintCanvasText(ctx: CanvasRenderingContext2D, text: string, run: TextRun,
  matrix: Matrix, horizontalFit: number): void {
  const mode = (run.renderingMode ?? 0) % 4;
  if (mode === 0 || mode === 2) ctx.fillText(text, 0, 0);
  if (mode === 1 || mode === 2) {
    configureTextStroke(ctx, run, matrix, horizontalFit);
    ctx.strokeText(text, 0, 0);
  }
}

/** Paint a validated embedded TrueType outline in graphics-state space so
 * the stroke width is unaffected by the glyph's own text matrix. */
function paintVerifiedTextOutline(ctx: CanvasRenderingContext2D, run: TextRun,
  fonts: Map<string, FontData>): void {
  const mode = (run.renderingMode ?? 0) % 4;
  const width = run.strokeLineWidth ?? 1;
  if (mode === 1 || mode === 2) {
    if (!Number.isFinite(width) || width < 0) throw new Error('Invalid text stroke width.');
    if (width === 0) throw new Error('Hairline text stroke is unsupported.');
  }
  const outline = buildTextClippingOutline([run], fonts);
  const c = run.strokeCTM ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const determinant = c.a * c.d - c.b * c.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) throw new Error('Text outline has a singular graphics transform.');
  const untransform = (x: number, y: number): [number, number] => {
    const dx = x - c.e, dy = y - c.f;
    return [(c.d * dx - c.c * dy) / determinant, (-c.b * dx + c.a * dy) / determinant];
  };
  ctx.save();
  ctx.transform(c.a, c.b, c.c, c.d, c.e, c.f);
  ctx.beginPath();
  for (const segment of outline.segments) {
    const p = segment.points;
    if (segment.type === 'M' || segment.type === 'L') {
      const [x, y] = untransform(p[0], p[1]);
      if (segment.type === 'M') ctx.moveTo(x, y); else ctx.lineTo(x, y);
    } else if (segment.type === 'C') {
      const a = untransform(p[0], p[1]), b = untransform(p[2], p[3]), d = untransform(p[4], p[5]);
      ctx.bezierCurveTo(a[0], a[1], b[0], b[1], d[0], d[1]);
    } else if (segment.type === 'Z') ctx.closePath();
  }
  if (mode === 0 || mode === 2) ctx.fill();
  if (mode === 1 || mode === 2) {
    ctx.lineWidth = width;
    ctx.strokeStyle = rgbToCSSColor(run.strokeColor ?? [0, 0, 0], run.strokeAlpha ?? 1);
    ctx.lineCap = (['butt', 'round', 'square'] as const)[run.strokeLineCap ?? 0] ?? 'butt';
    ctx.lineJoin = (['miter', 'round', 'bevel'] as const)[run.strokeLineJoin ?? 0] ?? 'miter';
    ctx.miterLimit = run.strokeMiterLimit ?? 10;
    ctx.setLineDash(run.strokeDashPattern ?? []);
    ctx.lineDashOffset = run.strokeDashPhase ?? 0;
    ctx.stroke();
  }
  ctx.restore();
}

function drawTextRunWithFlow(
  ctx: CanvasRenderingContext2D,
  run: TextRun,
  fonts: Map<string, FontData>,
  flowDraw: FlowDrawIndex,
  drawnJustifiedRuns: Set<TextRun>,
  maskMap: Map<PDFDict, HTMLCanvasElement> = new Map(),
): void {
  if ((run.renderingMode ?? 0) % 4 === 3) return;
  if (drawnJustifiedRuns.has(run)) return;

  if (run.textClipSupported) { drawTextRun(ctx, run, fonts, maskMap); return; }

  const line = flowDraw.runToLine.get(run);
  if (line && flowDraw.justifiedLines.has(line)) {
    drawJustifiedTextLine(ctx, line, flowDraw, fonts, drawnJustifiedRuns, maskMap);
    return;
  }

  drawTextRun(ctx, run, fonts, maskMap);
}

function drawJustifiedTextLine(
  ctx: CanvasRenderingContext2D,
  line: TextLine,
  flowDraw: FlowDrawIndex,
  fonts: Map<string, FontData>,
  drawnJustifiedRuns: Set<TextRun>,
  maskMap: Map<PDFDict, HTMLCanvasElement> = new Map(),
): void {
  const drawMap = flowDraw.drawMaps.get(line);
  if (!drawMap) {
    for (let r = 0; r < line.runs.length; r++) {
      drawTextRun(ctx, line.runs[r], fonts, maskMap);
      drawnJustifiedRuns.add(line.runs[r]);
    }
    return;
  }

  for (let r = 0; r < line.runs.length; r++) {
    const run = line.runs[r];
    const positions = drawMap.get(run);
    if (positions && positions.length > 0) {
      drawTextRunAtPositions(ctx, run, fonts, positions, maskMap);
    } else {
      drawTextRun(ctx, run, fonts, maskMap);
    }
    drawnJustifiedRuns.add(run);
  }
}

function drawTextRunAtPositions(
  ctx: CanvasRenderingContext2D,
  run: TextRun,
  fonts: Map<string, FontData>,
  positions: FlowGlyphDraw[],
  maskMap: Map<PDFDict, HTMLCanvasElement> = new Map(),
): void {
  if ((run.renderingMode ?? 0) % 4 === 3) return;
  if (positions.length === 0) return;
  if (run.textClipSupported) { drawTextRun(ctx, run, fonts, maskMap); return; }
  if (run.actualText) { drawTextRun(ctx, run, fonts, maskMap); return; }

  const bounds = { x: run.x, y: run.y, width: run.width, height: run.height };
  drawWithSoftMask(ctx, run.softMask, maskMap, run.blendMode, ctx => {
    ctx.save();
    ctx.globalCompositeOperation = toCanvasBlendMode(run.blendMode);
    applyClipPaths(ctx, run.clipPaths, bounds);

    const fontData = fonts.get(run.fontName);
    const fillColor = rgbToCSSColor(run.fillColor, run.fillAlpha);
    const { family, weight, style } = getCanvasFontProperties(run.fontName, fontData);
    ctx.fillStyle = fillColor;

    if (fontData?.charProcs && [1, 2].includes((run.renderingMode ?? 0) % 4)) {
      throw new Error('Stroked Type 3 text is unsupported.');
    }
    if (fontData?.charProcs) {
      // Type3 — must draw glyph-by-glyph
      for (let i = 0; i < positions.length; i++) {
        const glyph = positions[i].glyph;
        if (glyph.unicode === ' ' || glyph.unicode === '\u00A0') continue;
        const charName = type3CharName(fontData, glyph.charCode ?? glyph.unicode.charCodeAt(0));
        if (charName) {
          drawType3Glyph(
            ctx, fontData, charName, positions[i].x, positions[i].f, run.fontSize
          );
        } else {
          drawGlyph(ctx, glyph, run, family, weight, style, fillColor, positions[i].x, positions[i].f);
        }
      }
    } else {
      // Group glyphs into chunks; split on whitespace OR large/negative TJ gaps.
      type Chunk = { start: number; end: number; text: string };
      const chunks: Chunk[] = [];
      let ci = 0;
      const gapFrac = CHUNK_GAP_FRAC;

      while (ci < positions.length) {
        if (positions[ci].glyph.unicode === ' ' || positions[ci].glyph.unicode === '\u00A0') {
          ci++;
          continue;
        }
        const start = ci;
        let text = positions[ci].glyph.unicode;
        ci++;
        while (
          ci < positions.length &&
          positions[ci].glyph.unicode !== ' ' &&
          positions[ci].glyph.unicode !== '\u00A0'
        ) {
          const prev = positions[ci - 1];
          const cur = positions[ci];
          const gap = cur.x - (prev.x + prev.glyph.width);
          const fs = cur.glyph.fontSize || run.fontSize || 12;
          if (gap > fs * gapFrac || gap < -fs * 0.02) break;
          text += cur.glyph.unicode;
          ci++;
        }
        if (text.length > 0) {
          chunks.push({ start, end: ci, text });
        }
      }

      const nextDrawable = (from: number): number => {
        for (let i = from; i < positions.length; i++) {
          const u = positions[i].glyph.unicode;
          if (u !== ' ' && u !== '\u00A0') return i;
        }
        return -1;
      };

      for (const chunk of chunks) {
        const firstPos = positions[chunk.start];
        const { tRm } = firstPos.glyph;
        const effFontSize = Math.sqrt(tRm.c * tRm.c + tRm.d * tRm.d);
        if (effFontSize < 0.1) continue;

        const pdfSpan = chunkPdfSpan(
          i => positions[i].x,
          i => positions[i].glyph.width,
          i => positions[i].glyph.fontSize || run.fontSize || 12,
          chunk.start,
          chunk.end,
          positions.length,
          nextDrawable,
        );

        ctx.save();
        ctx.transform(
          tRm.a / effFontSize, tRm.b / effFontSize,
          tRm.c / effFontSize, tRm.d / effFontSize,
          firstPos.x, firstPos.f,
        );
        ctx.scale(1, -1);

        if (isBulletOnlyText(chunk.text) && (run.renderingMode ?? 0) % 4 === 0) {
          fillBulletDot(ctx, effFontSize, pdfSpan, fillColor);
          ctx.restore();
          continue;
        }

        ctx.font = `${style} ${weight} ${effFontSize}px ${family}`;

        let horizontalFit = 1;
        if (pdfSpan > 0.5 && chunk.text.length > 0) {
          const browserWidth = ctx.measureText(chunk.text).width;
          if (browserWidth > 0.1) {
            const hScale = Math.abs(tRm.a) / effFontSize;
            const expectedWidth = pdfSpan / (hScale || 1);
            let ratio = expectedWidth / browserWidth;
            // Clamp extreme ratios from missing FontFace / bad widths.
            ratio = Math.max(0.4, Math.min(2.5, ratio));
            if (Math.abs(ratio - 1) > 0.005) {
              ctx.scale(ratio, 1);
              horizontalFit = ratio;
            }
          }
        }

        paintCanvasText(ctx, chunk.text, run, { a: tRm.a / effFontSize, b: tRm.b / effFontSize,
          c: tRm.c / effFontSize, d: tRm.d / effFontSize, e: 0, f: 0 }, horizontalFit);

        if (run.isUnderline && (run.renderingMode ?? 0) % 4 === 0) {
          const underlineY = effFontSize * 0.15;
          const underlineThickness = Math.max(1, effFontSize * 0.05);
          const charWidth = ctx.measureText(chunk.text).width;
          ctx.beginPath();
          ctx.moveTo(0, underlineY);
          ctx.lineTo(charWidth, underlineY);
          ctx.lineWidth = underlineThickness;
          ctx.strokeStyle = fillColor;
          ctx.stroke();
        }

        ctx.restore();
      }
    }

    ctx.restore();
  });
}

import { drawType3Glyph, type3CharName } from './type3';

function drawTextRun(
  ctx: CanvasRenderingContext2D,
  run: TextRun,
  fonts: Map<string, FontData>,
  maskMap: Map<PDFDict, HTMLCanvasElement> = new Map(),
): void {
  if ((run.renderingMode ?? 0) % 4 === 3 || run.glyphs.length === 0) return;

  const bounds = { x: run.x, y: run.y, width: run.width, height: run.height };
  drawWithSoftMask(ctx, run.softMask, maskMap, run.blendMode, ctx => {
    ctx.save();
    ctx.globalCompositeOperation = toCanvasBlendMode(run.blendMode);
    applyClipPaths(ctx, run.clipPaths, bounds);

    const fontData = fonts.get(run.fontName);
    const fillColor = rgbToCSSColor(run.fillColor, run.fillAlpha);
    const { family, weight, style } = getCanvasFontProperties(run.fontName, fontData);
    ctx.fillStyle = fillColor;

    const isType3 = fontData?.charProcs && fontData.charProcs.size > 0;

    if (run.textClipSupported) {
      paintVerifiedTextOutline(ctx, run, fonts);
    } else if (isType3 && [1, 2].includes((run.renderingMode ?? 0) % 4)) {
      throw new Error('Stroked Type 3 text is unsupported.');
    } else if (run.actualText && fontData?.ttfFont && fontData.cidToGidMap) {
      // ActualText is extraction metadata, never a replacement for positioned outlines.
      const ttf = fontData.ttfFont, mapping = fontData.cidToGidMap;
      for (const glyph of run.glyphs) {
        const at = glyph.charCode * 2;
        if (at + 1 >= mapping.length) continue;
        const gid = (mapping[at] << 8) | mapping[at + 1];
        const outline = getGlyphOutline(ttf, gid);
        if (!outline) continue;
        const m = glyph.tRm, scale = 1 / ttf.unitsPerEm;
        ctx.save();
        ctx.transform(m.a * scale, m.b * scale, m.c * scale, m.d * scale, m.e, m.f);
        ctx.beginPath();
        for (const command of outline.commands) {
          const p = command.args;
          switch (command.type) {
            case 'M': ctx.moveTo(p[0], p[1]); break;
            case 'L': ctx.lineTo(p[0], p[1]); break;
            case 'Q': ctx.quadraticCurveTo(p[0], p[1], p[2], p[3]); break;
            case 'C': ctx.bezierCurveTo(p[0], p[1], p[2], p[3], p[4], p[5]); break;
            case 'Z': ctx.closePath(); break;
          }
        }
        const mode = (run.renderingMode ?? 0) % 4;
        if (mode === 0 || mode === 2) ctx.fill();
        if (mode === 1 || mode === 2) {
          configureTextStroke(ctx, run, { a: m.a * scale, b: m.b * scale,
            c: m.c * scale, d: m.d * scale, e: 0, f: 0 }, 1);
          ctx.stroke();
        }
        ctx.restore();
      }
    } else if (isType3) {
      for (let i = 0; i < run.glyphs.length; i++) {
        const glyph = run.glyphs[i];
        const name = type3CharName(fontData!, glyph.charCode ?? glyph.unicode.charCodeAt(0));
        if (name) {
          const drawn = drawType3Glyph(
            ctx, fontData!, name, glyph.tRm.e, glyph.tRm.f,
            Math.sqrt(glyph.tRm.c * glyph.tRm.c + glyph.tRm.d * glyph.tRm.d) || run.fontSize,
          );
          if (drawn) continue;
        }
        drawGlyph(ctx, glyph, run, family, weight, style, fillColor, glyph.tRm.e, glyph.tRm.f);
      }
    } else {
      drawWordGrouped(ctx, run, family, weight, style, fillColor);
    }

    ctx.restore();
  });
}

/** Split chunks when TJ inserts a large gap (do not stretch fillText across it). */
const CHUNK_GAP_FRAC = 0.12;

/**
 * Horizontal span for a glyph chunk in PDF user units.
 *
 * Acrobat/PDF.js place each glyph at its PDF origin; we approximate that by
 * scaling a fillText word so it occupies [first.x, last.x + last.width].
 * Only clamp when the span would draw into the next glyph's origin — never
 * leave padding that becomes a visible river before punctuation.
 */
function chunkPdfSpan(
  getX: (i: number) => number,
  getWidth: (i: number) => number,
  getFs: (i: number) => number,
  start: number,
  end: number,
  len: number,
  findNextDrawable: (from: number) => number,
): number {
  const firstX = getX(start);
  const last = end - 1;
  const fs = getFs(last);
  const lastW = getWidth(last);
  // Cap only pathological Widths entries (would invade neighbors).
  let span = (getX(last) - firstX) + (lastW > fs * 1.2 ? fs * 0.65 : lastW);

  const next = findNextDrawable(end);
  if (next >= 0 && next < len) {
    // Hard stop at the next glyph origin — zero padding so substitute-font
    // scaling fills the PDF slot completely (PDFBOX-520 / Acrobat parity).
    const maxSpan = getX(next) - firstX;
    if (maxSpan > 0.5) span = Math.min(span, maxSpan);
  }

  return Math.max(span, 0.5);
}

/**
 * Bullet / list-marker code points. System Times often paints U+2022 as a
 * square block; draw these as circles for Acrobat-like round dots.
 */
function isBulletCodePoint(cp: number): boolean {
  return (
    cp === 0x2022 || // •
    cp === 0x25CF || // ●
    cp === 0x25AA || // ▪
    cp === 0x25A0 || // ■ (ZapfDingbats filled box used as bullet)
    cp === 0x00B7 || // ·
    cp === 0x2219 || // ∙
    cp === 0x2043 || // ⁃
    cp === 0x25E6 || // ◦
    cp === 0x2023    // ‣
  );
}

function isBulletOnlyText(text: string): boolean {
  if (!text) return false;
  let saw = false;
  for (const ch of text) {
    if (ch === ' ' || ch === '\u00A0') continue;
    const cp = ch.codePointAt(0);
    if (cp == null || !isBulletCodePoint(cp)) return false;
    saw = true;
  }
  return saw;
}

/** Filled circle in the same local space as fillText(0,0) after scale(1,-1). */
function fillBulletDot(
  ctx: CanvasRenderingContext2D,
  fontSize: number,
  advance: number,
  fillColor: string,
): void {
  const slot = Math.max(advance, fontSize * 0.35);
  const r = Math.max(0.45, Math.min(fontSize * 0.17, slot * 0.32));
  const cx = slot * 0.45;
  // Optical center of a list bullet (between baseline and cap-height).
  const cy = -fontSize * 0.32;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = fillColor;
  ctx.fill();
}

/**
 * Draw run text by grouping consecutive non-space glyphs into word chunks.
 * Each chunk is a single fillText call, scaled to a span that must not
 * invade the following glyph's slot.
 */
function drawWordGrouped(
  ctx: CanvasRenderingContext2D,
  run: TextRun,
  family: string,
  weight: string,
  style: string,
  fillColor: string,
): void {
  const glyphs = run.glyphs;
  if (glyphs.length === 0) return;

  type Chunk = { start: number; end: number; text: string };
  const chunks: Chunk[] = [];
  let ci = 0;

  while (ci < glyphs.length) {
    if (glyphs[ci].unicode === ' ' || glyphs[ci].unicode === '\u00A0') {
      ci++;
      continue;
    }
    const start = ci;
    let text = glyphs[ci].unicode;
    ci++;
    while (ci < glyphs.length && glyphs[ci].unicode !== ' ' && glyphs[ci].unicode !== '\u00A0') {
      const prev = glyphs[ci - 1];
      const cur = glyphs[ci];
      const gap = cur.tRm.e - (prev.tRm.e + prev.width);
      const fs = cur.fontSize || run.fontSize || 12;
      // Split on large gaps OR overlaps (negative gaps from width errors)
      if (gap > fs * CHUNK_GAP_FRAC || gap < -fs * 0.02) break;
      text += cur.unicode;
      ci++;
    }
    if (text.length > 0) {
      chunks.push({ start, end: ci, text });
    }
  }

  const nextDrawable = (from: number): number => {
    for (let i = from; i < glyphs.length; i++) {
      if (glyphs[i].unicode !== ' ' && glyphs[i].unicode !== '\u00A0') return i;
    }
    return -1;
  };

  for (const chunk of chunks) {
    const firstGlyph = glyphs[chunk.start];
    const { tRm } = firstGlyph;
    const effFontSize = Math.sqrt(tRm.c * tRm.c + tRm.d * tRm.d);
    if (effFontSize < 0.1) continue;

    const pdfSpan = chunkPdfSpan(
      i => glyphs[i].tRm.e,
      i => glyphs[i].width,
      i => glyphs[i].fontSize || run.fontSize || 12,
      chunk.start,
      chunk.end,
      glyphs.length,
      nextDrawable,
    );

    ctx.save();
    ctx.transform(
      tRm.a / effFontSize, tRm.b / effFontSize,
      tRm.c / effFontSize, tRm.d / effFontSize,
      firstGlyph.tRm.e, firstGlyph.tRm.f,
    );
    ctx.scale(1, -1);

    // Round geometric dots — system Times/serif often paint U+2022 as a square.
    if (isBulletOnlyText(chunk.text) && (run.renderingMode ?? 0) % 4 === 0) {
      fillBulletDot(ctx, effFontSize, pdfSpan, fillColor);
      ctx.restore();
      continue;
    }

    ctx.font = `${style} ${weight} ${effFontSize}px ${family}`;

    let horizontalFit = 1;
    if (pdfSpan > 0.5 && chunk.text.length > 0) {
      const browserWidth = ctx.measureText(chunk.text).width;
      if (browserWidth > 0.1) {
        const hScale = Math.abs(tRm.a) / effFontSize;
        const expectedWidth = pdfSpan / (hScale || 1);
        let ratio = expectedWidth / browserWidth;
        // Wider clamp so substitute fonts can still fill PDF slots.
        ratio = Math.max(0.4, Math.min(2.5, ratio));
        if (Math.abs(ratio - 1) > 0.005) {
          ctx.scale(ratio, 1);
          horizontalFit = ratio;
        }
      }
    }

    paintCanvasText(ctx, chunk.text, run, { a: tRm.a / effFontSize, b: tRm.b / effFontSize,
      c: tRm.c / effFontSize, d: tRm.d / effFontSize, e: 0, f: 0 }, horizontalFit);

    if (run.isUnderline && (run.renderingMode ?? 0) % 4 === 0) {
      const underlineY = effFontSize * 0.15;
      const underlineThickness = Math.max(1, effFontSize * 0.05);
      const charWidth = ctx.measureText(chunk.text).width;
      ctx.beginPath();
      ctx.moveTo(0, underlineY);
      ctx.lineTo(charWidth, underlineY);
      ctx.lineWidth = underlineThickness;
      ctx.strokeStyle = fillColor;
      ctx.stroke();
    }

    ctx.restore();
  }
}

function drawGlyph(
  ctx: CanvasRenderingContext2D,
  glyph: GlyphPosition,
  run: TextRun,
  family: string,
  weight: string,
  style: string,
  fillColor: string,
  x: number,
  f: number,
): void {
  const { tRm } = glyph;
  const effFontSize = Math.sqrt(tRm.c * tRm.c + tRm.d * tRm.d);
  if (effFontSize < 0.1) return;
  if (glyph.unicode === ' ' || glyph.unicode === '\u00A0') return;

  ctx.save();
  ctx.transform(
    tRm.a / effFontSize, tRm.b / effFontSize,
    tRm.c / effFontSize, tRm.d / effFontSize,
    x, f,
  );
  ctx.scale(1, -1);

  if (isBulletOnlyText(glyph.unicode) && (run.renderingMode ?? 0) % 4 === 0) {
    fillBulletDot(ctx, effFontSize, glyph.width || effFontSize * 0.5, fillColor);
    ctx.restore();
    return;
  }

  ctx.font = `${style} ${weight} ${effFontSize}px ${family}`;

  // Fit substitute-font glyph into the PDF advance so letters don't overlap.
  const pdfAdvance = Math.max(glyph.width, 0.01);
  const hScale = Math.abs(tRm.a) / effFontSize || 1;
  const expected = pdfAdvance / hScale;
  const measured = ctx.measureText(glyph.unicode).width;
  let horizontalFit = 1;
  if (measured > 0.1) {
    let ratio = expected / measured;
    ratio = Math.max(0.45, Math.min(1.85, ratio));
    if (Math.abs(ratio - 1) > 0.005) { ctx.scale(ratio, 1); horizontalFit = ratio; }
  }

  paintCanvasText(ctx, glyph.unicode, run, { a: tRm.a / effFontSize, b: tRm.b / effFontSize,
    c: tRm.c / effFontSize, d: tRm.d / effFontSize, e: 0, f: 0 }, horizontalFit);

  if (run.isUnderline && (run.renderingMode ?? 0) % 4 === 0) {
    const underlineY = effFontSize * 0.15;
    const underlineThickness = Math.max(1, effFontSize * 0.05);
    const charWidth = ctx.measureText(glyph.unicode).width;
    ctx.beginPath();
    ctx.moveTo(0, underlineY);
    ctx.lineTo(charWidth, underlineY);
    ctx.lineWidth = underlineThickness;
    ctx.strokeStyle = fillColor;
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Extract CSS font properties (family, style, weight) without the size,
 * because size is handled by the transformation matrix.
 */
function fontLooksBold(fontData: FontData | undefined, fontName: string): boolean {
  if (!fontData) {
    return /bold|black|heavy|demi/i.test(fontName);
  }
  if (fontData.standardMetrics?.isBold) return true;
  if ((fontData.fontWeight ?? 0) >= 600) return true;
  // PDF FontDescriptor Flags bit 18 = ForceBold
  if ((fontData.flags ?? 0) & (1 << 18)) return true;
  const base = stripFontSubsetPrefix(fontData.baseFont) || fontData.baseFont || fontName;
  return /bold|black|heavy|demi/i.test(base);
}

function fontLooksItalic(fontData: FontData | undefined, fontName: string): boolean {
  if (!fontData) {
    return /italic|oblique/i.test(fontName);
  }
  if (fontData.standardMetrics?.isItalic) return true;
  if (Math.abs(fontData.italicAngle ?? 0) > 1) return true;
  // Flags bit 6 = Italic
  if ((fontData.flags ?? 0) & (1 << 6)) return true;
  const base = stripFontSubsetPrefix(fontData.baseFont) || fontData.baseFont || fontName;
  return /italic|oblique/i.test(base);
}

function getCanvasFontProperties(
  fontName: string,
  fontData?: FontData,
): { family: string; weight: string; style: string } {
  let weight = fontLooksBold(fontData, fontName) ? 'bold' : 'normal';
  let style = fontLooksItalic(fontData, fontName) ? 'italic' : 'normal';
  let family = 'sans-serif';

  if (fontData) {
    const stripped = cssFontFamilyName(fontData.baseFont);
    const lower = (stripped || fontData.baseFont || '').toLowerCase();

    // Symbol / ZapfDingbats: always paint remapped Unicode with a real system
    // symbols face. Embedded Symbol subsets only cmap PUA/Mac bytes, so
    // fillText("•") / fillText("x") both fail against the embedded FontFace.
    if (isDingbatOrSymbolFamily(fontData.baseFont)) {
      family = '"Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols", sans-serif';
      weight = 'normal';
      style = 'normal';
    } else if (fontData.fontBytes && stripped) {
      // Embedded face already carries weight/style. Applying CSS bold/italic
      // on top synthesizes extra stroke and breaks measureText vs PDF Widths
      // (classic Acrobat vs canvas mismatch). Only use CSS weight when the
      // FontFace failed to load and we fall back to a system family.
      let fallback = 'serif';
      if (lower.includes('courier') || lower.includes('mono') || lower.includes('cumberland')) {
        fallback = COURIER_CANVAS_FAMILY;
      } else if (lower.includes('helv') || lower.includes('arial') || lower.includes('sans') || lower.includes('albany')) {
        fallback = 'Helvetica, Arial, sans-serif';
      } else if (
        lower.includes('times') || lower.includes('roman') ||
        lower.includes('serif') || lower.includes('cmr') || lower.includes('ptm') || lower.includes('thorndale')
      ) {
        fallback = '"Times New Roman", Times, serif';
      }
      const rawStripped = stripFontSubsetPrefix(fontData.baseFont);
      const embeddedFamily = embeddedFontFamily(fontData.fontBytes);
      family = `"${embeddedFamily}", "${stripped}", "${rawStripped}", "${fontData.baseFont}", ${fallback}`;

      // Only drop CSS weight/style when WE successfully registered this face.
      // document.fonts.check() alone is a false positive (system font with a
      // similar name) and caused certificate bold text to render regular.
      const faceReady = loadedFontFaces.has(embeddedFamily);
      if (faceReady) {
        weight = 'normal';
        style = 'normal';
      }
    } else if (fontData.standardMetrics) {
      family = fontData.standardMetrics.name.startsWith('Courier')
        ? COURIER_CANVAS_FAMILY : fontData.standardMetrics.cssFamily;
      if (isDingbatOrSymbolFamily(fontData.baseFont)) {
        family = '"Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols", sans-serif';
      }
    } else if (isDingbatOrSymbolFamily(fontData.baseFont)) {
      family = '"Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols", sans-serif';
    } else if (lower.includes('courier') || lower.includes('mono') || lower.includes('cmtt') || lower.includes('lmtt') || lower.includes('cumberland')) {
      family = COURIER_CANVAS_FAMILY;
    } else if (
      lower.includes('times') || lower.includes('roman') ||
      lower.includes('cmr') || lower.includes('lmr') || lower.includes('ptm') || lower.includes('thorndale')
    ) {
      family = '"Times New Roman", Times, serif';
    } else if (lower.includes('helv') || lower.includes('arial') || lower.includes('cms') || lower.includes('lmss') || lower.includes('albany')) {
      family = 'Helvetica, Arial, sans-serif';
    } else if (stripped) {
      family = `"${stripped}", serif`;
    }
  } else {
    family = getCSSFontFamily(fontName);
  }

  return { family, weight, style };
}

/**
 * Build a CSS font string for canvas rendering.
 * Takes into account the text matrix scaling to get the right visual size.
 */
function buildCanvasFont(
  fontName: string,
  fontSize: number,
  textMatrix: { a: number; b: number; c: number; d: number },
  fontData?: FontData,
): string {
  // Compute effective font size from the text matrix
  const scaleY = Math.sqrt(textMatrix.b * textMatrix.b + textMatrix.d * textMatrix.d);
  const effectiveSize = Math.abs(fontSize * scaleY) || fontSize;

  const { family, weight, style } = getCanvasFontProperties(fontName, fontData);

  // Canvas font format: "style weight size family"
  return `${style} ${weight} ${effectiveSize}px ${family}`;
}

// ─── Image rendering ────────────────────────────────────────────────────────

async function drawImage(
  ctx: CanvasRenderingContext2D,
  item: ImageItem | InlineImageItem,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  maskMap: Map<PDFDict, HTMLCanvasElement> = new Map(),
): Promise<void> {
  if (item.softMask && !maskMap.has(item.softMask)) throw new Error('Unsupported unresolved image soft mask.');
  // Inline streams are render-only and never added to the document object map.
  const xobj = item.type === 'inline-image' ? item.stream : getResource(page.resources, 'XObject', item.name, objects);
  if (!(xobj instanceof PDFStream) && item.type !== 'inline-image') return;

  let decoded;
  try {
    if (!(xobj instanceof PDFStream)) throw new UnsupportedImageFilterError('invalid inline image');
    if (item.type === 'inline-image') {
      if (xobj.dict.getBool('ImageMask')) throw new UnsupportedImageFilterError('inline image mask');
      const color = xobj.dict.get('ColorSpace');
      if (color instanceof PDFName && !['DeviceRGB', 'DeviceGray', 'DeviceCMYK'].includes(color.name)) {
        const resolved = getResource(page.resources, 'ColorSpace', color.name, objects);
        if (!resolved) throw new UnsupportedImageFilterError('inline image color space');
        xobj.dict.set('ColorSpace', resolved);
      }
      const { applyFilters, DecodeLimitError } = await import('../parser/filters');
      try {
        xobj.decodedBytes = await applyFilters(xobj.rawBytes, xobj.getFilters(), xobj.getDecodeParams());
      } catch (error) {
        if (error instanceof DecodeLimitError) throw error;
        throw new UnsupportedImageFilterError('invalid inline image data');
      }
      if (!xobj.getFilters().some(filter => filter === 'DCTDecode' || filter === 'DCT')) {
        const width = xobj.dict.getNumber('Width') ?? 0;
        const height = xobj.dict.getNumber('Height') ?? 0;
        const bits = xobj.dict.getNumber('BitsPerComponent') ?? 8;
        const cs = xobj.dict.get('ColorSpace');
        const components = cs ? parseColorSpace(cs, objects).numComponents : 3;
        const needed = Math.ceil(width * components * bits / 8) * height;
        if (!Number.isSafeInteger(needed) || needed <= 0 || xobj.getBytes().length < needed) {
          throw new UnsupportedImageFilterError('invalid inline image data');
        }
      }
    }
    decoded = await decodeImage(xobj, objects);
    if (!decoded && item.type === 'inline-image') throw new UnsupportedImageFilterError('invalid inline image data');
  } catch (error) {
    if (!(error instanceof UnsupportedImageFilterError)) throw error;
    drawWithSoftMask(ctx, item.softMask, maskMap, item.blendMode, ctx => {
      ctx.save();
      try {
        applyClipPaths(ctx, item.clipPaths);
        ctx.globalAlpha *= item.fillAlpha;
        ctx.globalCompositeOperation = toCanvasBlendMode(item.blendMode);
        ctx.transform(item.ctm.a, item.ctm.b, item.ctm.c, item.ctm.d, item.ctm.e, item.ctm.f);
        ctx.fillStyle = '#f1f1f1';
        ctx.fillRect(0, 0, 1, 1);
        ctx.strokeStyle = '#777777';
        ctx.lineWidth = 0.012;
        ctx.strokeRect(0, 0, 1, 1);
        ctx.beginPath();
        ctx.moveTo(0, 0); ctx.lineTo(1, 1);
        ctx.moveTo(0, 1); ctx.lineTo(1, 0);
        ctx.stroke();
        ctx.translate(0, 1);
        ctx.scale(1, -1);
        ctx.fillStyle = '#222222';
        ctx.font = '0.09px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`Unsupported image: ${error.filter}`, 0.5, 0.5, 0.9);
      } finally {
        ctx.restore();
      }
    });
    return;
  }
  if (!decoded) return;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const imageData = new ImageData(decoded.data as any, decoded.width, decoded.height);

    drawWithSoftMask(ctx, item.softMask, maskMap, item.blendMode, ctx => {
      ctx.save();
      ctx.globalCompositeOperation = toCanvasBlendMode(item.blendMode);
      ctx.globalAlpha *= item.fillAlpha;
      applyClipPaths(ctx, item.clipPaths);

      ctx.transform(
        item.ctm.a, item.ctm.b,
        item.ctm.c, item.ctm.d,
        item.ctm.e, item.ctm.f,
      );

      const tmpCanvas = new OffscreenCanvas(decoded.width, decoded.height);
      const tmpCtx = tmpCanvas.getContext('2d')!;
      tmpCtx.putImageData(imageData, 0, 0);

      ctx.scale(1 / decoded.width, -1 / decoded.height);
      ctx.translate(0, -decoded.height);
      ctx.drawImage(tmpCanvas, 0, 0);
      ctx.restore();
    });
  } catch (e) {
    if (item.softMask) throw e;
    console.warn(`[Renderer] Failed to draw ${item.type === 'image' ? `image ${item.name}` : 'inline image'}:`, e);
  }
}

// ─── Convenience: render PDF bytes to canvas directly ───────────────────────

/**
 * Parse raw PDF bytes and render a page to canvas in one call.
 * This is the simplest entry point for rendering.
 */
export async function renderPDFPage(
  pdfBytes: Uint8Array,
  pageIndex: number = 0,
  scale: number = 1.5,
): Promise<RenderResult> {
  const doc = await parsePDF(pdfBytes);
  return renderPage(doc, pageIndex, { scale });
}

/**
 * Render all pages of a PDF document.
 */
export async function renderAllPages(
  doc: PDFDocumentData,
  options: RenderOptions,
): Promise<RenderResult[]> {
  const results: RenderResult[] = [];
  for (let i = 0; i < doc.pages.length; i++) {
    const result = await renderPage(doc, i, options);
    results.push(result);
  }
  return results;
}

/** Successfully registered embedded FontFace family names. */
const loadedFontFaces = new Set<string>();
/** Family names that failed to load (avoid retrying on every frame). */
const failedFontFaces = new Set<string>();
const embeddedFontFamilies = new WeakMap<Uint8Array, string>();
let nextEmbeddedFontFamily = 0;

/** Byte identity distinguishes growing subsets and independent documents with the same BaseFont. */
function embeddedFontFamily(bytes: Uint8Array): string {
  let family = embeddedFontFamilies.get(bytes);
  if (!family) {
    family = `PaperloomEmbedded${++nextEmbeddedFontFamily}`;
    embeddedFontFamilies.set(bytes, family);
  }
  return family;
}

async function registerEmbeddedFonts(fonts: Map<string, FontData>): Promise<void> {
  const promises: Promise<void>[] = [];
  const registered = new Set<string>();

  for (const [, fontData] of fonts.entries()) {
    if (!fontData.fontBytes || !fontData.baseFont) continue;
    if (!isTrueTypeFontData(fontData.fontBytes)) continue;
    // Symbol/ZapfDingbats: canvas uses system symbol fonts + remapped Unicode
    if (isDingbatOrSymbolFamily(fontData.baseFont)) continue;

    const familyName = embeddedFontFamily(fontData.fontBytes);
    if (registered.has(familyName) || loadedFontFaces.has(familyName) || failedFontFaces.has(familyName)) continue;
    registered.add(familyName);

    // Always register bytes: document.fonts.check() can match an unrelated system font.
    try {
      const fontFace = new FontFace(familyName, fontData.fontBytes.buffer.slice(
        fontData.fontBytes.byteOffset,
        fontData.fontBytes.byteOffset + fontData.fontBytes.byteLength,
      ) as ArrayBuffer);
      const p = fontFace.load().then((loadedFace) => {
        document.fonts.add(loadedFace);
        loadedFontFaces.add(familyName);
      }).catch((e) => {
        failedFontFaces.add(familyName);
        console.debug?.(`[Renderer] Embedded font face not loaded for "${familyName}", using system fallback:`, e);
      });
      promises.push(p);
    } catch (e) {
      failedFontFaces.add(familyName);
      console.debug?.(`[Renderer] Failed to construct font face for "${familyName}":`, e);
    }
  }

  if (promises.length > 0) {
    await Promise.all(promises);
  }
}

// ─── Canvas Pool ────────────────────────────────────────────────────────────

class CanvasPool {
  private static pool: HTMLCanvasElement[] = [];

  static acquire(width: number, height: number): HTMLCanvasElement {
    const size = checkedCanvasDimensions(width, height);
    const canvas = this.pool.pop() || document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return canvas;
  }

  static release(canvas: HTMLCanvasElement) {
    this.pool.push(canvas);
  }
}

// ─── Form rendering ─────────────────────────────────────────────────────────

/** Resolve Form geometry without trusting cycles or unbounded reference chains. */
function resolveFormGeometry(value: PDFObject, objects: Map<string, PDFObject>, key: 'BBox' | 'Matrix'): PDFObject {
  const seen = new Set<string>();
  while (value instanceof PDFRef) {
    const ref = value.toKey();
    if (seen.has(ref) || seen.size >= 128) throw new Error(`Invalid Form XObject /${key}: cyclic or excessive references.`);
    seen.add(ref);
    const next = objects.get(ref);
    if (!next) throw new Error(`Invalid Form XObject /${key}: unresolved reference.`);
    value = next;
  }
  return value;
}

function readFormGeometry(dict: PDFDict, objects: Map<string, PDFObject>, key: 'BBox' | 'Matrix',
  count: number, fallback?: number[]): number[] {
  const raw = dict.get(key);
  if (raw === undefined) {
    if (fallback) return fallback;
    throw new Error(`Invalid Form XObject /${key}: required value is missing.`);
  }
  const array = resolveFormGeometry(raw, objects, key);
  if (!(array instanceof PDFArray) || array.length !== count) throw new Error(`Invalid Form XObject /${key}: expected ${count} numbers.`);
  return array.items.map(item => {
    const value = resolveFormGeometry(item, objects, key);
    if (!(value instanceof PDFNumber) || !Number.isFinite(value.value)) throw new Error(`Invalid Form XObject /${key}: non-finite or nonnumeric value.`);
    return value.value;
  });
}

async function drawFormItem(
  ctx: CanvasRenderingContext2D,
  item: FormItem,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  options: RenderOptions,
  activeForms: Set<PDFStream> = new Set(),
): Promise<void> {
  if (item.softMask) throw new Error('Unsupported soft mask applied to a Form XObject.');
  const xobj = getResource(page.resources, 'XObject', item.name, objects);
  if (!(xobj instanceof PDFStream)) return;

  ctx.save();
  try {
    ctx.globalCompositeOperation = toCanvasBlendMode(item.blendMode);
    applyClipPaths(ctx, item.clipPaths);

    // Apply the CTM from the item which positioned the form
    ctx.transform(
      item.ctm.a, item.ctm.b,
      item.ctm.c, item.ctm.d,
      item.ctm.e, item.ctm.f,
    );

    await drawFormXObject(ctx, xobj, objects, page, options, activeForms, item.renderingMode ?? 0);
  
  } finally {
    ctx.restore();
  }
}

async function drawFormXObject(
  ctx: CanvasRenderingContext2D,
  formStream: PDFStream,
  objects: Map<string, PDFObject>,
  parentPage: PDFPageInfo,
  options: RenderOptions,
  activeForms: Set<PDFStream>,
  initialTextRenderingMode: number,
): Promise<void> {
  // PDF object identity is stable across resource references; dictionaries do
  // not carry an ObjNum field. Bound acyclic nesting as well as actual cycles.
  if (activeForms.has(formStream) || activeForms.size >= 64) {
    console.warn('Circular or excessively nested Form XObject skipped.');
    return;
  }
  activeForms.add(formStream);
  try {

    const dict = formStream.dict;
    const rawBox = readFormGeometry(dict, objects, 'BBox', 4);
    const bboxArr = [Math.min(rawBox[0], rawBox[2]), Math.min(rawBox[1], rawBox[3]),
      Math.max(rawBox[0], rawBox[2]), Math.max(rawBox[1], rawBox[3])];
    if (!Number.isFinite(bboxArr[2] - bboxArr[0]) || !Number.isFinite(bboxArr[3] - bboxArr[1]) ||
        bboxArr[2] <= bboxArr[0] || bboxArr[3] <= bboxArr[1]) {
      throw new Error('Invalid Form XObject /BBox: bounds are empty or too large.');
    }
    const matrixArr = readFormGeometry(dict, objects, 'Matrix', 6, [1, 0, 0, 1, 0, 0]);

    const groupDict = dict.getDict('Group');
    const isTransparencyGroup = groupDict !== undefined && groupDict.getName('S') === 'Transparency';
    const isolated = groupDict?.getBool('I') ?? false;

    ctx.save();
    try {

      // 1. Apply Form Matrix
      ctx.transform(matrixArr[0], matrixArr[1], matrixArr[2], matrixArr[3], matrixArr[4], matrixArr[5]);

      // 2. Clip to BBox
      ctx.beginPath();
      ctx.rect(bboxArr[0], bboxArr[1], bboxArr[2] - bboxArr[0], bboxArr[3] - bboxArr[1]);
      ctx.clip();

      // 3. Resolve Resources (fallback to parent page resources if absent)
      const formResourcesRef = dict.get('Resources');
      let formResources = parentPage.resources;
      if (formResourcesRef) {
         const resolved = resolveRef(formResourcesRef, objects);
         if (resolved instanceof PDFDict) formResources = resolved;
      }

      // 4. Decode content stream
      if (!formStream.decodedBytes) {
        const { applyFilters } = await import('../parser/filters');
        formStream.decodedBytes = await applyFilters(
          formStream.rawBytes,
          formStream.getFilters(),
          formStream.getDecodeParams()
        );
      }

      // 5. Interpret and Render
      const formPageMock: PDFPageInfo = {
        ...parentPage,
        resources: formResources,
      };

      let targetCtx = ctx;
      let offscreenCanvas: HTMLCanvasElement | null = null;
      const width = bboxArr[2] - bboxArr[0];
      const height = bboxArr[3] - bboxArr[1];

      if (isTransparencyGroup && isolated && width > 0 && height > 0) {
        offscreenCanvas = CanvasPool.acquire(width, height);
        targetCtx = offscreenCanvas.getContext('2d')!;
        targetCtx.save();
        targetCtx.translate(-bboxArr[0], -bboxArr[1]); // Normalize to local origin
      }

      const formFonts = loadPageFonts(formResources, objects);
      const formInterpreted = interpretPage(formStream.getBytes(), formPageMock, objects, options.optionalContent, initialTextRenderingMode,
        runs => buildTextClippingOutline(runs, formFonts));
      assertTextClippingSupported(formInterpreted.displayList);
      assertNoNestedSoftMask(formInterpreted.displayList);

      const renderPaths = options.renderPaths ?? true;
      const renderText = options.renderText ?? true;
      const renderImages = options.renderImages ?? true;

      for (const item of formInterpreted.displayList) {
        switch (item.type) {
          case 'path':
            if (renderPaths) drawPath(targetCtx, item);
            break;
          case 'text':
            if (renderText) drawTextRun(targetCtx, item, formFonts);
            break;
          case 'image':
          case 'inline-image':
            if (renderImages) await drawImage(targetCtx, item, formPageMock, objects);
            break;
          case 'form':
            await drawFormItem(targetCtx, item, formPageMock, objects, options, activeForms);
            break;
          case 'shading':
            if (renderImages) drawShadingItem(targetCtx, item, formPageMock, objects);
            break;
        }
      }

      if (offscreenCanvas) {
        targetCtx.restore(); // Restore the translate
        ctx.save();
        ctx.drawImage(offscreenCanvas, bboxArr[0], bboxArr[1]);
        ctx.restore();
        CanvasPool.release(offscreenCanvas);
      }

    } finally {
      ctx.restore();
    }
  } finally {
    activeForms.delete(formStream);
  }
}

// ─── Shading rendering ──────────────────────────────────────────────────────

function drawShadingItem(
  ctx: CanvasRenderingContext2D,
  item: ShadingItem,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
): void {
  if (item.softMask) throw new Error('Unsupported soft mask applied to a shading.');
  const shadingDict = getResource(page.resources, 'Shading', item.name, objects);
  if (!(shadingDict instanceof PDFDict)) return;

  const shadingType = shadingDict.getNumber('ShadingType');
  const colorSpace = shadingDict.get('ColorSpace');

  ctx.save();
  ctx.globalCompositeOperation = toCanvasBlendMode(item.blendMode);
  applyClipPaths(ctx, item.clipPaths);

  ctx.transform(
    item.ctm.a, item.ctm.b,
    item.ctm.c, item.ctm.d,
    item.ctm.e, item.ctm.f,
  );

  if (shadingType === 2) {
    // Type 2: Axial Shading
    const coords = shadingDict.getArray('Coords')?.asNumbers() || [0, 0, 1, 0];
    const funcRef = shadingDict.get('Function');
    const functionObj = funcRef ? resolveRef(funcRef, objects) : undefined;
    
    const grad = ctx.createLinearGradient(coords[0], coords[1], coords[2], coords[3]);
    
    // Basic fallback/stub for exponential functions mapping 0->1
    if (functionObj instanceof PDFDict) {
      const c0 = functionObj.getArray('C0')?.asNumbers() || [0, 0, 0];
      const c1 = functionObj.getArray('C1')?.asNumbers() || [1, 1, 1];
      
      const r0 = Math.min(255, Math.max(0, Math.round(c0[0] * 255)));
      const g0 = Math.min(255, Math.max(0, Math.round(c0[1] * 255)));
      const b0 = Math.min(255, Math.max(0, Math.round(c0[2] * 255)));
      
      const r1 = Math.min(255, Math.max(0, Math.round(c1[0] * 255)));
      const g1 = Math.min(255, Math.max(0, Math.round(c1[1] * 255)));
      const b1 = Math.min(255, Math.max(0, Math.round(c1[2] * 255)));

      grad.addColorStop(0, `rgb(${r0}, ${g0}, ${b0})`);
      grad.addColorStop(1, `rgb(${r1}, ${g1}, ${b1})`);
    } else {
      grad.addColorStop(0, '#000');
      grad.addColorStop(1, '#FFF');
    }

    ctx.fillStyle = grad;
    // Fill a sufficiently large area to cover the clipping region
    ctx.fillRect(-10000, -10000, 20000, 20000);
  } else {
    console.warn(`[Renderer] ShadingType ${shadingType} not fully implemented. ColorSpace:`, colorSpace);
  }
  
  ctx.restore();
}

