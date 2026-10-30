/**
 * JavaScript / Action Security Engine — Phase 9.
 */

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFRef,
  PDFStream,
  PDFString,
  PDFHexString,
  type PDFDocumentData,
  type PDFObject,
} from '../../types';
import { assertCompletePageTree } from '../validate-page-tree';
import { dehydrateDocument, hydrateDocument, sameDocumentSnapshot } from '../../worker/codec';
import { hasDocumentSignature, SignedDocumentEditError } from '../../writer/save-pipeline';
import { richMediaScripts, removeRichMediaScripts } from './richmedia-javascript';
import type {
  ActionKind,
  ActionRemovalResult,
  ActionSecurityReport,
  DetectedAction,
  IJavaScriptSecurityEngine,
} from '../types';

function resolveActionObject(obj: PDFObject | undefined, objects: Map<string, PDFObject>): PDFObject | undefined {
  const seen = new Set<string>();
  while (obj instanceof PDFRef) {
    const key = obj.toKey();
    if (seen.has(key)) return undefined;
    seen.add(key);
    obj = objects.get(key);
  }
  return obj;
}

function asDict(obj: PDFObject | undefined, objects: Map<string, PDFObject>): PDFDict | null {
  const r = resolveActionObject(obj, objects);
  return r instanceof PDFDict ? r : null;
}

/** XFA can embed its own scripts; deleting or editing it would alter the form. */
export function assertJavaScriptRemovalSupported(doc: PDFDocumentData): void {
  const formObject = doc.catalog.get('AcroForm');
  if (!formObject) return;
  const form = asDict(formObject, doc.objects);
  if (!form) throw new Error('Cannot safely inspect the interactive form for JavaScript; no changes were made.');
  if (form.has('XFA')) throw new Error('JavaScript removal does not support XFA forms; no changes were made.');
}

