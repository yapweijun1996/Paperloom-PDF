/**
 * Apply and flatten AcroForm field values on document pages.
 */

import { getPageContentBytes, resolveRef } from '../parser/parser';
import { inspectContentRefs } from '../parser/content-refs';
import { updatePageContent, concatBytes, recordPageContentModifiedKeys } from '../editor/stream-compiler';
import {
  PDFArray,
  PDFBoolean,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFString,
  PDFStream,
  type PDFDocumentData,
} from '../types';
import type { AcroFormWidget } from './types';
import { detectFormFieldsOnPage } from './detect-fields';
import { flattenWidgets } from './flatten-field';
import { addFlattenAppearance, inspectFlattenMultiStreams, isolateFlattenContent } from './flatten-appearance';
import { getNextObjNum } from '../writer/serializer';
import { registerFontObject } from '../fonts/font-augmentation';
import { getStandardFont, getStandardFontCharWidth } from '../fonts/standard14';
import { runDocumentTransaction } from '../session/document-transaction';
import { inherited, setTextFieldValue } from './text-appearance';
import { setButtonValue } from './button-value';
import { dehydrateDocument, hydrateDocument } from '../worker/codec';

function stringToBytes(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
  return bytes;
}

/** Set a field value and regenerate text/choice widgets on the same draft. */
export function setFormFieldValue(
  doc: PDFDocumentData,
  widget: AcroFormWidget,
  value: string | boolean | string[],
): void {
  const dict = widget.dict;
  if (typeof value === 'boolean') {
    setButtonValue(doc, widget, value);
    return;
  } else if (widget.fieldType === 'Tx' || widget.fieldType === 'Ch') {
    if (Array.isArray(value)) {
      // Verify that every widget appearance can be generated before changing the live graph.
      const staged = hydrateDocument(dehydrateDocument(doc, { includeRawBytes: false }));
      const stagedDict = staged.objects.get(widget.ref.toKey());
      if (!(stagedDict instanceof PDFDict)) throw new Error('The multiple-choice field cannot be safely updated.');
      setTextFieldValue(staged, { ...widget, dict: stagedDict }, value);
    }
    setTextFieldValue(doc, widget, value);
    return;
  } else if (typeof value === 'string') {
    dict.set('V', new PDFString(value));
  } else {
    throw new Error('Multiple values require a multi-select choice field.');
  }
  widget.value = value;
}

/** Remove widget annotation refs from a page /Annots array. */
export function removeWidgetAnnots(
  pageDict: PDFDict,
  removedRefs: PDFRef[],
  objects: Map<string, PDFObject>,
): void {
  const annotsRef = pageDict.get('Annots');
  if (!annotsRef) return;

  const annots = annotsRef instanceof PDFRef ? resolveRef(annotsRef, objects) : annotsRef;
  if (!(annots instanceof PDFArray)) return;

  const removeKeys = new Set(removedRefs.map(r => r.toKey()));
  const kept: PDFObject[] = [];
  for (let i = 0; i < annots.length; i++) {
    const ref = annots.get(i);
    if (ref instanceof PDFRef && removeKeys.has(ref.toKey())) continue;
    kept.push(ref!);
  }

  if (annotsRef instanceof PDFRef) {
    objects.set(annotsRef.toKey(), new PDFArray(kept));
  } else if (kept.length === 0) {
    pageDict.delete('Annots');
  } else {
    pageDict.set('Annots', new PDFArray(kept));
  }
}

/**
 * Flatten widgets on a page: bake appearances into content stream,
 * remove widget annotations.
 */
