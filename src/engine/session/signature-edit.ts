import { addAnnotationToPage } from '../editor/annotation-engine';
import { insertImageRun } from '../editor/image-editor';
import { PDFArray, PDFBoolean, PDFDict, PDFName, PDFNull, PDFNumber, PDFRef, PDFStream, PDFString, type PDFDocumentData, type PDFObject } from '../types';
import type { VisualSignature } from '../signatures/visual/visual-types';
import { getNextObjNum } from '../writer/serializer';
import { removeMarkupReferences } from './document-edit';
import { annotationSubtype } from '../content/annotation-subtype';
import { serializeToString } from '../editor/stream-compiler';
import { parseContentStream } from '../content/operator-lexer';
import { decodeZlibFully } from '../parser/filters';

/** Native visual signatures are stamps, not cryptographic signature fields. */
export function findVisualSignatureRefs(doc: PDFDocumentData, ids: ReadonlySet<string>): Map<string, PDFRef> {
  const found = new Map<string, PDFRef>();
  if (ids.size === 0) return found;
  for (const page of doc.pages) {
    const entry = page.dict.get('Annots');
    const annots = entry instanceof PDFRef ? doc.objects.get(entry.toKey()) : entry;
    if (!(annots instanceof PDFArray)) continue;
    for (const ref of annots.items) {
      if (!(ref instanceof PDFRef)) continue;
      const dict = doc.objects.get(ref.toKey());
      if (!(dict instanceof PDFDict)) continue;
      const stampId = dict.get('NM');
      const widgetId = dict.get('PaperloomSignatureId');
      if (!(stampId instanceof PDFString && ids.has(stampId.value)) &&
          !(widgetId instanceof PDFString && ids.has(widgetId.value))) continue;
      const subtype = annotationSubtype(dict, doc.objects);
      const id = subtype === 'Stamp' ? stampId : widgetId;
      if (!(id instanceof PDFString) || !ids.has(id.value)) continue;
      if (subtype !== 'Stamp' && subtype !== 'Widget') throw new Error('Signature annotation type cannot be safely inspected.');
      if (found.has(id.value)) throw new Error('Duplicate signature annotation identifiers cannot be safely edited.');
      found.set(id.value, ref);
    }
  }
  return found;
}

// Resolve deliberately with a bounded chain: broken references must not authorize edits.
function resolve(value: PDFObject | undefined, doc: PDFDocumentData): PDFObject | undefined {
  const seen = new Set<string>();
  while (value instanceof PDFRef) {
    const key = value.toKey();
    if (seen.has(key) || seen.size >= 128) throw new Error('Signature appearance contains an invalid reference.');
    seen.add(key);
    value = doc.objects.get(key);
    if (!value) throw new Error('Signature appearance contains a missing reference.');
  }
  return value;
}

/** Guard every widget removal, including widgets replaced by another placement. */
function assertEditableWidget(doc: PDFDocumentData, widget: PDFDict): void {
  let current: PDFDict = widget;
  const seen = new Set<PDFDict>();
  let fieldType: PDFObject | undefined;
  let flags: PDFObject | undefined;
  for (;;) {
    if (seen.has(current) || seen.size >= 128) throw new Error('Signature field has an invalid parent chain.');
    seen.add(current);
    const value = current.get('V');
    if (value !== undefined) {
      const resolved = resolve(value, doc);
      if (!(resolved instanceof PDFNull)) {
        if (resolved instanceof PDFDict) throw new Error('This signature field is already signed or read-only.');
        throw new Error('Signature field value cannot be safely inspected.');
      }
    }
    if (fieldType === undefined && current.has('FT')) fieldType = resolve(current.get('FT'), doc);
    if (flags === undefined && current.has('Ff')) flags = resolve(current.get('Ff'), doc);
    const parent = current.get('Parent');
    if (parent === undefined) break;
    const next = resolve(parent, doc);
    if (!(next instanceof PDFDict)) throw new Error('Signature field has an invalid parent chain.');
    current = next;
  }
  if (!(fieldType instanceof PDFName) || fieldType.name !== 'Sig') throw new Error('Signature field type cannot be safely inspected.');
  if (flags !== undefined && (!(flags instanceof PDFNumber) || !Number.isSafeInteger(flags.value) || flags.value < 0 || flags.value > 0xffffffff)) {
    throw new Error('Signature field flags cannot be safely inspected.');
  }
  if (flags instanceof PDFNumber && (flags.value & 1)) throw new Error('This signature field is already signed or read-only.');
}

function numbers(doc: PDFDocumentData, value: PDFObject | undefined, length: number): number[] {
  const array = resolve(value, doc);
  if (!(array instanceof PDFArray) || array.length !== length) throw new Error('Signature appearance geometry cannot be safely inspected.');
  return array.items.map(item => {
    const number = resolve(item, doc);
    if (!(number instanceof PDFNumber) || !Number.isFinite(number.value)) throw new Error('Signature appearance geometry cannot be safely inspected.');
    return number.value;
  });
}