function actionKindFromDict(dict: PDFDict, objects: Map<string, PDFObject>): ActionKind {
  const raw = dict.get('S');
  const value = resolveActionObject(raw, objects);
  // A missing /S can be a destination dictionary. An unresolved or malformed
  // existing /S cannot safely be treated as a harmless unknown action.
  if (raw !== undefined && !(value instanceof PDFName)) {
    throw new Error('Cannot safely inspect an action type; no changes were made.');
  }
  const s = value instanceof PDFName ? value.name : 'Other';
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
  type Task = { kind: 'visit'; value: PDFObject; location: string } | { kind: 'leave'; value: PDFObject };
  const pending: Task[] = [{ kind: 'visit', value: actionObj, location }], ancestors = new Set<PDFObject>();
  let work = 0;
  while (pending.length) {
    if (++work > 100_000 || pending.length > 100_000) throw new Error('Cannot safely inspect actions: the action graph exceeds the inspection limit.');
    const task = pending.pop()!;
    if (task.kind === 'leave') { ancestors.delete(task.value); continue; }
    if (task.location.length > 131_072) throw new Error('Cannot safely inspect actions: the action graph exceeds the inspection depth.');
    const resolved = resolveActionObject(task.value, objects);
    if (!resolved || ancestors.has(resolved)) continue;
    if (resolved instanceof PDFName) { out.push({ kind: 'Named', location: task.location, detail: resolved.name }); continue; }
    if (resolved instanceof PDFArray) {
      if (resolved.length + pending.length > 100_000) throw new Error('Cannot safely inspect actions: the action graph exceeds the inspection limit.');
      ancestors.add(resolved);
      pending.push({ kind: 'leave', value: resolved });
      for (let i = resolved.length - 1; i >= 0; i--) {
        const item = resolved.get(i);
        if (item) pending.push({ kind: 'visit', value: item, location: `${task.location}[${i}]` });
      }
      continue;
    }
    if (!(resolved instanceof PDFDict)) continue;
    ancestors.add(resolved);
    const kind = actionKindFromDict(resolved, objects);
    const detail = kind === 'JavaScript' ? jsText(resolved)?.slice(0, 200)
      : resolved.getName('N') ?? resolved.getString('F') ?? resolved.getString('URI');
    out.push({ kind, location: task.location, detail,
      objectKey: task.value instanceof PDFRef ? task.value.toKey() : undefined });
    pending.push({ kind: 'leave', value: resolved });
    const next = resolved.get('Next');
    if (next) pending.push({ kind: 'visit', value: next, location: `${task.location}.Next` });
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

/** Form fields and outline items can own actions even without a page widget. */
function walkOtherActionOwners(
  doc: PDFDocumentData,
  visit: (owner: PDFDict, location: string) => void,
): void {
  const seenFields = new Set<PDFDict>();
  const form = asDict(doc.catalog.get('AcroForm'), doc.objects);
  const pendingFields: Array<{ value: PDFObject | undefined; location: string; field: boolean }> = form
    ? [{ value: form.get('Fields'), location: 'AcroForm.Fields', field: false }] : [];
  let work = 0;
  while (pendingFields.length) {
    if (++work > 100_000 || pendingFields.length > 100_000) throw new Error('Cannot safely inspect action owners: the field tree exceeds the inspection limit.');
    const item = pendingFields.pop()!;
    if (item.location.length > 131_072) throw new Error('Cannot safely inspect action owners: the field tree exceeds the inspection depth.');
    if (!item.field) {
      const array = resolveActionObject(item.value, doc.objects);
      if (!(array instanceof PDFArray)) continue;
      if (array.length + pendingFields.length > 100_000) throw new Error('Cannot safely inspect action owners: the field tree exceeds the inspection limit.');
      for (let i = array.length - 1; i >= 0; i--) pendingFields.push({ value: array.get(i), location: `${item.location}[${i}]`, field: true });
    } else {
      const field = asDict(item.value, doc.objects);
      if (!field || seenFields.has(field)) continue;
      seenFields.add(field);
      visit(field, item.location);
      pendingFields.push({ value: field.get('Kids'), location: `${item.location}.Kids`, field: false });
    }
  }

  const seenOutlines = new Set<PDFDict>();
  const outlines = asDict(doc.catalog.get('Outlines'), doc.objects);
  const pendingOutlines: Array<{ value: PDFObject | undefined; location: string }> = outlines
    ? [{ value: outlines.get('First'), location: 'Outlines.First' }] : [];
  work = 0;
  while (pendingOutlines.length) {
    if (++work > 100_000 || pendingOutlines.length > 100_000) throw new Error('Cannot safely inspect action owners: the outline tree exceeds the inspection limit.');
    const entry = pendingOutlines.pop()!;
    if (entry.location.length > 131_072) throw new Error('Cannot safely inspect action owners: the outline tree exceeds the inspection depth.');
    const item = asDict(entry.value, doc.objects);
    if (!item || seenOutlines.has(item)) continue;
    seenOutlines.add(item);
    visit(item, entry.location);
    pendingOutlines.push({ value: item.get('Next'), location: `${entry.location}.Next` });
    pendingOutlines.push({ value: item.get('First'), location: `${entry.location}.First` });
  }
}

/** Navigation nodes execute /NA and /PA when advancing within a page. */
function walkPageNavigation(
  doc: PDFDocumentData,
  visit: (node: PDFDict, location: string) => void,
): void {
  const seen = new Set<PDFDict>();
  const pending: { value: PDFObject | undefined; location: string }[] = doc.pages.map(page => ({
    value: page.dict.get('PresSteps'), location: `Page[${page.index}].PresSteps`,
  }));
  let work = 0;
  while (pending.length) {
    if (++work > 100_000 || pending.length > 100_000) throw new Error('Cannot safely inspect presentation actions: the navigation graph exceeds the inspection limit.');
    const { value, location } = pending.pop()!;
    if (location.length > 131_072) throw new Error('Cannot safely inspect presentation actions: the navigation graph exceeds the inspection depth.');
    const node = asDict(value, doc.objects);
    if (!node || seen.has(node)) continue;
    seen.add(node);
    visit(node, location);
    pending.push({ value: node.get('Next'), location: `${location}.Next` });
    pending.push({ value: node.get('Prev'), location: `${location}.Prev` });
  }
}

/** A 3D stream may contain an independent /OnInstantiate JavaScript stream. */
function visit3DScript(annot: PDFDict, objects: Map<string, PDFObject>, visit: (stream: PDFStream) => void): void {
  const rawSubtype = annot.get('Subtype');
  const subtype = resolveActionObject(rawSubtype, objects);
  if (annot.has('3DD') && !(subtype instanceof PDFName)) {
    throw new Error('Cannot safely inspect a 3D annotation subtype; no changes were made.');
  }
  if (!(subtype instanceof PDFName) || subtype.name !== '3D') return;
  const stream = resolveActionObject(annot.get('3DD'), objects);
  if (stream instanceof PDFStream && stream.dict.has('OnInstantiate')) visit(stream);
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
      const arr = resolveActionObject(annots, doc.objects);
      if (!(arr instanceof PDFArray)) continue;
      for (let i = 0; i < arr.length; i++) {
        const item = arr.get(i);
        const dict = asDict(item, doc.objects);
        if (!dict) continue;
        const loc = `Page[${page.index}].Annot[${i}]`;
        if (dict.has('A')) collectAction(dict.get('A'), doc.objects, `${loc}.A`, actions);
        const aa = asDict(dict.get('AA'), doc.objects);
        if (aa) walkAdditionalActions(aa, doc.objects, loc, actions);
        visit3DScript(dict, doc.objects, () => {
          actions.push({ kind: 'JavaScript', location: `${loc}.3DD.OnInstantiate` });
        });
        const scripts = richMediaScripts(dict, doc);
        if (scripts) actions.push({ kind: 'JavaScript', location: `${loc}.RichMediaSettings.Activation.Scripts` });
      }
    }

    walkOtherActionOwners(doc, (owner, location) => {
      if (owner.has('A')) collectAction(owner.get('A'), doc.objects, `${location}.A`, actions);
      const aa = asDict(owner.get('AA'), doc.objects);
      if (aa) walkAdditionalActions(aa, doc.objects, location, actions);
    });
    walkPageNavigation(doc, (node, location) => {
      collectAction(node.get('NA'), doc.objects, `${location}.NA`, actions);
      collectAction(node.get('PA'), doc.objects, `${location}.PA`, actions);
    });

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
    // Validate the complete operation on an isolated graph first. On unsigned
    // documents a late unsupported or malformed action must not leave earlier
    // actions removed; signed documents must also reject actual changes.
    const draft = hydrateDocument(dehydrateDocument(doc, { includeRawBytes: false }));
    if (hasDocumentSignature(doc)) {
      const before = dehydrateDocument(draft, { includeRawBytes: false });
      const result = this.disableActionsUnchecked(draft, kinds);
      const after = dehydrateDocument(draft, { includeRawBytes: false });
      // A no-op must not set a rewrite flag or change a signed revision.
      before.requiresFullRewrite = after.requiresFullRewrite = undefined;
      if (!sameDocumentSnapshot(before, after)) throw new SignedDocumentEditError();
      return result;
    }
    this.disableActionsUnchecked(draft, kinds);
    return this.disableActionsUnchecked(doc, kinds);
  }

  private disableActionsUnchecked(doc: PDFDocumentData, kinds: ActionKind[]): ActionRemovalResult {
    assertCompletePageTree(doc, reason => {
      throw new Error(`Cannot safely remove actions: ${reason}; no changes were made.`);
    });
    const kindSet = new Set(kinds);
    if (kindSet.has('JavaScript')) assertJavaScriptRemovalSupported(doc);
    const locations: string[] = [];
    let removed = 0;

    const shouldStrip = (dict: PDFDict): boolean => kindSet.has(actionKindFromDict(dict, doc.objects));
    const visited = new Set<PDFObject>();
    const emptiedArrays = new Set<PDFArray>();
    let actionWork = 0;
    const richMediaBudget = { remaining: 200_000 };

    // Mutate retained action graphs in place so shared indirect references are
    // cleaned at every entry point. Removing an action removes its entire
    // continuation; forwarding its /Next array into /A would be invalid PDF.
    const stripAction = (value: PDFObject, location: string, namedOpenAction = false): boolean => {
      type Task = { kind: 'visit'; value: PDFObject; location: string; named: boolean; done: (remove: boolean) => void } |
        { kind: 'finish'; done: (remove: boolean) => void; array?: PDFArray };
      let result = false;
      const pending: Task[] = [{ kind: 'visit', value, location, named: namedOpenAction, done: remove => { result = remove; } }];
      while (pending.length) {
        if (++actionWork > 100_000 || pending.length > 100_000) {
          throw new Error('Cannot safely remove actions: the action graph exceeds the inspection limit; no changes were made.');
        }
        const task = pending.pop()!;
        if (task.kind === 'finish') { task.done(task.array ? emptiedArrays.has(task.array) && task.array.length === 0 : false); continue; }
        if (task.location.length > 131_072) {
          throw new Error('Cannot safely remove actions: the action graph exceeds the inspection depth; no changes were made.');
        }
        const resolved = resolveActionObject(task.value, doc.objects);
        if (!resolved) { task.done(false); continue; }
        if ((resolved instanceof PDFName && task.named && kindSet.has('Named')) ||
            (resolved instanceof PDFDict && shouldStrip(resolved))) {
          doc.requiresFullRewrite = true;
          removed++;
          locations.push(task.location);
          task.done(true);
          continue;
        }
        if (visited.has(resolved)) { task.done(resolved instanceof PDFArray && emptiedArrays.has(resolved) && resolved.length === 0); continue; }
        visited.add(resolved);
        if (resolved instanceof PDFArray) {
          if (resolved.length + pending.length > 100_000) {
            throw new Error('Cannot safely remove actions: the action graph exceeds the inspection limit; no changes were made.');
          }
          pending.push({ kind: 'finish', done: task.done, array: resolved });
          // Stack order visits the last index first, preserving splice indices.
          for (let i = 0; i < resolved.length; i++) {
            const item = resolved.get(i);
            if (item) pending.push({ kind: 'visit', value: item, location: `${task.location}[${i}]`, named: false,
              done: remove => {
                if (remove) {
                  resolved.items.splice(i, 1);
                  if (resolved.length === 0) emptiedArrays.add(resolved);
                }
              } });
          }
        } else if (resolved instanceof PDFDict) {
          const next = resolved.get('Next');
          pending.push({ kind: 'finish', done: task.done });
          if (next) pending.push({ kind: 'visit', value: next, location: `${task.location}.Next`, named: false,
            done: remove => { if (remove) resolved.delete('Next'); } });
        } else task.done(false);
      }
      return result;
    };

    const stripActionField = (
      parent: PDFDict,
      key: string,
      location: string,
    ): void => {
      const val = parent.get(key);
      if (!val) return;

      if (stripAction(val, location, key === 'OpenAction')) parent.delete(key);
    };

    const stripAA = (parent: PDFDict, location: string): void => {
      const aa = asDict(parent.get('AA'), doc.objects);
      if (!aa) return;
      for (const key of [...aa.keys()]) {
        stripActionField(aa, key, `${location}.AA.${key}`);
      }
      if ([...aa.keys()].length === 0) {
        parent.delete('AA');
        doc.requiresFullRewrite = true;
      }
    };

    // Catalog
    if (kindSet.has('OpenAction') && doc.catalog.has('OpenAction')) {
      doc.requiresFullRewrite = true;
      doc.catalog.delete('OpenAction');
      removed++;
      locations.push('Catalog.OpenAction');
    } else if (kinds.length > 0) {
      stripActionField(doc.catalog, 'OpenAction', 'Catalog.OpenAction');
    }
    stripAA(doc.catalog, 'Catalog');

    // Names/JavaScript
    if (kindSet.has('JavaScript')) {
      const names = asDict(doc.catalog.get('Names'), doc.objects);
      if (names && names.has('JavaScript')) {
        doc.requiresFullRewrite = true;
        names.delete('JavaScript');
        removed++;
        locations.push('Catalog.Names.JavaScript');
      }
    }

    for (const page of doc.pages) {
      stripAA(page.dict, `Page[${page.index}]`);
      const annots = page.dict.get('Annots');
      if (!annots) continue;
      const arr = resolveActionObject(annots, doc.objects);
      if (!(arr instanceof PDFArray)) continue;
      for (let i = 0; i < arr.length; i++) {
        const item = arr.get(i);
        const dict = asDict(item, doc.objects);
        if (!dict) continue;
        const loc = `Page[${page.index}].Annot[${i}]`;
        stripActionField(dict, 'A', `${loc}.A`);
        stripAA(dict, loc);
        if (kindSet.has('JavaScript')) visit3DScript(dict, doc.objects, stream => {
          doc.requiresFullRewrite = true;
          stream.dict.delete('OnInstantiate');
          removed++;
          locations.push(`${loc}.3DD.OnInstantiate`);
        });
        if (kindSet.has('JavaScript')) {
          const scripts = richMediaScripts(dict, doc);
          if (scripts) {
            removed += removeRichMediaScripts(dict, doc, scripts, richMediaBudget);
            locations.push(`${loc}.RichMediaSettings.Activation.Scripts`);
          }
        }
      }
    }

    walkOtherActionOwners(doc, (owner, location) => {
      stripActionField(owner, 'A', `${location}.A`);
      stripAA(owner, location);
    });
    walkPageNavigation(doc, (node, location) => {
      stripActionField(node, 'NA', `${location}.NA`);
      stripActionField(node, 'PA', `${location}.PA`);
    });

    return { removed, disabled: removed, locations };
  }
}

