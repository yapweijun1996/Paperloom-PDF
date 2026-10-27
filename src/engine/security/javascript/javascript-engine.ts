/**
 * JavaScript / Action Security Engine — Phase 9.
 */

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFRef,
  PDFString,
  PDFHexString,
  type PDFDocumentData,
  type PDFObject,
} from '../../types';
import { resolveRef } from '../../parser/parser';
import type {
  ActionKind,
  ActionRemovalResult,
  ActionSecurityReport,
  DetectedAction,
  IJavaScriptSecurityEngine,
} from '../types';

function asDict(obj: PDFObject | undefined, objects: Map<string, PDFObject>): PDFDict | null {
  if (!obj) return null;
  const r = resolveRef(obj, objects);
  return r instanceof PDFDict ? r : null;
}

function actionKindFromDict(dict: PDFDict): ActionKind {
  const s = dict.getName('S') ?? 'Other';
  switch (s) {
    case 'JavaScript':
      return 'JavaScript';
    case 'Launch':
      return 'Launch';
    case 'SubmitForm':
      return 'SubmitForm';
    case 'ResetForm':
      return 'ResetForm';
    case 'ImportData':
      return 'ImportData';
    case 'Named':
      return 'Named';
    case 'URI':
      return 'URI';
    case 'GoTo':
      return 'GoTo';
    case 'GoToR':
      return 'GoToR';
    default:
      return 'Other';
  }
}

function jsText(dict: PDFDict): string | undefined {
  const js = dict.get('JS');
  if (js instanceof PDFString) return js.value;
  if (js instanceof PDFHexString) return js.toText();
  return undefined;
}

function collectAction(
  actionObj: PDFObject | undefined,
  objects: Map<string, PDFObject>,
  location: string,
  out: DetectedAction[],
): void {
  if (!actionObj) return;

  // Action can be a name (Named action shorthand) or dict or array of actions
  if (actionObj instanceof PDFName) {
    out.push({ kind: 'Named', location, detail: actionObj.name });
    return;
  }

  if (actionObj instanceof PDFArray) {
    for (let i = 0; i < actionObj.length; i++) {
      collectAction(actionObj.get(i), objects, `${location}[${i}]`, out);
    }
    return;
  }

  const dict = asDict(actionObj, objects);
  if (!dict) return;

  const kind = actionKindFromDict(dict);
  const detail =
    kind === 'JavaScript'
      ? jsText(dict)?.slice(0, 200)
      : dict.getName('N') ?? dict.getString('F') ?? dict.getString('URI');

  out.push({
    kind,
    location,
    detail,
    objectKey: actionObj instanceof PDFRef ? actionObj.toKey() : undefined,
  });

  // Chained Next action
  if (dict.has('Next')) {
    collectAction(dict.get('Next'), objects, `${location}.Next`, out);
  }
}

function walkAdditionalActions(
  aa: PDFDict,
  objects: Map<string, PDFObject>,
  location: string,
  out: DetectedAction[],
): void {
  for (const [key, value] of aa.entries()) {
    collectAction(value, objects, `${location}.AA.${key}`, out);
  }
}

export class JavaScriptSecurityEngine implements IJavaScriptSecurityEngine {
  analyze(doc: PDFDocumentData): ActionSecurityReport {
    const actions: DetectedAction[] = [];

    // Catalog OpenAction
    if (doc.catalog.has('OpenAction')) {
      collectAction(doc.catalog.get('OpenAction'), doc.objects, 'Catalog.OpenAction', actions);
    }

    // Catalog AA
    const catAA = asDict(doc.catalog.get('AA'), doc.objects);
    if (catAA) walkAdditionalActions(catAA, doc.objects, 'Catalog', actions);

    // Names → JavaScript name tree
    const names = asDict(doc.catalog.get('Names'), doc.objects);
    if (names) {
      const jsTree = asDict(names.get('JavaScript'), doc.objects);
      if (jsTree) collectJsNameTree(jsTree, doc.objects, actions);
    }

    // Pages + annotations + widgets
    for (const page of doc.pages) {
      const pageAA = asDict(page.dict.get('AA'), doc.objects);
      if (pageAA) walkAdditionalActions(pageAA, doc.objects, `Page[${page.index}]`, actions);

      const annots = page.dict.get('Annots');
      if (!annots) continue;
      const arr = annots instanceof PDFRef ? resolveRef(annots, doc.objects) : annots;
      if (!(arr instanceof PDFArray)) continue;
      for (let i = 0; i < arr.length; i++) {
        const item = arr.get(i);
        if (!(item instanceof PDFRef)) continue;
        const dict = asDict(item, doc.objects);
        if (!dict) continue;
        const loc = `Page[${page.index}].Annot[${i}]`;
        if (dict.has('A')) collectAction(dict.get('A'), doc.objects, `${loc}.A`, actions);
        const aa = asDict(dict.get('AA'), doc.objects);
        if (aa) walkAdditionalActions(aa, doc.objects, loc, actions);
      }
    }

    const hasJavaScript = actions.some((a) => a.kind === 'JavaScript');
    const hasLaunch = actions.some((a) => a.kind === 'Launch');
    const hasOpenAction = actions.some((a) => a.location.includes('OpenAction'));
    const hasSubmitForm = actions.some((a) => a.kind === 'SubmitForm');

    const warnings: string[] = [];
    if (hasJavaScript) warnings.push('Document contains JavaScript actions');
    if (hasLaunch) warnings.push('Document can launch external applications');
    if (hasSubmitForm) warnings.push('Document can submit form data to a URL');
    if (hasOpenAction) warnings.push('Document runs an action on open');

    const summary =
      actions.length === 0
        ? 'No potentially risky PDF actions detected'
        : `Found ${actions.length} action(s)` +
          (hasJavaScript ? ' including JavaScript' : '');

    return {
      actions,
      hasJavaScript,
      hasLaunch,
      hasOpenAction,
      hasSubmitForm,
      warnings,
      summary,
    };
  }