function inspectAppearance(doc: PDFDocumentData, stream: PDFStream): { minX: number; minY: number; width: number; height: number } {
  const subtype = resolve(stream.dict.get('Subtype'), doc);
  if (!(subtype instanceof PDFName) || subtype.name !== 'Form' || stream.dict.has('OC')) throw new Error('Signature appearance is not a supported Form.');
  const [x0, y0, x1, y1] = numbers(doc, stream.dict.get('BBox'), 4);
  const m = stream.dict.has('Matrix') ? numbers(doc, stream.dict.get('Matrix'), 6) : [1, 0, 0, 1, 0, 0];
  if (x1 <= x0 || y1 <= y0 || m[0] * m[3] - m[1] * m[2] === 0) throw new Error('Signature appearance has degenerate geometry.');
  const points = [[x0,y0], [x0,y1], [x1,y0], [x1,y1]].map(([x,y]) => [m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]]);
  const minX = Math.min(...points.map(p => p[0])), maxX = Math.max(...points.map(p => p[0]));
  const minY = Math.min(...points.map(p => p[1])), maxY = Math.max(...points.map(p => p[1]));
  const width = maxX - minX, height = maxY - minY;
  if (![minX, minY, width, height].every(Number.isFinite) || width <= 0 || height <= 0) throw new Error('Signature appearance has degenerate geometry.');
  return { minX, minY, width, height };
}

