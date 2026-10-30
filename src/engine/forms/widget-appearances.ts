/**
 * Checkbox / radio / choice appearance regeneration and calculation order.
 */

import { PDFArray, PDFBoolean, PDFDict, PDFRef, type PDFDocumentData } from '../types';
import { resolveRef } from '../parser/parser';
import { setFormFieldValue } from './apply-field';
import type { AcroFormWidget } from './types';
import { formText } from './text-appearance';
import { setButtonValue } from './button-value';

/** Set checkbox/radio value and regenerate /AP On/Off appearances. */
export function setButtonFieldValue(
  doc: PDFDocumentData,
  widget: AcroFormWidget,
  checked: boolean,
  onName?: string,
): void {
  setButtonValue(doc, widget, checked, onName);
}

/** Set a choice (dropdown/list) field value. */
export function setChoiceFieldValue(
  doc: PDFDocumentData,
  widget: AcroFormWidget,
  value: string | string[],
): void {
  setFormFieldValue(doc, widget, value);
}

/** Mark NeedAppearances so viewers regenerate widget appearances. */
export function regenerateNeedAppearances(doc: PDFDocumentData, value = true): void {
  const catalog = doc.catalog;
  let acro = catalog.get('AcroForm');
  if (acro instanceof PDFRef) acro = resolveRef(acro, doc.objects);
  if (!(acro instanceof PDFDict)) {
    acro = new PDFDict();
    acro.set('Fields', new PDFArray([]));
    catalog.set('AcroForm', acro);
  }
  acro.set('NeedAppearances', new PDFBoolean(value));
}

/**
 * Basic /CO calculation: sum or product of sibling numeric field values.
 */
export function runCalculationOrder(
  doc: PDFDocumentData,
  widgets: AcroFormWidget[],
): void {
  const byName = new Map<string, AcroFormWidget>();
  for (const w of widgets) {
    if (w.fieldName) byName.set(w.fieldName, w);
  }

  let acro = doc.catalog.get('AcroForm');
  if (acro instanceof PDFRef) acro = resolveRef(acro, doc.objects);
  if (!(acro instanceof PDFDict)) return;
  const co = acro.get('CO');

  if (!(co instanceof PDFArray)) {
    for (const w of widgets) {
      const name = w.fieldName ?? '';
      if (/^(total|sum)/i.test(name)) {
        let sum = 0;
        for (const other of widgets) {
          if (other === w) continue;
          const v = other.value;
          const n = typeof v === 'string' ? parseFloat(v) : NaN;
          if (!Number.isNaN(n)) sum += n;
        }
        setFormFieldValue(doc, w, String(sum));
      }
    }
    return;
  }

  for (let i = 0; i < co.length; i++) {
    const ref = co.get(i);
    if (!(ref instanceof PDFRef)) continue;
    const dict = resolveRef(ref, doc.objects);
    if (!(dict instanceof PDFDict)) continue;
    const name = formText(dict.get('T'));
    const target = byName.get(name);
    if (!target) continue;

    let sum = 0;
    let product = 1;
    let hasProduct = false;
    for (const other of widgets) {
      if (other.fieldName === name) continue;
      const v = other.value;
      const n = typeof v === 'string' ? parseFloat(v) : NaN;
      if (Number.isNaN(n)) continue;
      sum += n;
      product *= n;
      hasProduct = true;
    }
    const useProduct = /prod|multiply/i.test(name);
    setFormFieldValue(doc, target, String(useProduct && hasProduct ? product : sum));
  }
}