  findJavaScript(doc: PDFDocumentData): string[] {
    return this.analyze(doc)
      .actions.filter((a) => a.kind === 'JavaScript')
      .map((a) => a.detail ?? a.location);
  }

  removeJavaScript(doc: PDFDocumentData): ActionRemovalResult {
    return this.disableActions(doc, ['JavaScript']);
  }

  disableActions(
    doc: PDFDocumentData,
    kinds: ActionKind[] = ['JavaScript', 'Launch', 'SubmitForm', 'ImportData', 'ResetForm'],
  ): ActionRemovalResult {
    const kindSet = new Set(kinds);
    const locations: string[] = [];
    let removed = 0;

    const shouldStrip = (dict: PDFDict): boolean => kindSet.has(actionKindFromDict(dict));

    const stripActionField = (
      parent: PDFDict,
      key: string,
      location: string,
    ): void => {
      const val = parent.get(key);
      if (!val) return;

      if (val instanceof PDFArray) {
        for (let i = val.length - 1; i >= 0; i--) {
          const d = asDict(val.get(i), doc.objects);
          if (d && shouldStrip(d)) {
            val.items.splice(i, 1);
            removed++;
            locations.push(`${location}[${i}]`);
          }
        }
        if (val.length === 0) parent.delete(key);
        return;
      }

      const d = asDict(val, doc.objects);
      if (d && shouldStrip(d)) {
        parent.delete(key);
        removed++;
        locations.push(location);
        if (val instanceof PDFRef) doc.objects.delete(val.toKey());
      } else if (kindSet.has('Named') && val instanceof PDFName && key === 'OpenAction') {
        parent.delete(key);
        removed++;
        locations.push(location);
      }
    };

    const stripAA = (parent: PDFDict, location: string): void => {
      const aa = asDict(parent.get('AA'), doc.objects);
      if (!aa) return;
      for (const key of [...aa.keys()]) {
        const d = asDict(aa.get(key), doc.objects);
        if (d && shouldStrip(d)) {
          aa.delete(key);
          removed++;
          locations.push(`${location}.AA.${key}`);
        }
      }
      if ([...aa.keys()].length === 0) parent.delete('AA');
    };

    // Catalog
    if (kindSet.has('OpenAction') || kinds.some((k) => k !== 'OpenAction')) {
      stripActionField(doc.catalog, 'OpenAction', 'Catalog.OpenAction');
      // If OpenAction specifically requested as kind, also remove any OpenAction
      if (kindSet.has('OpenAction') && doc.catalog.has('OpenAction')) {
        // Already handled if action kind matched; force-remove remaining OpenAction when requested
        if (kinds.includes('OpenAction')) {
          const oa = doc.catalog.get('OpenAction');
          const d = asDict(oa, doc.objects);
          if (!d || shouldStrip(d) || kinds.includes('OpenAction')) {
            // Only force if OpenAction kind explicitly listed — remove regardless of S
            if (kinds.length === 1 && kinds[0] === 'OpenAction') {
              doc.catalog.delete('OpenAction');
              removed++;
              locations.push('Catalog.OpenAction');
            }
          }
        }
      }
    }
    stripAA(doc.catalog, 'Catalog');

    // Names/JavaScript
    if (kindSet.has('JavaScript')) {
      const names = asDict(doc.catalog.get('Names'), doc.objects);
      if (names && names.has('JavaScript')) {
        names.delete('JavaScript');
        removed++;
        locations.push('Catalog.Names.JavaScript');
      }
    }

    for (const page of doc.pages) {
      stripAA(page.dict, `Page[${page.index}]`);
      const annots = page.dict.get('Annots');
      if (!annots) continue;
      const arr = annots instanceof PDFRef ? resolveRef(annots, doc.objects) : annots;
      if (!(arr instanceof PDFArray)) continue;
      for (let i = 0; i < arr.length; i++) {
        const item = arr.get(i);
        if (!(item instanceof PDFRef)) continue;
        const dict = asDict(item, doc.objects);
        if (!dict) continue;
        const loc = `Page[${page.index}].Annot[${i}]`;
        stripActionField(dict, 'A', `${loc}.A`);
        stripAA(dict, loc);
      }
    }

    return { removed, disabled: removed, locations };
  }
}

function collectJsNameTree(
  tree: PDFDict,
  objects: Map<string, PDFObject>,
  out: DetectedAction[],
): void {
  const names = tree.get('Names');
  if (names instanceof PDFArray) {
    for (let i = 0; i + 1 < names.length; i += 2) {
      const nameObj = names.get(i);
      const name =
        nameObj instanceof PDFString ? nameObj.value : nameObj instanceof PDFName ? nameObj.name : '?';
      const entry = asDict(names.get(i + 1), objects);
      if (entry) {
        const js = jsText(entry) ?? entry.getString('JS');
        out.push({
          kind: 'JavaScript',
          location: `Names.JavaScript.${name}`,
          detail: js?.slice(0, 200),
        });
      }
    }
  }
  const kids = tree.get('Kids');
  if (kids instanceof PDFArray) {
    for (let i = 0; i < kids.length; i++) {
      const kid = asDict(kids.get(i), objects);
      if (kid) collectJsNameTree(kid, objects, out);
    }
  }
}

export const javaScriptSecurityEngine = new JavaScriptSecurityEngine();