/** Validate a bounded, backdrop-independent appearance subset. */
function assertSafeComposite(doc: PDFDocumentData, stream: PDFStream, resources: PDFDict): void {
  const fail = (): never => { throw new Error('Signature appearance cannot be safely preserved.'); };
  if ([...stream.dict.keys()].some(key => !['Type','Subtype','FormType','BBox','Matrix','Resources','Length','Filter','DecodeParms'].includes(key))) return fail();
  const type = resolve(stream.dict.get('Type'), doc), formType = resolve(stream.dict.get('FormType'), doc);
  if ((type !== undefined && (!(type instanceof PDFName) || type.name !== 'XObject')) ||
      (formType !== undefined && (!(formType instanceof PDFNumber) || formType.value !== 1))) return fail();
  const limit = 1024 * 1024;
  if (stream.rawBytes.length > limit) return fail();
  const filter = resolve(stream.dict.get('Filter'), doc), params = resolve(stream.dict.get('DecodeParms'), doc);
  if (params !== undefined && !(params instanceof PDFNull)) return fail();
  let bytes: Uint8Array;
  if (filter === undefined || filter instanceof PDFNull) bytes = stream.rawBytes;
  else if (filter instanceof PDFName && (filter.name === 'FlateDecode' || filter.name === 'Fl')) {
    try { bytes = decodeZlibFully(stream.rawBytes, limit); } catch { return fail(); }
  } else return fail();
  if (bytes.length > limit || (stream.decodedBytes && (stream.decodedBytes.length !== bytes.length ||
      stream.decodedBytes.some((value, index) => value !== bytes[index])))) return fail();
  // The supported operators never use arrays or dictionaries. Reject them
  // before the recursive content parser sees adversarial nesting.
  let literal = 0, escaped = false, comment = false;
  for (const byte of bytes) {
    if (comment) { if (byte === 10 || byte === 13) comment = false; continue; }
    if (literal) {
      if (escaped) { escaped = false; continue; }
      if (byte === 92) { escaped = true; continue; }
      if (byte === 40 && ++literal > 64) return fail();
      if (byte === 41) literal--;
      continue;
    }
    if (byte === 37) comment = true;
    else if (byte === 40) literal = 1;
    else if ([41, 60, 62, 91, 93, 123, 125].includes(byte)) return fail();
  }
  if (literal) return fail();
  const marker = new TextEncoder().encode('\n0 0 m\n'), complete = new Uint8Array(bytes.length + marker.length);
  complete.set(bytes); complete.set(marker, bytes.length);
  let ops: ReturnType<typeof parseContentStream>;
  try { ops = parseContentStream(complete); } catch { return fail(); }
  const sentinel = ops.pop();
  if (!sentinel || sentinel.operator !== 'm' || sentinel.offset !== bytes.length + 5 || sentinel.operands.length !== 2 ||
      sentinel.operands.some(v => !(v instanceof PDFNumber) || v.value !== 0) || ops.length > 8192) return fail();
  const getResource = (category: string, name: string): PDFObject => {
    const dict = resolve(resources.get(category), doc);
    if (!(dict instanceof PDFDict)) return fail();
    const value = resolve(dict.get(name), doc);
    if (!value) return fail();
    return value;
  };
  const checkedFonts = new Set<string>(), checkedImages = new Map<string, number>();
  let imageWork = 0;
  const isName = (value: PDFObject | undefined, name: string) => value instanceof PDFName && value.name === name;
  const checkFont = (name: string) => {
    if (checkedFonts.has(name)) return;
    const font = getResource('Font', name);
    if (!(font instanceof PDFDict) || [...font.keys()].some(k => !['Type','Subtype','BaseFont'].includes(k)) ||
        !isName(resolve(font.get('Type'), doc), 'Font') || !isName(resolve(font.get('Subtype'), doc), 'Type1') ||
        !isName(resolve(font.get('BaseFont'), doc), 'Helvetica')) return fail();
    checkedFonts.add(name);
    if (checkedFonts.size > 16) return fail();
  };
  const checkImage = (name: string) => {
    const cached = checkedImages.get(name);
    if (cached !== undefined) {
      imageWork += cached;
      if (imageWork > 32_000_000) return fail();
      return;
    }
    const image = getResource('XObject', name);
    if (!(image instanceof PDFStream)) return fail();
    const dict = image.dict;
    if ([...dict.keys()].some(k => !['Type','Subtype','Width','Height','ColorSpace','BitsPerComponent','Filter','Length'].includes(k))) return fail();
    const n = (key: string) => { const value = resolve(dict.get(key), doc); return value instanceof PDFNumber ? value.value : NaN; };
    const width = n('Width'), height = n('Height');
    if (!isName(resolve(dict.get('Type'), doc), 'XObject') || !isName(resolve(dict.get('Subtype'), doc), 'Image') ||
        !isName(resolve(dict.get('ColorSpace'), doc), 'DeviceRGB') || !isName(resolve(dict.get('Filter'), doc), 'DCTDecode') ||
        n('BitsPerComponent') !== 8 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
        width > 4096 || height > 4096 || width * height > 16_000_000 || image.rawBytes.length > 8 * 1024 * 1024) return fail();
    assertSafeCompositeJpeg(image.rawBytes, width, height);
    checkedImages.set(name, width * height);
    imageWork += width * height;
    if (checkedImages.size > 16 || imageWork > 32_000_000) return fail();
  };
  const bbox = numbers(doc, stream.dict.get('BBox'), 4);
  let depth = 0, text = false, hasFont = false, background = false, rectangle: number[] | null = null;
  for (const { operator, operands } of ops) {
    const numeric = (count: number) => operands.length === count && operands.every(v => v instanceof PDFNumber && Number.isFinite(v.value) && Math.abs(v.value) <= 10_000_000);
    if (operator === 'q') { if (operands.length || text || ++depth > 64) return fail(); }
    else if (operator === 'Q') { if (operands.length || text || depth-- <= 0 || !background) return fail(); }
    else if (operator === 'BT') { if (operands.length || text || !background) return fail(); text = true; hasFont = false; }
    else if (operator === 'ET') { if (operands.length || !text) return fail(); text = false; }
    else if (operator === 'Tf') {
      if (!text || operands.length !== 2 || !(operands[0] instanceof PDFName) || !(operands[1] instanceof PDFNumber) ||
          !Number.isFinite(operands[1].value) || operands[1].value <= 0 || operands[1].value > 10_000_000) return fail();
      checkFont(operands[0].name); hasFont = true;
    } else if (operator === 'Td') { if (!text || !numeric(2)) return fail(); }
    else if (operator === 'Tj') { if (!text || !hasFont || operands.length !== 1 || !(operands[0] instanceof PDFString) || operands[0].value.length > 16384) return fail(); }
    else if (operator === 'Do') { if (text || !background || operands.length !== 1 || !(operands[0] instanceof PDFName)) return fail(); checkImage(operands[0].name); }
    else if (operator === 'rg' || operator === 'RG') { if (text || !numeric(3) || operands.some(v => (v as PDFNumber).value < 0 || (v as PDFNumber).value > 1)) return fail(); }
    else if (operator === 'cm') { if (text || !background || !numeric(6)) return fail(); }
    else if (operator === 're') {
      if (text || !numeric(4)) return fail();
      if (!background) { if (rectangle) return fail(); rectangle = operands.map(v => (v as PDFNumber).value); }
    } else if (operator === 'w') { if (text || !numeric(1) || (operands[0] as PDFNumber).value < 0) return fail(); }
    else if (operator === 'f' || operator === 'S') {
      if (text || operands.length) return fail();
      if (!background) {
        if (operator !== 'f' || !rectangle) return fail();
        const [x,y,w,h] = rectangle;
        if (w <= 0 || h <= 0 || x > bbox[0] || y > bbox[1] || x + w < bbox[2] || y + h < bbox[3]) return fail();
        background = true;
      }
    } else return fail();
  }
  if (depth !== 0 || text || !background) return fail();
}

