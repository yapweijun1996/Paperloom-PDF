/** Insert OCR words as invisible, page-space text for search and selection. */
import { PDFDict, PDFName, PDFNumber, PDFString, type PDFDocumentData } from '../types';
import { parseContentStream } from '../content/operator-lexer';
import { getPageContentBytes, resolveRef } from '../parser/parser';
import { concatBytes, recordPageContentModifiedKeys, serializeToString, updatePageContent } from './stream-compiler';
import { registerFontObject } from '../fonts/font-augmentation';
import { runDocumentTransaction } from '../session/document-transaction';

export interface InvisibleWord {
  text: string;
  bbox: { x: number; y: number; width: number; height: number };
  confidence?: number;
}

/** Verify the existing content cannot escape the enclosing graphics state or
 * consume the new text as an operand, marked-content or text-object member. */
function isolateContent(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 16 * 1024 * 1024) throw new Error('Page content is too large for OCR insertion.');
  const sentinel = new TextEncoder().encode('\n0 0 m\n');
  let instructions;
  try { instructions = parseContentStream(concatBytes(bytes, sentinel)); }
  catch { throw new Error('Page content cannot be safely isolated for OCR.'); }
  const last = instructions.pop();
  if (!last || last.operator !== 'm' || last.offset !== bytes.length + 5 || last.operands.length !== 2 ||
      !last.operands.every(value => value instanceof PDFNumber && value.value === 0)) {
    throw new Error('Page content cannot be safely isolated for OCR.');
  }
  let graphics = 0, marked = 0, text = false, compatibility = 0;
  for (const instruction of instructions) {
    const { operator, operands } = instruction;
    if (['q', 'Q', 'BT', 'ET', 'EMC', 'BX', 'EX'].includes(operator) && operands.length) {
      throw new Error('Page content cannot be safely isolated for OCR.');
    }
    if (operator === 'q') graphics++;
    else if (operator === 'Q' && --graphics < 0) throw new Error('Page content has unbalanced graphics state.');
    else if (operator === 'BT') { if (text) throw new Error('Page content has unbalanced text objects.'); text = true; }
    else if (operator === 'ET') { if (!text) throw new Error('Page content has unbalanced text objects.'); text = false; }
    else if (operator === 'BDC' || operator === 'BMC') marked++;
    else if (operator === 'EMC' && --marked < 0) throw new Error('Page content has unbalanced marked content.');
    else if (operator === 'BX') compatibility++;
    else if (operator === 'EX' && --compatibility < 0) throw new Error('Page content has unbalanced compatibility sections.');
  }
  if (graphics || text || marked || compatibility) throw new Error('Page content has an unbalanced state.');
  return concatBytes(concatBytes(new TextEncoder().encode('q\n'), bytes), new TextEncoder().encode('\nQ\n'));
}

function ocrFont(page: PDFDocumentData['pages'][number], objects: PDFDocumentData['objects']): string {
  // The effective resources can be inherited or shared by other pages.
  // Give this page its own dictionary and font dictionary before adding a font.
  let node: PDFDict = page.dict;
  const seen = new Set<PDFDict>();
  let resolvedResources: PDFDict | undefined;
  while (true) {
    if (seen.has(node)) throw new Error('Cannot inspect page resource inheritance for OCR.');
    seen.add(node);
    const raw = node.get('Resources');
    if (raw !== undefined) {
      const resolved = resolveRef(raw, objects);
      if (!(resolved instanceof PDFDict)) throw new Error('Cannot inspect page resources for OCR.');
      resolvedResources = resolved;
      break;
    }
    const parent = node.get('Parent');
    if (parent === undefined) break;
    const resolved = resolveRef(parent, objects);
    if (!(resolved instanceof PDFDict)) throw new Error('Cannot inspect page resource inheritance for OCR.');
    node = resolved;
  }
  if ((resolvedResources && resolvedResources !== page.resources) || (!resolvedResources && page.resources.size)) {
    throw new Error('Page resource cache does not match the PDF.');
  }
  const resources = new PDFDict([...page.resources.entries()]);
  const existingFonts = resources.get('Font');
  const resolvedFonts = existingFonts === undefined ? undefined : resolveRef(existingFonts, objects);
  if (resolvedFonts !== undefined && !(resolvedFonts instanceof PDFDict)) throw new Error('Cannot inspect page fonts for OCR.');
  const fonts = new PDFDict(resolvedFonts instanceof PDFDict ? [...resolvedFonts.entries()] : []);
  let name = 'Helv';
  for (let index = 1; fonts.has(name); index++) {
    if (index > 10000) throw new Error('Cannot allocate an OCR font name.');
    name = `PaperloomOCR${index}`;
  }
  const helvetica = new PDFDict();
  helvetica.set('Type', new PDFName('Font'));
  helvetica.set('Subtype', new PDFName('Type1'));
  helvetica.set('BaseFont', new PDFName('Helvetica'));
  helvetica.set('Encoding', new PDFName('WinAnsiEncoding'));
  const font = registerFontObject(objects, helvetica);
  fonts.set(name, font);
  resources.set('Font', fonts);
  page.dict.set('Resources', resources);
  page.resources = resources;
  // This registry is transferred through document transactions and included
  // in incremental saves; the page dictionary and new font are both required.
  recordPageContentModifiedKeys(objects, [page.ref.toKey(), font.toKey()]);
  return name;
}

/** Insert OCR words atomically; unsupported content is refused unchanged. */
export async function insertInvisibleTextLayer(doc: PDFDocumentData, pageIndex: number, words: InvisibleWord[]): Promise<void> {
  if (!words.length) return;
  await runDocumentTransaction(doc, async staged => {
    const page = staged.pages[pageIndex];
    if (!page) throw new Error('OCR page is unavailable.');
    if (page.contentRefs.length > 1) throw new Error('OCR insertion into multiple content streams is unsupported.');
    const text = words.filter(word => word.text.trim());
    if (!text.length) return;
    for (const word of text) {
      if (!/^[\x20-\x7e]{1,200}$/.test(word.text) ||
          !Object.values(word.bbox).every(Number.isFinite) || word.bbox.width <= 0 || word.bbox.height <= 0) {
        throw new Error('OCR text or coordinates cannot be represented safely.');
      }
    }
    const bytes = getPageContentBytes(page, staged.objects);
    if (page.contentRefs.length > 1) throw new Error('OCR insertion into multiple content streams is unsupported.');
    const original = isolateContent(bytes);
    const font = ocrFont(page, staged.objects);
    const parts: string[] = ['\nq', 'BT', '3 Tr'];
    for (const word of text) {
      const fontSize = Math.max(4, Math.min(72, word.bbox.height * 0.9));
      parts.push(`/${font} ${fontSize.toFixed(2)} Tf`);
      parts.push(`1 0 0 1 ${word.bbox.x.toFixed(2)} ${word.bbox.y.toFixed(2)} Tm`);
      parts.push(`${serializeToString(new PDFString(word.text))} Tj`);
    }
    parts.push('ET', 'Q\n');
    await updatePageContent(page.contentRefs, concatBytes(original, new TextEncoder().encode(parts.join('\n'))), staged.objects);
  });
}
