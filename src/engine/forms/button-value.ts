import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, type PDFDocumentData, type PDFObject } from '../types';
import { getNextObjNum } from '../writer/serializer';
import type { AcroFormWidget } from './types';

function resolve(value: PDFObject | undefined, doc: PDFDocumentData): PDFObject | undefined {
  const seen = new Set<string>();
  while (value instanceof PDFRef) {
    if (seen.has(value.toKey())) throw new Error('The button field contains a cyclic reference.');
    seen.add(value.toKey());
    value = doc.objects.get(value.toKey());
  }
  return value;
}

function normalAppearance(dict: PDFDict, doc: PDFDocumentData): PDFDict | undefined {
  const appearance = resolve(dict.get('AP'), doc);
  if (!(appearance instanceof PDFDict)) return undefined;
  const normal = resolve(appearance.get('N'), doc);
  return normal instanceof PDFDict ? normal : undefined;
}

function onName(dict: PDFDict, doc: PDFDocumentData): string | undefined {
  const normal = normalAppearance(dict, doc);
  const current = dict.getName('AS');
  if (current && current !== 'Off' && normal?.has(current)) return current;
  return normal ? [...normal.keys()].find(name => name !== 'Off') : undefined;
}

function newAppearance(doc: PDFDocumentData, checked: boolean, rect: PDFObject | undefined): PDFRef {
  const values = rect instanceof PDFArray ? rect.asNumbers() : [];
  const usable = values.length >= 4 && values.slice(0, 4).every(Number.isFinite);
  const width = usable ? Math.max(Math.abs(values[2] - values[0]), 1) : 12;
  const height = usable ? Math.max(Math.abs(values[3] - values[1]), 1) : 12;
  const content = checked
    ? `q 0 0 0 rg 1 w 0 0 ${width} ${height} re S ${width * 0.2} ${height * 0.5} m ${width * 0.45} ${height * 0.2} l ${width * 0.8} ${height * 0.8} l S Q`
    : `q 0 0 0 rg 1 w 0 0 ${width} ${height} re S Q`;
  const bytes = new TextEncoder().encode(content);
  const stream = new PDFStream(new PDFDict([
    ['Type', new PDFName('XObject')], ['Subtype', new PDFName('Form')],
    ['BBox', new PDFArray([0, 0, width, height].map(n => new PDFNumber(n)))], ['Length', new PDFNumber(bytes.length)],
  ]), bytes, bytes);
  const ref = new PDFRef(getNextObjNum(doc), 0);
  doc.objects.set(ref.toKey(), stream);
  return ref;
}