function assertSafeCompositeJpeg(bytes: Uint8Array, width: number, height: number): void {
  const fail = (): never => { throw new Error('Signature image cannot be safely preserved.'); };
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return fail();
  let p = 2, scan = false, frame = false, sawScan = false;
  const components = new Set<number>();
  while (p < bytes.length) {
    if (scan) while (p < bytes.length && bytes[p] !== 0xff) p++;
    if (p >= bytes.length || bytes[p] !== 0xff) return fail();
    while (p < bytes.length && bytes[p] === 0xff) p++;
    if (p >= bytes.length) return fail();
    const marker = bytes[p++];
    if (scan && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) continue;
    scan = false;
    if (marker === 0xd9) { if (!frame || !sawScan || p !== bytes.length) return fail(); return; }
    if (p + 2 > bytes.length) return fail();
    const length = bytes[p] * 256 + bytes[p + 1];
    if (length < 2 || p + length > bytes.length) return fail();
    if (marker === 0xc0 || marker === 0xc2) {
      if (frame || length !== 17 || bytes[p + 2] !== 8 || bytes[p + 7] !== 3 ||
          bytes[p + 3] * 256 + bytes[p + 4] !== height || bytes[p + 5] * 256 + bytes[p + 6] !== width) return fail();
      for (let i = 0; i < 3; i++) {
        const at = p + 8 + i * 3, id = bytes[at], sampling = bytes[at + 1];
        if (components.has(id) || (sampling >> 4) < 1 || (sampling >> 4) > 4 || (sampling & 15) < 1 || (sampling & 15) > 4 || bytes[at + 2] > 3) return fail();
        components.add(id);
      }
      frame = true;
    } else if (marker === 0xda) {
      if (!frame || length < 8) return fail();
      const count = bytes[p + 2], seen = new Set<number>();
      if (count < 1 || count > components.size || length !== 6 + count * 2) return fail();
      for (let i = 0; i < count; i++) {
        const id = bytes[p + 3 + i * 2], table = bytes[p + 4 + i * 2];
        if (!components.has(id) || seen.has(id) || (table >> 4) > 3 || (table & 15) > 3) return fail();
        seen.add(id);
      }
      sawScan = true; scan = true;
    } else if (!(marker === 0xc4 || marker === 0xcc || marker === 0xdb || marker === 0xdd || marker === 0xfe || (marker >= 0xe0 && marker <= 0xef))) return fail();
    p += length;
  }
  return fail();
}

function assertSignaturePage(doc: PDFDocumentData, ref: PDFRef, pageIndex: number): void {
  const page = doc.pages[pageIndex];
  const entry = page?.dict.get('Annots');
  const annots = entry instanceof PDFRef ? doc.objects.get(entry.toKey()) : entry;
  if (!(annots instanceof PDFArray) || !annots.items.some(item => item instanceof PDFRef && item.toKey() === ref.toKey())) {
    throw new Error('The signature annotation does not belong to its recorded page.');
  }
}

function inspectResourceReferences(doc: PDFDocumentData, root: PDFObject): Set<string> {
  const pending = [root], seenObjects = new Set<PDFObject>(), references = new Set<string>();
  while (pending.length) {
    const value = pending.pop()!;
    if (seenObjects.has(value)) continue;
    seenObjects.add(value);
    if (seenObjects.size > 100_000 || pending.length > 100_000) throw new Error('Signature resources exceed the inspection limit.');
    if (value instanceof PDFRef) {
      const key = value.toKey(), next = doc.objects.get(key);
      if (!next) throw new Error('Signature appearance contains a missing resource.');
      references.add(key); pending.push(next);
    } else if (value instanceof PDFDict) pending.push(...value.values());
    else if (value instanceof PDFArray) pending.push(...value.items);
    else if (value instanceof PDFStream) pending.push(value.dict);
  }
  return references;
}