function collectJsNameTree(
  tree: PDFDict,
  objects: Map<string, PDFObject>,
  out: DetectedAction[],
  seen: Set<PDFDict> = new Set(),
): void {
  const pending: PDFDict[] = [tree];
  while (pending.length) {
    if (seen.size >= 100_000 || pending.length > 100_000) throw new Error('Cannot safely inspect JavaScript names: the name tree exceeds the inspection limit.');
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const names = resolveActionObject(current.get('Names'), objects);
    if (names instanceof PDFArray) {
      for (let i = 0; i + 1 < names.length; i += 2) {
        const nameObj = names.get(i);
        const name = nameObj instanceof PDFString ? nameObj.value : nameObj instanceof PDFName ? nameObj.name : '?';
        const entry = asDict(names.get(i + 1), objects);
        if (entry) {
          const js = jsText(entry) ?? entry.getString('JS');
          out.push({ kind: 'JavaScript', location: `Names.JavaScript.${name}`, detail: js?.slice(0, 200) });
        }
      }
    }
    const kids = resolveActionObject(current.get('Kids'), objects);
    if (kids instanceof PDFArray) {
      if (kids.length + pending.length > 100_000) throw new Error('Cannot safely inspect JavaScript names: the name tree exceeds the inspection limit.');
      for (let i = kids.length - 1; i >= 0; i--) {
        const kid = asDict(kids.get(i), objects);
        if (kid) pending.push(kid);
      }
    }
  }
}

export const javaScriptSecurityEngine = new JavaScriptSecurityEngine();