/** Update a terminal button field and the appearances of all its widgets. */
export function setButtonValue(doc: PDFDocumentData, widget: AcroFormWidget, checked: boolean, requestedName?: string): void {
  if (requestedName === '' || requestedName === 'Off') throw new Error('The button on-state name must not be empty or Off.');
  let flags = 0;
  let flagOwner: PDFDict | undefined = widget.dict;
  const flagParents = new Set<PDFDict>();
  while (flagOwner) {
    if (flagParents.has(flagOwner)) throw new Error('The button field contains a cyclic parent chain.');
    flagParents.add(flagOwner);
    const value = resolve(flagOwner.get('Ff'), doc);
    if (value !== undefined) {
      if (!(value instanceof PDFNumber) || !Number.isSafeInteger(value.value) || value.value < 0) {
        throw new Error('The button field flags are invalid.');
      }
      flags = value.value;
      break;
    }
    const parent = resolve(flagOwner.get('Parent'), doc);
    if (parent !== undefined && !(parent instanceof PDFDict)) throw new Error('The button field parent is invalid.');
    flagOwner = parent as PDFDict | undefined;
  }
  if ((flags & (1 << 16)) !== 0) throw new Error('Pushbutton values cannot be toggled.');
  let owner = widget.dict;
  const parents = new Set<PDFDict>();
  while (!owner.has('T') && owner.has('Parent')) {
    if (parents.has(owner)) throw new Error('The button field contains a cyclic parent chain.');
    parents.add(owner);
    const parent = resolve(owner.get('Parent'), doc);
    if (!(parent instanceof PDFDict)) throw new Error('The button field parent is invalid.');
    owner = parent;
  }
  const widgets: PDFDict[] = [];
  const visited = new Set<PDFDict>();
  const visit = (dict: PDFDict): void => {
    if (visited.has(dict)) return;
    visited.add(dict);
    if (dict.getName('Subtype') === 'Widget') widgets.push(dict);
    const kids = resolve(dict.get('Kids'), doc);
    if (kids instanceof PDFArray) for (const child of kids.items) {
      const resolved = resolve(child, doc);
      if (!(resolved instanceof PDFDict)) throw new Error('The button field widget is invalid.');
      visit(resolved);
    }
  };
  visit(owner);
  if (!widgets.includes(widget.dict)) throw new Error('The selected button widget is not in its field tree.');
  // Validate every sibling before mutating any of them; a bad later /AP must
  // not leave an earlier widget with a partially updated state.
  for (const dict of widgets) {
    const ap = resolve(dict.get('AP'), doc);
    normalAppearance(dict, doc);
    onName(dict, doc);
    resolve(dict.get('Rect'), doc);
    if (ap instanceof PDFDict) {
      resolve(ap.get('D'), doc);
      resolve(ap.get('R'), doc);
    }
  }
  const radio = (flags & (1 << 15)) !== 0;
  if (radio && (flags & (1 << 14)) !== 0 && !checked) {
    const currentValue = resolve(owner.get('V'), doc);
    if ((currentValue instanceof PDFName && currentValue.name !== 'Off') ||
        widgets.some(dict => { const state = dict.getName('AS'); return !!state && state !== 'Off'; })) {
      throw new Error('This radio group does not allow clearing its selection.');
    }
  }
  const radiosInUnison = (flags & (1 << 25)) !== 0;
  const selected = requestedName ?? (radio ? onName(widget.dict, doc) : onName(widgets[0], doc)) ??
    onName(widget.dict, doc) ?? 'Yes';
  const state = checked ? selected : 'Off';

  // Preserve existing artwork and other appearance variants. Checkboxes with
  // differing widget on-names gain a shared alias for interoperable field /V.
  for (const dict of widgets) {
    const originalAp = resolve(dict.get('AP'), doc);
    const originalNormal = normalAppearance(dict, doc);
    const previousOn = onName(dict, doc);
    const maySelect = !radio || dict === widget.dict || !!originalNormal?.has(selected);
    const selectedAppearance = originalNormal?.get(selected) ??
      (!radio && previousOn ? originalNormal?.get(previousOn) : undefined) ??
      (maySelect ? newAppearance(doc, true, resolve(dict.get('Rect'), doc)) : undefined);
    const offAppearance = originalNormal?.get('Off') ?? newAppearance(doc, false, resolve(dict.get('Rect'), doc));
    const normal = new PDFDict();
    if (selectedAppearance && (!radio || dict === widget.dict || originalNormal?.has(selected))) {
      normal.set(selected, selectedAppearance);
    }
    if (originalNormal) for (const [key, value] of originalNormal.entries()) {
      if (!normal.has(key)) normal.set(key, value);
    }
    normal.set('Off', offAppearance);
    const ap = new PDFDict(originalAp instanceof PDFDict ? [...originalAp.entries()] : []);
    ap.set('N', normal);
    if (originalAp instanceof PDFDict && previousOn && (!radio || dict === widget.dict)) {
      for (const variant of ['D', 'R']) {
        const value = resolve(originalAp.get(variant), doc);
        if (!(value instanceof PDFDict) || value.has(selected) || !value.has(previousOn)) continue;
        const copied = new PDFDict([...value.entries()]);
        copied.set(selected, value.get(previousOn)!);
        ap.set(variant, copied);
      }
    }
    dict.set('AP', ap);
    const on = checked && normal.has(selected) && (!radio || dict === widget.dict || radiosInUnison);
    dict.set('AS', new PDFName(on ? selected : 'Off'));
    if (dict !== owner) dict.delete('V');
  }
  owner.set('V', new PDFName(state));
  widget.value = state;
  widget.appearanceState = widget.dict.getName('AS') ?? 'Off';
}