function compositePlacement(signature: VisualSignature, geometry: { minX: number; minY: number; width: number; height: number }) {
  const angle = signature.rotation * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const width = Math.abs(signature.width * cos) + Math.abs(signature.height * sin);
  const height = Math.abs(signature.width * sin) + Math.abs(signature.height * cos);
  const sx = signature.width / geometry.width, sy = signature.height / geometry.height;
  const values = [signature.x, signature.y, signature.width, signature.height, signature.rotation, signature.opacity,
    width, height, sx, sy, cos, sin, geometry.minX, geometry.minY];
  if (!values.every(value => Number.isFinite(value) && Math.abs(value) <= 10_000_000) || signature.width <= 0 || signature.height <= 0 || width <= 0 || height <= 0 ||
      sx <= 0 || sy <= 0 || signature.opacity < 0 || signature.opacity > 1) throw new Error('Signature geometry is invalid.');
  const n = (value: number) => serializeToString(new PDFNumber(value));
  const commands = `q 1 0 0 1 ${n(width / 2)} ${n(height / 2)} cm ${n(cos)} ${n(sin)} ${n(-sin)} ${n(cos)} 0 0 cm 1 0 0 1 ${n(-signature.width / 2)} ${n(-signature.height / 2)} cm ${n(sx)} 0 0 ${n(sy)} 0 0 cm 1 0 0 1 ${n(-geometry.minX)} ${n(-geometry.minY)} cm /PaperloomSource Do Q\n`;
  return { width, height, commands, rect: [signature.x - (width - signature.width) / 2,
    signature.y - (height - signature.height) / 2,
    signature.x + (width + signature.width) / 2,
    signature.y + (height + signature.height) / 2] };
}

/** Recognize the exact bounded wrapper we create. Merely finding a source ref
 * in a resource dictionary does not prove the page actually paints it. */
function assertCompositeWrapper(doc: PDFDocumentData, signature: VisualSignature,
  annotation: PDFDict, appearance: PDFStream, canonical: PDFRef, source: PDFStream): void {
  const fail = (): never => { throw new Error('The complete signature appearance is unavailable.'); };
  const only = (dict: PDFDict, keys: string[]) => [...dict.keys()].every(key => keys.includes(key));
  const named = (value: PDFObject | undefined, expected: string) => value instanceof PDFName && value.name === expected;
  const dict = (value: PDFObject | undefined): PDFDict => { const object = resolve(value, doc); return object instanceof PDFDict ? object : fail(); };
  const stream = (value: PDFObject | undefined): PDFStream => { const object = resolve(value, doc); return object instanceof PDFStream ? object : fail(); };
  const exactContent = (object: PDFStream, expected: string) => {
    if (object.rawBytes.length > 8192 || object.dict.has('Filter') || object.dict.has('DecodeParms')) return fail();
    const bytes = new TextEncoder().encode(expected);
    if (object.rawBytes.length !== bytes.length || object.rawBytes.some((byte, i) => byte !== bytes[i]) ||
        (object.decodedBytes && (object.decodedBytes.length !== bytes.length || object.decodedBytes.some((byte, i) => byte !== bytes[i])))) return fail();
  };
  const geometry = inspectAppearance(doc, source);
  const sourceResources = dict(source.dict.get('Resources'));
  assertSafeComposite(doc, source, sourceResources);
  const placement = compositePlacement(signature, geometry);
  const sameNumbers = (value: PDFObject | undefined, expected: number[]) => {
    const actual = numbers(doc, value, expected.length);
    if (actual.some((n, i) => Math.abs(n - expected[i]) > 0.000011)) return fail();
  };
  const f = resolve(annotation.get('F'), doc);
  if (!(f instanceof PDFNumber) || f.value !== 4 || annotation.has('CA') || annotation.has('OC') || annotation.has('AS')) return fail();
  sameNumbers(annotation.get('Rect'), placement.rect);
  const appearanceDict = appearance.dict;
  if (!only(appearanceDict, ['Type','Subtype','BBox','Resources','Length']) ||
      !named(resolve(appearanceDict.get('Type'), doc), 'XObject') ||
      !named(resolve(appearanceDict.get('Subtype'), doc), 'Form')) return fail();
  sameNumbers(appearanceDict.get('BBox'), [0, 0, placement.width, placement.height]);
  exactContent(appearance, 'q /PaperloomOpacity gs /PaperloomGroup Do Q\n');
  const resources = dict(appearanceDict.get('Resources'));
  if (!only(resources, ['XObject','ExtGState'])) return fail();
  const xobjects = dict(resources.get('XObject')), states = dict(resources.get('ExtGState'));
  if (!only(xobjects, ['PaperloomGroup']) || !only(states, ['PaperloomOpacity'])) return fail();
  const state = dict(states.get('PaperloomOpacity'));
  if (!only(state, ['Type','ca','CA']) || !named(resolve(state.get('Type'), doc), 'ExtGState')) return fail();
  for (const key of ['ca', 'CA']) {
    const value = resolve(state.get(key), doc);
    if (!(value instanceof PDFNumber) || !Number.isFinite(value.value) || Math.abs(value.value - signature.opacity) > 0.000011) return fail();
  }
  const group = stream(xobjects.get('PaperloomGroup')), groupDict = group.dict;
  if (!only(groupDict, ['Type','Subtype','BBox','Resources','Group','Length']) ||
      !named(resolve(groupDict.get('Type'), doc), 'XObject') || !named(resolve(groupDict.get('Subtype'), doc), 'Form')) return fail();
  sameNumbers(groupDict.get('BBox'), [0, 0, placement.width, placement.height]);
  const groupOptions = dict(groupDict.get('Group'));
  const isolated = resolve(groupOptions.get('I'), doc);
  if (!only(groupOptions, ['S','I']) || !named(resolve(groupOptions.get('S'), doc), 'Transparency') ||
      !(isolated instanceof PDFBoolean) || !isolated.value) return fail();
  const groupResources = dict(groupDict.get('Resources'));
  if (!only(groupResources, ['XObject'])) return fail();
  const groupXObjects = dict(groupResources.get('XObject'));
  const sourceRef = groupXObjects.get('PaperloomSource');
  if (!only(groupXObjects, ['PaperloomSource']) || !(sourceRef instanceof PDFRef) || !sourceRef.equals(canonical)) return fail();
  exactContent(group, placement.commands);
}