export async function flattenFormFieldsOnPage(
  doc: PDFDocumentData,
  pageIndex: number,
  widgets: AcroFormWidget[],
): Promise<void> {
  if (widgets.length === 0) return;
  const page = doc.pages[pageIndex];
  if (!page || widgets.some(widget => doc.objects.get(widget.ref.toKey()) !== widget.dict)) {
    throw new Error('The form fields changed before flattening.');
  }
  await runDocumentTransaction(doc, async staged => {
    const target = staged.pages[pageIndex];
    const acroEntry = staged.catalog.get('AcroForm');
    const acro = acroEntry ? resolveRef(acroEntry, staged.objects) : undefined;
    if (acroEntry && !(acro instanceof PDFDict)) throw new Error('The form cannot be safely inspected.');
    const needEntry = acro instanceof PDFDict ? acro.get('NeedAppearances') : undefined;
    const need = needEntry ? resolveRef(needEntry, staged.objects) : undefined;
    if (needEntry && (!(need instanceof PDFBoolean) || need.value)) {
      throw new Error('Fields requiring viewer-generated appearances cannot be safely flattened.');
    }
    // The cached effective resources must match the inherited page graph.
    let node: PDFDict = target.dict;
    const ancestors = new Set<PDFDict>();
    let effective: PDFDict | undefined;
    while (true) {
      if (ancestors.has(node)) throw new Error('Page resources cannot be safely inspected.');
      ancestors.add(node);
      const entry = node.get('Resources');
      if (entry) {
        const value = resolveRef(entry, staged.objects);
        if (!(value instanceof PDFDict)) throw new Error('Page resources cannot be safely inspected.');
        effective = value;
        break;
      }
      const parent = node.get('Parent');
      if (!parent) break;
      const value = resolveRef(parent, staged.objects);
      if (!(value instanceof PDFDict)) throw new Error('Page resources cannot be safely inspected.');
      node = value;
    }
    if ((effective && effective !== target.resources) || (!effective && target.resources.size)) {
      throw new Error('Page resource cache does not match the PDF.');
    }
    const rawAnnots = target.dict.get('Annots');
    const annots = rawAnnots ? resolveRef(rawAnnots, staged.objects) : undefined;
    if (!(annots instanceof PDFArray)) throw new Error('Form field annotations cannot be inspected.');
    const seen = new Set<string>();
    const current = new Map(detectFormFieldsOnPage(staged, pageIndex).map(widget => [widget.ref.toKey(), widget]));
    const selected = widgets.map(widget => {
      const key = widget.ref.toKey();
      const dict = staged.objects.get(key);
      if (seen.has(key) || !(dict instanceof PDFDict) || !annots.items.some(item => item instanceof PDFRef && item.toKey() === key)) {
        throw new Error('Form field annotations cannot be inspected.');
      }
      seen.add(key);
      const found = current.get(key);
      if (!found || found.dict !== dict) throw new Error('The form fields changed before flattening.');
      return found;
    });
    if (target.contentInspectionComplete === false) {
      let refs: PDFRef[];
      try { refs = inspectContentRefs(target.dict.get('Contents'), staged.objects); }
      catch { throw new Error('Page content cannot be safely inspected.'); }
      target.contentRefs.splice(0);
      for (const ref of refs) target.contentRefs.push(ref);
      target.contentInspectionComplete = true;
    }
    const multi = target.contentRefs.length > 1 ? inspectFlattenMultiStreams(target, staged.objects) : undefined;
    const existing = multi ? undefined : isolateFlattenContent(getPageContentBytes(target, staged.objects));
    const parts: string[] = [];
    for (const widget of selected) {
      const rawFlags = widget.dict.get('F');
      const flagsValue = rawFlags ? resolveRef(rawFlags, staged.objects) : undefined;
      if (!(flagsValue instanceof PDFNumber) || !Number.isSafeInteger(flagsValue.value) || flagsValue.value < 0 ||
          !(flagsValue.value & 4) || (flagsValue.value & (2 | 8 | 16 | 32)) !== 0) {
        throw new Error('Widget visibility and print flags cannot be safely flattened.');
      }
      if (widget.fieldType === 'Sig' && inherited(staged, widget.dict, 'V')) {
        throw new Error('Flattening signed signature fields is unsupported.');
      }
      if (widget.dict.has('AP')) {
        parts.push(await addFlattenAppearance(staged, pageIndex, widget));
        continue;
      }
      if (widget.fieldType === 'Sig') continue;
      const rectEntry = widget.dict.get('Rect');
      const rect = rectEntry ? resolveRef(rectEntry, staged.objects) : undefined;
      if (!(rect instanceof PDFArray) || rect.length !== 4 || !rect.items.every(value => {
        const item = resolveRef(value, staged.objects);
        return item instanceof PDFNumber && Number.isFinite(item.value);
      })) throw new Error('Widget geometry cannot be flattened safely.');
      const values = rect.items.map(value => (resolveRef(value, staged.objects) as PDFNumber).value);
      if (values[2] <= values[0] || values[3] <= values[1]) throw new Error('Widget geometry cannot be flattened safely.');
      const flags = widget.dict.getNumber('F');
      if (widget.dict.has('OC') || widget.dict.has('CA') ||
          (widget.dict.has('F') && (flags === undefined || !Number.isSafeInteger(flags) || flags < 0 || (flags & (2 | 8 | 16 | 32)) !== 0))) {
        throw new Error('A missing widget appearance cannot be generated safely.');
      }
      // Without an existing appearance, support only simple, unstyled ASCII
      // fields. More complex viewer-generated appearances cannot be preserved.
      if (widget.defaultAppearance || widget.dict.has('MK') || widget.dict.has('BS') ||
          widget.dict.has('DA') || widget.dict.has('Q') || widget.readOnly || widget.required ||
          widget.buttonFlags || widget.choiceFlags || (widget.fieldType === 'Btn' && ((widget.value !== false && widget.value !== null && widget.value !== 'Off') ||
            (widget.appearanceState !== null && widget.appearanceState !== 'Off'))) ||
          (widget.fieldType !== 'Btn' && widget.value !== null && (typeof widget.value !== 'string' || !/^[\x20-\x7e]*$/.test(widget.value)))) {
        throw new Error('A missing widget appearance cannot be generated safely.');
      }
      if (widget.fieldType !== 'Btn') {
        const value = typeof widget.value === 'string' ? widget.value : '';
        const label = widget.fieldType === 'Ch' ? widget.choiceOptions?.find(option => option.value === value)?.label ?? value : value;
        if (label !== value) throw new Error('A missing choice appearance cannot be generated safely.');
        const metrics = getStandardFont('Helvetica');
        if (!metrics) throw new Error('The form font cannot be inspected.');
        const width = Array.from(value).reduce((sum, char) => sum + getStandardFontCharWidth('Helvetica', char.charCodeAt(0)) * 0.012, 0);
        const pad = Math.max(2, widget.borderWidth + 1);
        if (width > widget.rect.width - 2 * pad || 12 * metrics.ascent / 1000 > widget.rect.height * 0.75 ||
            -12 * metrics.descent / 1000 > widget.rect.height * 0.25) {
          throw new Error('A missing widget appearance cannot fit the field value safely.');
        }
      }
      let fontName = 'PaperloomFlattenFont', index = 1;
      const resources = new PDFDict([...target.resources.entries()]);
      const existingFonts = resources.get('Font');
      const resolvedFonts = existingFonts ? resolveRef(existingFonts, staged.objects) : undefined;
      if (resolvedFonts !== undefined && !(resolvedFonts instanceof PDFDict)) throw new Error('Page fonts cannot be inspected.');
      const fonts = new PDFDict(resolvedFonts instanceof PDFDict ? [...resolvedFonts.entries()] : []);
      while (fonts.has(fontName)) {
        if (index > 10000) throw new Error('Page fonts cannot be inspected.');
        fontName = `PaperloomFlattenFont${index++}`;
      }
      const font = new PDFDict([['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')],
        ['BaseFont', new PDFName('Helvetica')], ['Encoding', new PDFName('WinAnsiEncoding')]]);
      const ref = registerFontObject(staged.objects, font);
      fonts.set(fontName, ref);
      resources.set('Font', fonts);
      target.dict.set('Resources', resources);
      target.resources = resources;
      recordPageContentModifiedKeys(staged.objects, [target.ref.toKey(), ref.toKey()]);
      parts.push(flattenWidgets([widget], { fontResourceName: fontName }).content);
    }
    if (multi) {
      // Retain the original separate streams: inserting whitespace between
      // them can alter a string or comment spanning their boundary.
      const addStream = (content: string) => {
        const bytes = stringToBytes(content);
        const dict = new PDFDict([['Length', new PDFNumber(bytes.length)]]);
        const ref = new PDFRef(getNextObjNum(staged), 0);
        staged.objects.set(ref.toKey(), new PDFStream(dict, bytes, bytes));
        return ref;
      };
      const prefix = addStream('q\n');
      const suffix = addStream(`\nQ\n${parts.join('\n')}`);
      const refs = [prefix, ...multi, suffix];
      target.dict.set('Contents', new PDFArray(refs));
      target.contentRefs.splice(0);
      for (const ref of refs) target.contentRefs.push(ref);
      recordPageContentModifiedKeys(staged.objects, [target.ref.toKey(), prefix.toKey(), suffix.toKey()]);
    } else {
      const merged = concatBytes(existing!, stringToBytes(`\n${parts.join('\n')}`));
      await updatePageContent(target.contentRefs, merged, staged.objects);
    }
    const removedRefs = selected.map(widget => widget.ref);
    removeWidgetAnnots(target.dict, removedRefs, staged.objects);
    removeFields(staged, removedRefs);
    // Field-tree mutations can include direct and indirect arrays. Force a full
    // rewrite so all removed widget references and new resources are saved.
    staged.requiresFullRewrite = true;
  });
}