/** Check required native links without changing the document or assessing edit permission.
 * This checks structural availability, not support for every arbitrary PDF operator. */
export function assertVisualSignatureAppearancePresent(doc: PDFDocumentData, signature: VisualSignature): void {
  const ref = findVisualSignatureRefs(doc, new Set([signature.id])).get(signature.id);
  if (!ref) throw new Error('The complete signature appearance is unavailable.');
  assertSignaturePage(doc, ref, signature.pageIndex);
  const annot = doc.objects.get(ref.toKey());
  if (!(annot instanceof PDFDict)) throw new Error('The complete signature appearance is unavailable.');
  const ap = resolve(annot.get('AP'), doc);
  if (!(ap instanceof PDFDict)) throw new Error('The complete signature appearance is unavailable.');
  let normal = resolve(ap.get('N'), doc);
  if (normal instanceof PDFDict) {
    const state = resolve(annot.get('AS'), doc);
    if (!(state instanceof PDFName)) throw new Error('The signature appearance state is unavailable.');
    normal = resolve(normal.get(state.name), doc);
  }
  if (!(normal instanceof PDFStream)) throw new Error('The complete signature appearance is unavailable.');
  const subtype = resolve(normal.dict.get('Subtype'), doc);
  if (!(subtype instanceof PDFName) || subtype.name !== 'Form') throw new Error('The signature appearance Form is unavailable.');
  const bbox = numbers(doc, normal.dict.get('BBox'), 4);
  if (bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) throw new Error('The signature appearance geometry is invalid.');
  if (normal.dict.has('Matrix')) numbers(doc, normal.dict.get('Matrix'), 6);
  const resources = resolve(normal.dict.get('Resources') ?? annot.get('Resources') ?? doc.pages[signature.pageIndex]?.resources, doc);
  if (!(resources instanceof PDFDict)) throw new Error('Signature appearance resources are unavailable.');
  const reachable = inspectResourceReferences(doc, resources);
  if (annotationSubtype(annot, doc.objects) === 'Stamp') {
    if ([...ap.keys()].some(key => key !== 'N')) throw new Error('The complete signature appearance is unavailable.');
    const source = annot.get('PaperloomCompositeAppearance');
    if (!(source instanceof PDFRef) || !reachable.has(source.toKey())) throw new Error('The complete signature appearance is unavailable.');
    const form = resolve(source, doc);
    if (!(form instanceof PDFStream) || !(resolve(form.dict.get('Resources'), doc) instanceof PDFDict)) {
      throw new Error('The complete signature appearance is unavailable.');
    }
    const sourceSubtype = resolve(form.dict.get('Subtype'), doc);
    if (!(sourceSubtype instanceof PDFName) || sourceSubtype.name !== 'Form') throw new Error('The complete signature appearance is unavailable.');
    const sourceBox = numbers(doc, form.dict.get('BBox'), 4);
    if (sourceBox[2] <= sourceBox[0] || sourceBox[3] <= sourceBox[1]) throw new Error('The signature appearance geometry is invalid.');
    assertCompositeWrapper(doc, signature, annot, normal, source, form);
  }
}

/** Snapshot the original Form without mutating shared resources. */
function compositeSource(
  doc: PDFDocumentData,
  signature: Pick<VisualSignature, 'id' | 'pageIndex'> & { requiresCompositeAppearance?: boolean },
  snapshot = true,
): PDFRef | null {
  const ref = findVisualSignatureRefs(doc, new Set([signature.id])).get(signature.id);
  if (!ref) {
    if ('requiresCompositeAppearance' in signature && signature.requiresCompositeAppearance) throw new Error('The complete signature appearance is unavailable.');
    return null;
  }
  assertSignaturePage(doc, ref, signature.pageIndex);
  const annotation = doc.objects.get(ref.toKey());
  if (!(annotation instanceof PDFDict)) throw new Error('Signature annotation cannot be safely inspected.');
  const subtype = annotationSubtype(annotation, doc.objects);
  if (subtype === 'Widget') {
    assertEditableWidget(doc, annotation);
    const flags = resolve(annotation.get('F'), doc);
    const opacity = resolve(annotation.get('CA'), doc);
    if ((flags !== undefined && (!(flags instanceof PDFNumber) || flags.value !== 4)) ||
        (opacity !== undefined && (!(opacity instanceof PDFNumber) || opacity.value !== 1)) || annotation.has('OC')) {
      throw new Error('Signature annotation properties are unsupported.');
    }
    const ap = resolve(annotation.get('AP'), doc);
    if (!(ap instanceof PDFDict)) throw new Error('The complete signature appearance is unavailable.');
    const original = resolve(ap.get('N'), doc);
    if (!(original instanceof PDFStream)) throw new Error('The complete signature appearance is unavailable.');
    inspectAppearance(doc, original);
    const resources = resolve(original.dict.get('Resources') ?? annotation.get('Resources') ?? doc.pages[signature.pageIndex]?.resources, doc);
    if (!(resources instanceof PDFDict)) throw new Error('Signature appearance resources are unavailable.');
    assertSafeComposite(doc, original, resources);
    if (!snapshot) return ref;
    const copy = new PDFDict([...original.dict.entries()]);
    copy.set('Resources', resources);
    // Writer precision applies to these numbers on save. Freeze the canonical
    // geometry at that precision before calculating the wrapper transform so
    // reopened documents retain the exact same mapping.
    for (const [key, count] of [['BBox', 4], ['Matrix', 6]] as const) {
      if (!copy.has(key)) continue;
      const rounded = numbers(doc, copy.get(key), count).map(value => Number(serializeToString(new PDFNumber(value))));
      if (!rounded.every(Number.isFinite)) throw new Error('Signature appearance has invalid geometry.');
      copy.set(key, new PDFArray(rounded.map(value => new PDFNumber(value))));
    }
    const saved = new PDFStream(copy, original.rawBytes.slice(), original.decodedBytes?.slice() ?? null);
    inspectAppearance(doc, saved);
    assertSafeComposite(doc, saved, resources);
    const canonical = new PDFRef(getNextObjNum(doc), 0);
    doc.objects.set(canonical.toKey(), saved);
    return canonical;
  }
  if (subtype !== 'Stamp') throw new Error('Signature annotation type cannot be safely inspected.');
  const source = annotation.get('PaperloomCompositeAppearance');
  if (source === undefined) {
    if ('requiresCompositeAppearance' in signature && signature.requiresCompositeAppearance) throw new Error('The complete signature appearance is unavailable.');
    return null;
  }
  if (!(source instanceof PDFRef)) throw new Error('The complete signature appearance is unavailable.');
  const original = resolve(source, doc);
  if (!(original instanceof PDFStream)) throw new Error('The complete signature appearance is unavailable.');
  inspectAppearance(doc, original);
  const resources = resolve(original.dict.get('Resources'), doc);
  if (!(resources instanceof PDFDict)) throw new Error('Signature appearance resources are unavailable.');
  assertSafeComposite(doc, original, resources);
  return source;
}

/** Remove the visual appearance only; never alter a field's cryptographic /V. */
export function removeVisualSignature(doc: PDFDocumentData, id: string, requireCompositeAppearance = false, expectedPageIndex?: number): void {
  const ref = findVisualSignatureRefs(doc, new Set([id])).get(id);
  if (!ref) {
    if (requireCompositeAppearance) throw new Error('The complete signature appearance is unavailable.');
    return;
  }
  const dict = doc.objects.get(ref.toKey()) as PDFDict;
  if (expectedPageIndex !== undefined) assertSignaturePage(doc, ref, expectedPageIndex);
  if (requireCompositeAppearance) {
    const pageIndex = doc.pages.findIndex(page => {
      const entry = page.dict.get('Annots');
      const annots = entry instanceof PDFRef ? doc.objects.get(entry.toKey()) : entry;
      return annots instanceof PDFArray && annots.items.some(item => item instanceof PDFRef && item.toKey() === ref.toKey());
    });
    if (pageIndex < 0) throw new Error('The complete signature appearance is unavailable.');
    compositeSource(doc, { id, pageIndex, requiresCompositeAppearance: true }, false);
  }
  if (annotationSubtype(dict, doc.objects) === 'Widget') {
    assertEditableWidget(doc, dict);
    dict.delete('AP');
    dict.delete('PaperloomSignatureId');
    return;
  }
  for (let index = 0; index < doc.pages.length; index++) removeMarkupReferences(doc, index, [ref]);
}