/** Prune removed widgets and empty ancestors, preserving surviving field branches. */
function removeFields(doc: PDFDocumentData, removedRefs: PDFRef[]): void {
  const acroEntry = doc.catalog.get('AcroForm');
  const acro = acroEntry ? resolveRef(acroEntry, doc.objects) : undefined;
  if (!(acro instanceof PDFDict)) return;
  const removed = new Set(removedRefs.map(ref => ref.toKey()));
  const visited = new Set<string>();
  function prune(owner: PDFDict, key: string): void {
    const entry = owner.get(key);
    const array = entry ? resolveRef(entry, doc.objects) : undefined;
    if (!(array instanceof PDFArray)) return;
    const kept = array.items.filter(item => {
      if (!(item instanceof PDFRef)) return true;
      if (removed.has(item.toKey())) return false;
      const field = doc.objects.get(item.toKey());
      if (!(field instanceof PDFDict) || visited.has(item.toKey())) return true;
      visited.add(item.toKey());
      const hadKids = field.has('Kids');
      prune(field, 'Kids');
      const kidsEntry = field.get('Kids');
      const kids = kidsEntry ? resolveRef(kidsEntry, doc.objects) : undefined;
      return !hadKids || !(kids instanceof PDFArray) || kids.length > 0;
    });
    if (entry instanceof PDFRef) doc.objects.set(entry.toKey(), new PDFArray(kept));
    else owner.set(key, new PDFArray(kept));
  }
  prune(acro, 'Fields');
}