/** Call only on a transaction draft. Image resources belong to the appearance,
 * so deletion cannot leave signature pixels reachable through page resources.
 */
export async function placeVisualSignature(
  doc: PDFDocumentData,
  signature: VisualSignature,
  imageDataUrl: string,
): Promise<void> {
  const page = doc.pages[signature.pageIndex];
  const resources = new PDFDict();
  const dict = new PDFDict();
  dict.set('Resources', resources);
  const appearancePage = { ...page, dict, resources, contentRefs: [] };
  const angle = signature.rotation * Math.PI / 180;
  const width = Math.abs(signature.width * Math.cos(angle)) + Math.abs(signature.height * Math.sin(angle));
  const height = Math.abs(signature.width * Math.sin(angle)) + Math.abs(signature.height * Math.cos(angle));
  const dx = (width - signature.width) / 2;
  const dy = (height - signature.height) / 2;
  const source = compositeSource(doc, signature);
  let newContentBytes: Uint8Array;
  if (source) {
    const form = resolve(source, doc) as PDFStream;
    const placement = compositePlacement(signature, inspectAppearance(doc, form));
    const xobjects = new PDFDict();
    xobjects.set('PaperloomSource', source);
    resources.set('XObject', xobjects);
    const commands = placement.commands;
    newContentBytes = new TextEncoder().encode(commands);
  } else {
    // Image and soft-mask refs are reserved before either object is inserted.
    let nextObjNum = getNextObjNum(doc);
    ({ newContentBytes } = await insertImageRun(
      new Uint8Array(), appearancePage, doc.objects, imageDataUrl,
      dx, dy + signature.height, signature.width, signature.height,
      () => nextObjNum++, { rotationDegrees: signature.rotation, opacity: signature.opacity },
    ));
  }
  if (source) {
    // First compose the entire appearance in an isolated group, then apply
    // alpha once to the group. Applying alpha to its individual marks changes
    // the color where those marks overlap.
    const groupDict = new PDFDict();
    groupDict.set('Type', new PDFName('XObject'));
    groupDict.set('Subtype', new PDFName('Form'));
    groupDict.set('BBox', new PDFArray([0, 0, width, height].map(value => new PDFNumber(value))));
    groupDict.set('Resources', resources);
    const group = new PDFDict();
    group.set('S', new PDFName('Transparency'));
    group.set('I', new PDFBoolean(true));
    groupDict.set('Group', group);
    groupDict.set('Length', new PDFNumber(newContentBytes.length));
    const groupRef = new PDFRef(getNextObjNum(doc), 0);
    doc.objects.set(groupRef.toKey(), new PDFStream(groupDict, newContentBytes, newContentBytes));
    const outerXObjects = new PDFDict();
    outerXObjects.set('PaperloomGroup', groupRef);
    const state = new PDFDict();
    state.set('Type', new PDFName('ExtGState'));
    state.set('ca', new PDFNumber(signature.opacity));
    state.set('CA', new PDFNumber(signature.opacity));
    const states = new PDFDict();
    states.set('PaperloomOpacity', state);
    const outerResources = new PDFDict();
    outerResources.set('XObject', outerXObjects);
    outerResources.set('ExtGState', states);
    appearancePage.resources = outerResources;
    newContentBytes = new TextEncoder().encode('q /PaperloomOpacity gs /PaperloomGroup Do Q\n');
  }
  const appearanceDict = new PDFDict();
  appearanceDict.set('Type', new PDFName('XObject'));
  appearanceDict.set('Subtype', new PDFName('Form'));
  appearanceDict.set('BBox', new PDFArray([0, 0, width, height].map(value => new PDFNumber(value))));
  appearanceDict.set('Resources', appearancePage.resources);
  appearanceDict.set('Length', new PDFNumber(newContentBytes.length));
  const appearanceRef = new PDFRef(getNextObjNum(doc), 0);
  doc.objects.set(appearanceRef.toKey(), new PDFStream(appearanceDict, newContentBytes, newContentBytes));
  removeVisualSignature(doc, signature.id);
  const annotation = new PDFDict();
  annotation.set('Type', new PDFName('Annot'));
  annotation.set('Subtype', new PDFName('Stamp'));
  annotation.set('NM', new PDFString(signature.id));
  if (source) annotation.set('PaperloomCompositeAppearance', source);
  annotation.set('F', new PDFNumber(4));
  annotation.set('Rect', new PDFArray([
    signature.x - dx, signature.y - dy,
    signature.x - dx + width, signature.y - dy + height,
  ].map(value => new PDFNumber(value))));
  const ap = new PDFDict();
  ap.set('N', appearanceRef);
  annotation.set('AP', ap);
  const ref = new PDFRef(getNextObjNum(doc), 0);
  addAnnotationToPage(page.dict, annotation, ref, doc.objects);
}
