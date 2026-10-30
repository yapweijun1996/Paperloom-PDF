/**
 * Page Operations
 *
 * Structural operations on PDF page trees:
 *   - Delete pages
 *   - Reorder pages
 *   - Rotate pages
 *   - Extract pages into a new document
 *   - Merge pages from another document
 *   - Insert blank pages
 *
 * All operations modify the in-memory document structure.
 * Call the serializer or incremental writer to produce output bytes.
 */

import {
  PDFArray,
  PDFBoolean,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFNull,
  PDFObject,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFDocumentData,
  type PDFPageInfo,
  type PDFRectangle,
} from '../types';
import { resolveRef } from '../parser/parser';
import { inspectContentRefs } from '../parser/content-refs';
import { PDFLexer, TokenType } from '../parser/lexer';
import { getNextObjNum } from './serializer';
import { hasDocumentSignature } from './save-pipeline';
import { bindPageContentRefs } from '../editor/stream-compiler';

// ─── Page deletion ──────────────────────────────────────────────────────────

/**
 * Delete a page from the document by index.
 * Modifies the document's page tree and updates the pages array.
 */
export function deletePage(doc: PDFDocumentData, pageIndex: number): void {
  deletePages(doc, [pageIndex]);
}

/** Detach widgets on deleted pages while retaining fields with other widgets. */
function planDeletedPageFormCleanup(doc: PDFDocumentData, pages: PDFPageInfo[]): () => void {
  const fail = (): never => { throw new Error('Cannot safely delete a page with an ambiguous AcroForm field structure.'); };
  const formValue = doc.catalog.get('AcroForm');
  if (!formValue) return () => {};
  const form = resolveRef(formValue, doc.objects);
  if (!(form instanceof PDFDict)) return fail();
  const removedWidgets = new Set<string>();
  const annotatedPage = new Map<string, PDFDict>();
  const deletedPages = new Set(pages.map(page => page.dict));
  const deletedPageRefs = new Set(pages.map(page => page.ref.toKey()));
  for (const page of pages) {
    const pageAnnots = page.dict.get('Annots');
    const annots = pageAnnots ? resolveRef(pageAnnots, doc.objects) : new PDFArray();
    if (!(annots instanceof PDFArray)) return fail();
    for (const entry of annots.items) {
      const annot = resolveRef(entry, doc.objects);
      if (!(annot instanceof PDFDict)) return fail();
      if (annot.getName('Subtype') === 'Widget') {
        if (!(entry instanceof PDFRef) || annotatedPage.has(entry.toKey())) return fail();
        removedWidgets.add(entry.toKey());
        annotatedPage.set(entry.toKey(), page.dict);
      }
    }
  }
  const rootsValue = form.get('Fields');
  if (!rootsValue && !removedWidgets.size) return () => {};
  const roots = rootsValue ? resolveRef(rootsValue, doc.objects) : undefined;
  if (!(roots instanceof PDFArray)) return fail();
  const replacements = new Map<PDFArray, PDFObject[]>();
  const removedFields = new Set<string>();
  const removedFieldDicts = new Set<PDFDict>();
  const matchedWidgets = new Set<string>();
  const seen = new Set<string>();
  const fieldArrays = new Set<PDFArray>([roots]);
  const walk = (ref: PDFObject, depth: number): boolean => {
    if (!(ref instanceof PDFRef) || depth > 128 || seen.has(ref.toKey()) || seen.size >= 100_000) return fail();
    seen.add(ref.toKey());
    const field = resolveRef(ref, doc.objects);
    if (!(field instanceof PDFDict)) return fail();
    const inDeletedPageAnnots = removedWidgets.has(ref.toKey());
    const widgetPage = field.get('P');
    const widgetPageObject = widgetPage ? resolveRef(widgetPage, doc.objects) : undefined;
    if (inDeletedPageAnnots && widgetPage && widgetPageObject !== annotatedPage.get(ref.toKey())) return fail();
    // A malformed page may omit its widget from /Annots while the widget's
    // /P still points to it. Treat that as belonging to the deleted page,
    // provided no surviving page also lists the widget.
    const removeWidget = inDeletedPageAnnots ||
      (field.getName('Subtype') === 'Widget' && widgetPageObject instanceof PDFDict && deletedPages.has(widgetPageObject));
    if (removeWidget) {
      removedWidgets.add(ref.toKey());
      matchedWidgets.add(ref.toKey());
    }
    const kidsValue = field.get('Kids');
    if (!kidsValue) {
      if (removeWidget) {
        removedFields.add(ref.toKey());
        removedFieldDicts.add(field);
      }
      return removeWidget;
    }
    if (removeWidget) return fail();
    const kids = resolveRef(kidsValue, doc.objects);
    if (!(kids instanceof PDFArray)) return fail();
    if (fieldArrays.has(kids)) return fail();
    fieldArrays.add(kids);
    const kept = kids.items.filter(kid => !walk(kid, depth + 1));
    if (kept.length !== kids.length) replacements.set(kids, kept);
    if (kids.length > 0 && kept.length === 0) {
      removedFields.add(ref.toKey());
      removedFieldDicts.add(field);
      return true;
    }
    return false;
  };
  const keptRoots = roots.items.filter(root => !walk(root, 0));
  if (matchedWidgets.size !== removedWidgets.size) return fail();
  if (!removedWidgets.size) return () => {};
  if (form.has('XFA')) return fail();
  for (const other of doc.pages) {
    if (deletedPages.has(other.dict)) continue;
    const value = other.dict.get('Annots');
    if (!value) continue;
    const otherAnnots = resolveRef(value, doc.objects);
    if (!(otherAnnots instanceof PDFArray)) return fail();
    if (otherAnnots.items.some(item => item instanceof PDFRef && removedWidgets.has(item.toKey()))) return fail();
  }
  if (keptRoots.length !== roots.length) replacements.set(roots, keptRoots);
  const orderValue = form.get('CO');
  if (orderValue) {
    const order = resolveRef(orderValue, doc.objects);
    if (!(order instanceof PDFArray)) return fail();
    if (fieldArrays.has(order)) return fail();
    const kept = order.items.filter(item => !(item instanceof PDFRef && removedFields.has(item.toKey())));
    if (kept.length !== order.length) replacements.set(order, kept);
  }

  // Reject references to pruned fields from outside the field tree: otherwise
  // their widgets can still retain the supposedly deleted page and its data.
  const pending: PDFObject[] = [doc.xref.trailerDict];
  const visited = new Set<PDFObject>();
  const visitedRefs = new Set<string>();
  while (pending.length) {
    const value = pending.pop()!;
    if (value instanceof PDFRef) {
      if (deletedPageRefs.has(value.toKey())) continue;
      if (removedFields.has(value.toKey())) return fail();
      if (visitedRefs.has(value.toKey())) continue;
      if (visitedRefs.size >= 200_000) return fail();
      visitedRefs.add(value.toKey());
      const object = doc.objects.get(value.toKey());
      if (!object) return fail();
      pending.push(object);
    } else if (!visited.has(value)) {
      if (value instanceof PDFDict && removedFieldDicts.has(value)) return fail();
      visited.add(value);
      if (visited.size > 200_000) return fail();
      if (value instanceof PDFArray) pending.push(...(replacements.get(value) ?? value.items));
      else if (value instanceof PDFDict) pending.push(...value.values());
      else if (value instanceof PDFStream) pending.push(value.dict);
    }
  }
  return () => { for (const [array, kept] of replacements) array.items.splice(0, array.items.length, ...kept); };
}

function containsRef(obj: PDFObject, target: PDFRef, objects: Map<string, PDFObject>, seen = new Set<string>()): boolean {
  if (obj instanceof PDFRef) {
    if (obj.equals(target)) return true;
    const key = obj.toKey();
    if (seen.has(key)) return false;
    seen.add(key);
    const resolved = objects.get(key);
    return resolved ? containsRef(resolved, target, objects, seen) : false;
  }
  if (obj instanceof PDFArray) return obj.items.some((item) => containsRef(item, target, objects, seen));
  if (obj instanceof PDFDict) return Array.from(obj.values()).some((value) => containsRef(value, target, objects, seen));
  if (obj instanceof PDFStream) return containsRef(obj.dict, target, objects, seen);
  return false;
}

/**
 * Check a destination or action for a page reference without walking through
 * page dictionaries. A page dictionary points back into the shared page tree,
 * so resolving a destination's surviving page ref with containsRef() can
 * incorrectly discover the page being deleted through a sibling /Kids entry.
 */
function containsDestinationRef(
  obj: PDFObject,
  target: PDFRef,
  objects: Map<string, PDFObject>,
): boolean {
  const pending = [obj];
  const seenRefs = new Set<string>();
  const seenObjects = new Set<PDFObject>();
  while (pending.length) {
    const current = pending.pop()!;
    if (current instanceof PDFRef) {
      if (current.equals(target)) return true;
      if (seenRefs.has(current.toKey())) continue;
      seenRefs.add(current.toKey());
      const resolved = objects.get(current.toKey());
      if (resolved instanceof PDFDict && (resolved.getName('Type') === 'Page' || resolved.getName('Type') === 'Pages')) continue;
      if (resolved) pending.push(resolved);
    } else if (!seenObjects.has(current)) {
      seenObjects.add(current);
      if (current instanceof PDFArray) for (const item of current.items) pending.push(item);
      else if (current instanceof PDFDict) for (const item of current.values()) pending.push(item);
      else if (current instanceof PDFStream) pending.push(current.dict);
    }
  }
  return false;
}

/** Check recursive structures before any of the deletion's mutations occur. */
function validatePageDeletionTrees(doc: PDFDocumentData): void {
  const fail = (): never => { throw new Error('Cannot safely delete pages with a malformed or excessively deep destination tree.'); };
  const outlines = doc.catalog.get('Outlines');
  const outlineRoot = outlines ? resolveRef(outlines, doc.objects) : undefined;
  if (outlines && !(outlineRoot instanceof PDFDict)) return fail();
  if (outlineRoot instanceof PDFDict) {
    const stack: Array<{ first: PDFObject | undefined; last: PDFObject | undefined; depth: number }> =
      [{ first: outlineRoot.get('First'), last: outlineRoot.get('Last'), depth: 0 }];
    const visited = new Set<string>();
    while (stack.length) {
      const { first, last, depth } = stack.pop()!;
      if (depth > 128) return fail();
      let ref = first;
      let reachedLast = !last;
      while (ref) {
        if (!(ref instanceof PDFRef) || visited.has(ref.toKey()) || visited.size >= 100_000) return fail();
        visited.add(ref.toKey());
        const item = doc.objects.get(ref.toKey());
        if (!(item instanceof PDFDict)) return fail();
        if (item.has('First')) stack.push({ first: item.get('First'), last: item.get('Last'), depth: depth + 1 });
        if (last instanceof PDFRef && last.equals(ref)) { reachedLast = true; break; }
        ref = item.get('Next');
      }
      if (!reachedLast) return fail();
    }
  }
  const namesEntry = doc.catalog.get('Names');
  const names = namesEntry ? resolveRef(namesEntry, doc.objects) : undefined;
  const tree = names instanceof PDFDict ? names.get('Dests') : undefined;
  if (!tree) return;
  const stack: Array<{ node: PDFObject; depth: number }> = [{ node: tree, depth: 0 }];
  const visited = new Set<PDFDict>();
  while (stack.length) {
    const { node: entry, depth } = stack.pop()!;
    const node = resolveRef(entry, doc.objects);
    if (!(node instanceof PDFDict) || depth > 128 || visited.has(node) || visited.size >= 100_000) return fail();
    visited.add(node);
    const kidsEntry = node.get('Kids');
    if (kidsEntry) {
      const kids = resolveRef(kidsEntry, doc.objects);
      if (!(kids instanceof PDFArray)) return fail();
      for (const kid of kids.items) stack.push({ node: kid, depth: depth + 1 });
    }
  }
}

function outlineList(doc: PDFDocumentData, first: PDFObject | undefined, last?: PDFObject): PDFRef[] {
  const refs: PDFRef[] = [];
  const seen = new Set<string>();
  let current = first;
  while (current instanceof PDFRef && !seen.has(current.toKey())) {
    seen.add(current.toKey());
    refs.push(current);
    if (last instanceof PDFRef && current.equals(last)) break;
    const item = doc.objects.get(current.toKey());
    current = item instanceof PDFDict ? item.get('Next') : undefined;
  }
  return refs;
}

function rewriteOutlineList(
  doc: PDFDocumentData,
  refs: PDFRef[],
  parent: PDFRef,
  pageRef: PDFRef,
): PDFRef[] {
  const kept: PDFRef[] = [];
  for (const ref of refs) {
    const item = doc.objects.get(ref.toKey());
    if (!(item instanceof PDFDict)) continue;

    const children = rewriteOutlineList(doc, outlineList(doc, item.get('First'), item.get('Last')), ref, pageRef);
    const drops = containsDestinationRef(item.get('Dest') ?? PDFNull.instance, pageRef, doc.objects) ||
      containsDestinationRef(item.get('A') ?? PDFNull.instance, pageRef, doc.objects);

    if (drops) {
      // Promote children of a deleted parent so a surviving subtree is not
      // lost merely because its heading pointed at the removed page.
      for (const childRef of children) {
        const child = doc.objects.get(childRef.toKey());
        if (child instanceof PDFDict) child.set('Parent', parent);
      }
      kept.push(...children);
      continue;
    }

    item.set('Parent', parent);
    if (children.length > 0) {
      item.set('First', children[0]);
      item.set('Last', children[children.length - 1]);
      item.set('Count', new PDFNumber(children.length));
    } else {
      item.delete('First');
      item.delete('Last');
      item.delete('Count');
    }
    kept.push(ref);
  }

  for (let i = 0; i < kept.length; i++) {
    const item = doc.objects.get(kept[i].toKey());
    if (!(item instanceof PDFDict)) continue;
    if (i > 0) item.set('Prev', kept[i - 1]); else item.delete('Prev');
    if (i + 1 < kept.length) item.set('Next', kept[i + 1]); else item.delete('Next');
  }
  return kept;
}

/**
 * Prune destination name-tree pairs, preserving sibling trees and updating
 * bounds up through /Kids. Cyclic or unrecognized nodes are left intact.
 */
function pruneDestinationTree(
  doc: PDFDocumentData,
  tree: PDFObject,
  pageRef: PDFRef,
  seen = new Set<PDFDict>(),
): 'unchanged' | 'changed' | 'empty' {
  const node = resolveRef(tree, doc.objects);
  if (!(node instanceof PDFDict) || seen.has(node)) return 'unchanged';
  seen.add(node);
  const names = resolveRef(node.get('Names') ?? PDFNull.instance, doc.objects);
  const kids = resolveRef(node.get('Kids') ?? PDFNull.instance, doc.objects);
  let changed = false;
  if (names instanceof PDFArray) {
    for (let i = 0; i + 1 < names.items.length;) {
      if (containsDestinationRef(names.items[i + 1], pageRef, doc.objects)) {
        names.items.splice(i, 2);
        changed = true;
      } else {
        i += 2;
      }
    }
  }
  if (kids instanceof PDFArray) {
    for (let i = 0; i < kids.items.length;) {
      const result = pruneDestinationTree(doc, kids.items[i], pageRef, seen);
      if (result !== 'unchanged') changed = true;
      if (result === 'empty') kids.items.splice(i, 1); else i++;
    }
  }
  if (!changed) return 'unchanged';
  if (names instanceof PDFArray && names.length === 0) node.delete('Names');
  if (kids instanceof PDFArray && kids.length === 0) node.delete('Kids');
  if (!node.has('Names') && !node.has('Kids')) return 'empty';

  let first: PDFObject | undefined;
  let last: PDFObject | undefined;
  if (names instanceof PDFArray && names.length > 0 && names.length % 2 === 0) {
    first = names.items[0];
    last = names.items[names.length - 2];
  } else if (kids instanceof PDFArray && kids.length > 0) {
    const firstChild = resolveRef(kids.items[0], doc.objects);
    const lastChild = resolveRef(kids.items[kids.length - 1], doc.objects);
    const firstLimits = resolveRef(firstChild instanceof PDFDict ? firstChild.get('Limits') ?? PDFNull.instance : PDFNull.instance, doc.objects);
    const lastLimits = resolveRef(lastChild instanceof PDFDict ? lastChild.get('Limits') ?? PDFNull.instance : PDFNull.instance, doc.objects);
    if (firstLimits instanceof PDFArray) first = firstLimits.items[0];
    if (lastLimits instanceof PDFArray) last = lastLimits.items[1];
  }
  if ((first instanceof PDFString || first instanceof PDFHexString) &&
      (last instanceof PDFString || last instanceof PDFHexString)) {
    node.set('Limits', new PDFArray([first, last]));
  } else {
    // Malformed bounds must not remain stale after pruning.
    node.delete('Limits');
  }
  return 'changed';
}

function removeDeletedPageDestinations(doc: PDFDocumentData, pageRef: PDFRef): void {
  const catalog = doc.catalog;
  const outlines = catalog.get('Outlines');
  const outlineRoot = outlines instanceof PDFRef ? doc.objects.get(outlines.toKey()) : outlines;
  if (outlineRoot instanceof PDFDict) {
    const kept = rewriteOutlineList(doc, outlineList(doc, outlineRoot.get('First'), outlineRoot.get('Last')), outlines as PDFRef, pageRef);
    if (kept.length > 0) {
      outlineRoot.set('First', kept[0]);
      outlineRoot.set('Last', kept[kept.length - 1]);
      outlineRoot.set('Count', new PDFNumber(kept.length));
    } else {
      catalog.delete('Outlines');
    }
  }

  // Prune legacy catalog destinations individually so surviving named
  // destinations remain valid after page deletion.
  const dests = catalog.get('Dests');
  const destDict = resolveRef(dests ?? PDFNull.instance, doc.objects);
  if (destDict instanceof PDFDict) {
    let changed = false;
    for (const [name, destination] of Array.from(destDict.entries())) {
      if (containsDestinationRef(destination, pageRef, doc.objects)) {
        destDict.delete(name);
        changed = true;
      }
    }
    if (changed && destDict.size === 0) catalog.delete('Dests');
  }

  const names = resolveRef(catalog.get('Names') ?? PDFNull.instance, doc.objects);
  if (names instanceof PDFDict) {
    const destTree = names.get('Dests');
    if (destTree && pruneDestinationTree(doc, destTree, pageRef) === 'empty') {
      names.delete('Dests');
      if (names.size === 0) catalog.delete('Names');
    }
  }

  for (const page of doc.pages) {
    const annots = page.dict.get('Annots');
    const arr = annots instanceof PDFArray
      ? annots
      : annots instanceof PDFRef && doc.objects.get(annots.toKey()) instanceof PDFArray
        ? doc.objects.get(annots.toKey()) as PDFArray
        : null;
    if (!arr) continue;
    const kept = arr.items.filter((item) => {
      const annotation = item instanceof PDFRef ? doc.objects.get(item.toKey()) : item;
      return !(annotation instanceof PDFDict && annotation.getName('Subtype') === 'Link' &&
        (containsDestinationRef(annotation.get('Dest') ?? PDFNull.instance, pageRef, doc.objects) ||
          containsDestinationRef(annotation.get('A') ?? PDFNull.instance, pageRef, doc.objects)));
    });
    if (kept.length === 0) {
      page.dict.delete('Annots');
    } else {
      arr.items.splice(0, arr.items.length, ...kept);
    }
  }
}

/**
 * Delete multiple pages at once (more efficient than calling deletePage repeatedly).
 * Indices should be in ascending order.
 */
export function deletePages(doc: PDFDocumentData, indices: number[]): void {
  const seen = new Set<number>();
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= doc.pages.length || seen.has(index)) {
      throw new Error(`Invalid page index ${index}`);
    }
    seen.add(index);
  }
  if (indices.length >= doc.pages.length && indices.length > 0) throw new Error('Cannot delete the last page');
  if (!indices.length) return;
  // Plan all form removals together before changing any page. Computing one
  // plan per page can overwrite sibling removals on a shared field tree.
  const sorted = [...indices].sort((a, b) => b - a);
  const pages = sorted.map(index => doc.pages[index]);
  validatePageDeletionTrees(doc);
  const applyFormChanges = planDeletedPageFormCleanup(doc, pages);
  for (const page of pages) removeDeletedPageDestinations(doc, page.ref);
  applyFormChanges();
  for (const page of pages) removePageFromTree(page.ref, doc.catalog, doc.objects);
  for (const index of sorted) doc.pages.splice(index, 1);
  for (let i = 0; i < doc.pages.length; i++) {
    doc.pages[i].index = i;
  }
}

// ─── Page reordering ────────────────────────────────────────────────────────

/**
 * Reorder pages according to a new index mapping.
 * @param newOrder Array where newOrder[newIndex] = oldIndex
 */
export function reorderPages(doc: PDFDocumentData, newOrder: number[]): void {
  if (newOrder.length !== doc.pages.length) {
    throw new Error('New order must have same number of pages');
  }

  // Validate all indices are present
  const seen = new Set<number>();
  for (const idx of newOrder) {
    if (idx < 0 || idx >= doc.pages.length || seen.has(idx)) {
      throw new Error(`Invalid page order: ${newOrder.join(', ')}`);
    }
    seen.add(idx);
  }

  // Reorder pages array
  const oldPages = [...doc.pages];
  for (let i = 0; i < newOrder.length; i++) {
    doc.pages[i] = oldPages[newOrder[i]];
    doc.pages[i].index = i;
  }

  // Rebuild the Kids array in the pages root
  rebuildKidsArray(doc);
}

/**
 * Move a page from one position to another.
 */
export function movePage(doc: PDFDocumentData, fromIndex: number, toIndex: number): void {
  if (fromIndex === toIndex) return;
  if (fromIndex < 0 || fromIndex >= doc.pages.length) throw new Error('Invalid from index');
  if (toIndex < 0 || toIndex >= doc.pages.length) throw new Error('Invalid to index');

  const newOrder = Array.from({ length: doc.pages.length }, (_, i) => i);
  const [removed] = newOrder.splice(fromIndex, 1);
  newOrder.splice(toIndex, 0, removed);
  reorderPages(doc, newOrder);
}

// ─── Page rotation ──────────────────────────────────────────────────────────

/**
 * Set the rotation of a page.
 * @param rotation Rotation in degrees (0, 90, 180, 270)
 */
export function rotatePage(doc: PDFDocumentData, pageIndex: number, rotation: number): void {
  if (pageIndex < 0 || pageIndex >= doc.pages.length) {
    throw new Error(`Page index ${pageIndex} out of range`);
  }

  // Normalize rotation
  const normalized = ((rotation % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(normalized)) {
    throw new Error('Rotation must be 0, 90, 180, or 270 degrees');
  }

  const page = doc.pages[pageIndex];
  page.rotate = normalized;
  page.dict.set('Rotate', new PDFNumber(normalized));
}

/**
 * Rotate a page by a relative amount (add to current rotation).
 */
export function rotatePageBy(doc: PDFDocumentData, pageIndex: number, degrees: number): void {
  const currentRotation = doc.pages[pageIndex].rotate;
  rotatePage(doc, pageIndex, currentRotation + degrees);
}

// ─── Page insertion ─────────────────────────────────────────────────────────

/**
 * Insert a blank page at the specified index.
 */
export function insertBlankPage(
  doc: PDFDocumentData,
  atIndex: number,
  size: PDFRectangle = { x: 0, y: 0, width: 612, height: 792 }, // US Letter
): void {
  if (!Number.isInteger(atIndex) || atIndex < 0 || atIndex > doc.pages.length) {
    throw new Error(`Page index ${atIndex} out of range`);
  }
  const nextObj = getNextObjNum(doc);

  // Create page dictionary
  const pageDict = new PDFDict();
  pageDict.set('Type', new PDFName('Page'));
  pageDict.set('MediaBox', new PDFArray([
    new PDFNumber(size.x),
    new PDFNumber(size.y),
    new PDFNumber(size.x + size.width),
    new PDFNumber(size.y + size.height),
  ]));

  // Set parent to root pages node
  const pagesRef = doc.catalog.getRef('Pages');
  if (pagesRef) pageDict.set('Parent', pagesRef);

  // Empty resources
  pageDict.set('Resources', new PDFDict());
  pageDict.set('Rotate', new PDFNumber(0));

  // Empty content stream
  const contentDict = new PDFDict();
  contentDict.set('Length', new PDFNumber(0));
  const contentStream = new PDFStream(contentDict, new Uint8Array(0), new Uint8Array(0));
  const contentRef = new PDFRef(nextObj + 1, 0);
  doc.objects.set(contentRef.toKey(), contentStream);
  pageDict.set('Contents', contentRef);

  // Store page object
  const pageRef = new PDFRef(nextObj, 0);
  doc.objects.set(pageRef.toKey(), pageDict);

  // Add to pages array
  const pageInfo: PDFPageInfo = {
    index: atIndex,
    dict: pageDict,
    mediaBox: size,
    cropBox: size,
    rotate: 0,
    ref: pageRef,
    resources: pageDict.getDict('Resources')!,
    contentRefs: [contentRef],
  };

  doc.pages.splice(atIndex, 0, bindPageContentRefs(pageInfo, doc));

  // Re-index
  for (let i = atIndex; i < doc.pages.length; i++) {
    doc.pages[i].index = i;
  }

  // Rebuild page tree
  rebuildKidsArray(doc);
}

// ─── Page extraction and merging ──────────────────────────────────────────────

/** Do not guess whether the page graph or a stale content cache contains an edit. */
function preparePageContents(doc: PDFDocumentData, pages: PDFPageInfo[]): Map<PDFPageInfo, PDFRef[]> {
  const result = new Map<PDFPageInfo, PDFRef[]>();
  for (const page of pages) {
    if (doc.objects.get(page.ref.toKey()) !== page.dict) {
      throw new Error('Cannot copy a page whose content ownership is ambiguous.');
    }
    let actual: PDFRef[];
    try { actual = inspectContentRefs(page.dict.get('Contents'), doc.objects); }
    catch { throw new Error('Cannot copy page content that cannot be fully inspected.'); }
    if (actual.length !== page.contentRefs.length || actual.some((ref, i) =>
      !(page.contentRefs[i] instanceof PDFRef) || ref.toKey() !== page.contentRefs[i].toKey())) {
      throw new Error('Cannot copy a page whose content cache differs from its document.');
    }
    result.set(page, actual);
  }
  return result;
}

/** Validate popup annotation relationships before copying any page objects. */
function preparePopupParents(doc: PDFDocumentData, pages: PDFPageInfo[]): Set<PDFDict> {
  const fail = (): never => { throw new Error('Cannot safely copy an ambiguous popup annotation relationship.'); };
  const popups = new Set<PDFDict>();
  const popupRefs: PDFRef[] = [];
  const seenPopupRefs = new Set<string>();
  const pageRefs = new Set(doc.pages.map(page => page.ref.toKey()));
  for (const page of pages) {
    const raw = page.dict.get('Annots');
    if (!raw) continue;
    const annots = resolveRef(raw, doc.objects);
    if (!(annots instanceof PDFArray)) return fail();
    const byRef = new Map<string, { ref: PDFRef; dict: PDFDict }>();
    for (const entry of annots.items) {
      const annotation = resolveRef(entry, doc.objects);
      if (!(annotation instanceof PDFDict)) return fail();
      if (entry instanceof PDFRef) {
        if (byRef.has(entry.toKey())) return fail();
        byRef.set(entry.toKey(), { ref: entry, dict: annotation });
      } else if (annotation.getName('Subtype') === 'Popup') return fail();
    }
    const parentRefs = new Set<string>();
    for (const [key, { ref, dict: popup }] of byRef) {
      if (popup.getName('Subtype') !== 'Popup') continue;
      if (seenPopupRefs.has(key) || popups.has(popup)) return fail();
      seenPopupRefs.add(key);
      const parentRef = popup.get('Parent');
      if (!(parentRef instanceof PDFRef) || parentRef.toKey() === key || parentRefs.has(parentRef.toKey())) return fail();
      const parent = byRef.get(parentRef.toKey())?.dict;
      if (!parent || parent === popup || parent.getName('Subtype') === 'Popup') return fail();
      parentRefs.add(parentRef.toKey());
      for (const annotation of [popup, parent]) {
        const pageValue = annotation.get('P');
        if (pageValue !== undefined && (!(pageValue instanceof PDFRef) || !pageValue.equals(page.ref))) return fail();
      }
      const backlink = parent.get('Popup');
      if (backlink !== undefined && (!(backlink instanceof PDFRef) || backlink.toKey() !== key)) return fail();
      popups.add(popup);
      popupRefs.push(ref);
    }
  }

  // Indirect cycles are safe because copying reserves references before
  // descending; direct container cycles would recurse forever after mutation.
  type Frame = { value: PDFObject; active: Set<PDFObject>; depth: number; exit?: boolean };
  const pending: Frame[] = popupRefs.map(value => ({ value, active: new Set(), depth: 0 }));
  const seenRefs = new Set<string>();
  let visits = 0;
  while (pending.length) {
    if (++visits > 100_000 || pending.length > 100_000) return fail();
    const { value, active, depth, exit } = pending.pop()!;
    if (exit) { active.delete(value); continue; }
    if (value instanceof PDFRef) {
      const key = value.toKey();
      if (pageRefs.has(key) || seenRefs.has(key)) continue;
      if (depth > 128) return fail();
      seenRefs.add(key);
      const resolved = doc.objects.get(key);
      if (!resolved) return fail();
      pending.push({ value: resolved, active: new Set(), depth: depth + 1 });
      continue;
    }
    if (!(value instanceof PDFDict || value instanceof PDFArray || value instanceof PDFStream)) continue;
    if (depth > 128 || active.has(value)) return fail();
    active.add(value);
    pending.push({ value, active, depth, exit: true });
    if (value instanceof PDFArray) {
      for (const child of value.items) pending.push({ value: child, active, depth: depth + 1 });
    } else if (value instanceof PDFStream) pending.push({ value: value.dict, active, depth: depth + 1 });
    else for (const [key, child] of value.entries()) {
      if (key !== 'Parent' || popups.has(value)) pending.push({ value: child, active, depth: depth + 1 });
    }
  }
  return popups;
}

/** Reserve field references until the selected-page field tree can be rebuilt. */
function preparePageFieldReferences(doc: PDFDocumentData, pages: PDFPageInfo[], popups: Set<PDFDict>): Set<string> {
  const fail = (): never => { throw new Error('Cannot safely copy page references to an omitted or ambiguous form field.'); };
  const form = doc.catalog.get('AcroForm');
  if (!form) return new Set();
  const acro = resolveRef(form, doc.objects);
  if (!(acro instanceof PDFDict)) return fail();
  const rawFields = acro.get('Fields');
  if (!rawFields) return new Set();
  const roots = resolveRef(rawFields, doc.objects);
  if (!(roots instanceof PDFArray)) return fail();
  const fields = new Set<string>(), fieldRefs = new Map<string, PDFRef>();
  const parents = new Map<string, string>(), fieldObjects = new Set<PDFDict>();
  const nodes: Array<{ ref: PDFObject; parent?: string; depth: number }> = roots.items.map(ref => ({ ref, depth: 0 }));
  while (nodes.length) {
    const { ref, parent, depth } = nodes.pop()!;
    if (!(ref instanceof PDFRef) || depth > 128 || fields.has(ref.toKey()) || fields.size >= 100_000) return fail();
    const key = ref.toKey(), dict = resolveRef(ref, doc.objects);
    if (!(dict instanceof PDFDict) || doc.objects.get(key) !== dict || fieldObjects.has(dict)) return fail();
    fields.add(key);
    fieldRefs.set(key, ref);
    fieldObjects.add(dict);
    if (parent) parents.set(key, parent);
    const rawKids = dict.get('Kids');
    if (rawKids !== undefined) {
      const kids = resolveRef(rawKids, doc.objects);
      if (!(kids instanceof PDFArray)) return fail();
      for (const child of kids.items) nodes.push({ ref: child, parent: key, depth: depth + 1 });
    }
  }
  const relevant = new Set<string>();
  for (const page of pages) {
    const raw = page.dict.get('Annots');
    if (!raw) continue;
    const annots = resolveRef(raw, doc.objects);
    if (!(annots instanceof PDFArray)) return fail();
    for (const entry of annots.items) {
      if (!(entry instanceof PDFRef) || !fields.has(entry.toKey())) continue;
      const widget = resolveRef(entry, doc.objects);
      if (!(widget instanceof PDFDict) || widget.getName('Subtype') !== 'Widget') continue;
      let key: string | undefined = entry.toKey();
      while (key && !relevant.has(key)) { relevant.add(key); key = parents.get(key); }
    }
  }
  const selectedPages = new Set(pages.map(page => page.ref.toKey()));
  const otherPages = new Set(doc.pages.filter(page => !selectedPages.has(page.ref.toKey())).map(page => page.ref.toKey()));
  type Frame = { value: PDFObject; active: Set<PDFObject>; depth: number; field?: boolean; exit?: boolean };
  const pending: Frame[] = [
    ...pages.flatMap(page => [page.ref, page.resources]),
    ...[...relevant].map(key => fieldRefs.get(key)!),
  ].map(value => ({ value, active: new Set<PDFObject>(), depth: 0 }));
  const refs = new Set<string>();
  let visits = 0;
  while (pending.length) {
    if (++visits > 200_000 || pending.length > 200_000) return fail();
    const { value, active, depth, field, exit } = pending.pop()!;
    if (exit) { active.delete(value); continue; }
    if (value instanceof PDFRef) {
      const key = value.toKey();
      if (fields.has(key) && !relevant.has(key)) return fail();
      if (otherPages.has(key)) return fail();
      if (refs.has(key)) continue;
      if (depth > 128) return fail();
      refs.add(key);
      const resolved = doc.objects.get(key);
      if (!resolved) return fail();
      if (resolved instanceof PDFDict && fieldObjects.has(resolved) && !fields.has(key)) return fail();
      pending.push({ value: resolved, active: new Set(), depth: depth + 1, field: fields.has(key) });
      continue;
    }
    if (!(value instanceof PDFDict || value instanceof PDFArray || value instanceof PDFStream)) continue;
    if (value instanceof PDFDict && fieldObjects.has(value) && !field) return fail();
    if (depth > 128 || active.has(value)) return fail();
    active.add(value);
    pending.push({ value, active, depth, field, exit: true });
    if (value instanceof PDFArray) for (const child of value.items) pending.push({ value: child, active, depth: depth + 1 });
    else if (value instanceof PDFStream) pending.push({ value: value.dict, active, depth: depth + 1 });
    else {
      if (pages.length !== doc.pages.length && ['ResetForm', 'SubmitForm'].includes(value.getName('S') ?? '')) {
        const raw = value.get('Fields');
        const actionFields = raw ? resolveRef(raw, doc.objects) : undefined;
        if (raw && !(actionFields instanceof PDFArray)) return fail();
        if (actionFields instanceof PDFArray && actionFields.items.some(item => {
          const resolved = resolveRef(item, doc.objects);
          return resolved instanceof PDFString || resolved instanceof PDFHexString;
        })) return fail();
      }
      for (const [key, child] of value.entries()) {
        if (field && key === 'Kids') {
          const kids = resolveRef(child, doc.objects);
          if (!(kids instanceof PDFArray)) return fail();
          for (const kid of kids.items) if (kid instanceof PDFRef && relevant.has(kid.toKey())) {
            pending.push({ value: kid, active, depth: depth + 1 });
          }
        } else if (key !== 'Parent' || popups.has(value)) {
          pending.push({ value: child, active, depth: depth + 1 });
        }
      }
    }
  }
  return fields;
}

/** Preserve variable-text quadding when a field leaves its source AcroForm.
 * XFA and calculation order cannot currently be copied without changing their
 * document-wide dependencies, so reject them before either document changes. */
function preparePageForm(doc: PDFDocumentData, imported: boolean): Map<PDFDict, PDFNumber> {
  const defaults = new Map<PDFDict, PDFNumber>();
  const value = doc.catalog.get('AcroForm');
  if (!value) return defaults;
  const acro = resolveRef(value, doc.objects);
  if (!(acro instanceof PDFDict)) throw new Error('Cannot safely inspect the AcroForm.');
  if (acro.has('XFA')) throw new Error('Cannot safely copy pages with an XFA form.');
  if (!imported) return defaults;
  if (acro.has('CO')) throw new Error('Cannot safely copy calculated form fields.');
  if (acro.has('A') || acro.has('AA')) throw new Error('Cannot safely copy form actions.');
  const quadding = (value: PDFObject | undefined, fallback: number): number => {
    if (value === undefined) return fallback;
    const resolved = resolveRef(value, doc.objects);
    if (!(resolved instanceof PDFNumber) || !Number.isInteger(resolved.value) || resolved.value < 0 || resolved.value > 2) {
      throw new Error('Cannot safely copy invalid form text alignment.');
    }
    return resolved.value;
  };
  const formDefault = quadding(acro.get('Q'), 0);
  const fieldsValue = acro.get('Fields');
  if (!fieldsValue) return defaults;
  const fields = resolveRef(fieldsValue, doc.objects);
  if (!(fields instanceof PDFArray)) throw new Error('Cannot safely inspect the AcroForm fields.');
  const pending = fields.items.map(field => ({ field, alignment: formDefault, fieldType: '' }));
  const seen = new Set<PDFDict>();
  while (pending.length) {
    const { field, alignment, fieldType } = pending.pop()!;
    if (!(field instanceof PDFRef)) throw new Error('Cannot safely copy direct form field entries.');
    const dict = resolveRef(field, doc.objects);
    if (!(dict instanceof PDFDict) || seen.has(dict) || seen.size >= 100_000) {
      throw new Error('Cannot safely copy an ambiguous form field tree.');
    }
    seen.add(dict);
    if (dict.has('A') || dict.has('AA')) throw new Error('Cannot safely copy form actions.');
    const nextAlignment = quadding(dict.get('Q'), alignment);
    const rawType = dict.get('FT');
    const resolvedType = rawType === undefined ? undefined : resolveRef(rawType, doc.objects);
    if (resolvedType !== undefined && !(resolvedType instanceof PDFName)) throw new Error('Cannot safely inspect a form field type.');
    const nextType = resolvedType instanceof PDFName ? resolvedType.name : fieldType;
    if ((nextType === 'Tx' || nextType === 'Ch') && !dict.has('Q')) defaults.set(dict, new PDFNumber(nextAlignment));
    const rawKids = dict.get('Kids');
    if (rawKids !== undefined) {
      const kids = resolveRef(rawKids, doc.objects);
      if (!(kids instanceof PDFArray)) throw new Error('Cannot safely inspect form field children.');
      for (const child of kids.items) pending.push({ field: child, alignment: nextAlignment, fieldType: nextType });
    }
  }
  return defaults;
}

/**
 * Insert pages from a source document into a target document at a specific index.
 */
export function insertPagesFromDocument(
  target: PDFDocumentData,
  source: PDFDocumentData,
  insertAtIndex: number,
): Array<{ from: string; to: string }> {
  if (!Number.isInteger(insertAtIndex) || insertAtIndex < 0 || insertAtIndex > target.pages.length) {
    throw new Error(`Page index ${insertAtIndex} out of range`);
  }
  // A copied signature's byte ranges belong to the source file and cannot
  // authenticate a different target. Do not carry a misleading signed field.
  if (hasDocumentSignature(source)) {
    throw new Error('Cannot insert a digitally signed PDF because its signatures would be invalid.');
  }
  // The editor's import workflow does not support preserving a source PDF's
  // protection in a different target; reject at the public writer boundary too.
  if (source.decryptedFromEncrypted || source.xref.trailerDict.has('Encrypt')) {
    throw new Error('Cannot insert a password-protected source PDF. Unlock and save a copy first.');
  }
  if (target.xref.trailerDict.has('Encrypt') && !target.decryptedFromEncrypted) {
    throw new Error('Unlock the target PDF before inserting pages.');
  }
  if (target.decryptedFromEncrypted && !target.encryptionFileKey?.length) {
    throw new Error('Cannot insert pages without the target PDF’s authenticated encryption context.');
  }
  const pageContents = preparePageContents(source, source.pages);
  preparePageForm(target, false);
  const quaddingDefaults = preparePageForm(source, true);
  const popupParents = preparePopupParents(source, source.pages);
  const fieldRefs = preparePageFieldReferences(source, source.pages, popupParents);
  const fontRenames = assertFormResourcesCompatible(target, source);
  const { renamedRoots, renamedFields } = prepareDistinctFormRoots(target, source);
  const rewrittenAppearances = prepareAppearanceRewrites(target, source, fontRenames);
  const refMap = new Map<string, PDFRef>(); // old source key → new target ref

  function copyObject(obj: PDFObject): PDFObject {
    if (obj instanceof PDFRef) {
      const oldKey = obj.toKey();
      if (refMap.has(oldKey)) return refMap.get(oldKey)!;

      // Allocate new ref in target
      const newRef = new PDFRef(getNextObjNum(target), 0);
      refMap.set(oldKey, newRef);
      // Temporarily set it in target to reserve the ref and prevent infinite loops on circular refs
      target.objects.set(newRef.toKey(), new PDFDict()); 

      if (fieldRefs.has(oldKey)) return newRef;

      // Copy the referenced object from source
      const resolved = source.objects.get(oldKey);
      if (resolved) {
        target.objects.set(newRef.toKey(), copyObjectDeep(resolved));
      }

      return newRef;
    }
    return copyObjectDeep(obj);
  }

  function copyObjectDeep(obj: PDFObject): PDFObject {
    if (obj instanceof PDFDict) {
      const newDict = new PDFDict();
      const entries = Array.from(obj.entries());
      for (let i = 0; i < entries.length; i++) {
        const [key, value] = entries[i];
        // Skip Parent reference for pages so we can re-parent them to target's Pages tree
        if (key === 'Parent' && !popupParents.has(obj)) continue;
        const rewritten = key === 'DA' ? rewrittenAppearances.get(obj)
          : key === 'T' ? renamedRoots.get(obj) : undefined;
        newDict.set(key, rewritten ?? copyObject(value));
      }
      const quadding = quaddingDefaults.get(obj);
      if (quadding && !newDict.has('Q')) newDict.set('Q', quadding);
      return newDict;
    }

    if (obj instanceof PDFArray) {
      return new PDFArray(obj.items.map((item) => copyObject(item)));
    }

    if (obj instanceof PDFStream) {
      const newStreamDict = copyObjectDeep(obj.dict) as PDFDict;
      return new PDFStream(
        newStreamDict,
        new Uint8Array(obj.rawBytes),
        obj.decodedBytes ? new Uint8Array(obj.decodedBytes) : null,
      );
    }

    if (obj instanceof PDFRef) {
      return copyObject(obj);
    }

    return obj;
  }

  const targetPagesRef = target.catalog.getRef('Pages');
  if (!targetPagesRef) throw new Error('Target document has no Pages root');

  const pagesToInsert: PDFPageInfo[] = [];

  for (let i = 0; i < source.pages.length; i++) {
    const srcPage = source.pages[i];
    if (!srcPage) continue;

    const pageRef = copyObject(srcPage.ref) as PDFRef;

    // Set parent to target pages node
    const pageDictObj = target.objects.get(pageRef.toKey());
    if (pageDictObj instanceof PDFDict) {
      pageDictObj.set('Parent', targetPagesRef);

      const copiedResources = copyObjectDeep(srcPage.resources) as PDFDict;
      pageDictObj.set('Resources', copiedResources);
      pageDictObj.set('MediaBox', new PDFArray([
        new PDFNumber(srcPage.mediaBox.x),
        new PDFNumber(srcPage.mediaBox.y),
        new PDFNumber(srcPage.mediaBox.x + srcPage.mediaBox.width),
        new PDFNumber(srcPage.mediaBox.y + srcPage.mediaBox.height),
      ]));
      pageDictObj.set('CropBox', new PDFArray([
        new PDFNumber(srcPage.cropBox.x),
        new PDFNumber(srcPage.cropBox.y),
        new PDFNumber(srcPage.cropBox.x + srcPage.cropBox.width),
        new PDFNumber(srcPage.cropBox.y + srcPage.cropBox.height),
      ]));
      pageDictObj.set('Rotate', new PDFNumber(srcPage.rotate));

      pagesToInsert.push(bindPageContentRefs({
        index: insertAtIndex + i,
        dict: pageDictObj,
        mediaBox: { ...srcPage.mediaBox },
        cropBox: { ...srcPage.cropBox },
        rotate: srcPage.rotate,
        ref: pageRef,
        resources: copiedResources,
        contentRefs: pageContents.get(srcPage)!.map(ref => copyObject(ref) as PDFRef),
        ...(srcPage.contentInspectionComplete === false ? { contentInspectionComplete: false } : {}),
      }));
    }
  }

  // Insert into target pages array
  target.pages.splice(insertAtIndex, 0, ...pagesToInsert);
  for (const page of pagesToInsert) bindPageContentRefs(page, target);

  // Re-index pages
  for (let i = insertAtIndex; i < target.pages.length; i++) {
    target.pages[i].index = i;
  }

  // Rebuild page tree
  rebuildKidsArray(target);

  mergeInsertedAcroForm(target, source, refMap, source.pages, copyObject,
    () => new PDFRef(getNextObjNum(target), 0), fontRenames, rewrittenAppearances, renamedRoots, quaddingDefaults);
  return renamedFields;
}

/** Rename conflicting imported roots only when name references are unambiguous. */
function prepareDistinctFormRoots(target: PDFDocumentData, source: PDFDocumentData): {
  renamedRoots: Map<PDFDict, PDFString>;
  renamedFields: Array<{ from: string; to: string }>;
} {
  const fail = (): never => { throw new Error('Cannot merge conflicting AcroForm root names safely: field references or actions are ambiguous.'); };
  const getRoots = (doc: PDFDocumentData): { acro?: PDFDict; fields?: PDFArray; roots: Array<{ ref: PDFRef; dict: PDFDict; name: string }> } => {
    const form = doc.catalog.get('AcroForm');
    const acro = form ? resolveRef(form, doc.objects) : undefined;
    if (!form) return { roots: [] };
    if (!(acro instanceof PDFDict)) return fail();
    const fieldsValue = acro.get('Fields');
    if (!fieldsValue) return { acro, roots: [] };
    const fields = resolveRef(fieldsValue, doc.objects);
    if (!(fields instanceof PDFArray)) return fail();
    const roots: Array<{ ref: PDFRef; dict: PDFDict; name: string }> = [];
    for (const item of fields.items) {
      if (!(item instanceof PDFRef)) return fail();
      const dict = resolveRef(item, doc.objects);
      if (!(dict instanceof PDFDict)) return fail();
      const value = dict.get('T');
      const name = value instanceof PDFString ? value.toText()
        : value instanceof PDFHexString && /^[\da-f\s]*$/i.test(value.hex) ? new PDFString(value.toText()).toText() : '';
      if (!name || /[.\x00-\x1f\x7f\ufffd]/.test(name)) return fail();
      roots.push({ ref: item, dict, name });
    }
    return { acro, fields, roots };
  };
  const destination = getRoots(target);
  const incoming = getRoots(source);
  const existing = new Set(destination.roots.map(root => root.name));
  const collisions = incoming.roots.filter(root => existing.has(root.name));
  if (!collisions.length) return { renamedRoots: new Map(), renamedFields: [] };
  if (!incoming.acro || !incoming.fields || incoming.roots.length !== incoming.fields.length ||
      (destination.fields && destination.roots.length !== destination.fields.length) ||
      new Set(destination.roots.map(root => root.name)).size !== destination.roots.length ||
      destination.acro?.has('XFA') ||
      new Set(incoming.roots.map(root => root.name)).size !== incoming.roots.length ||
      incoming.roots.some(root => /[.\x00-\x1f\x7f\ufffd]/.test(root.name))) return fail();
  // Calculations, XFA and custom AcroForm entries may address field names.
  const allowedAcroKeys = new Set(['Fields', 'NeedAppearances', 'SigFlags', 'DR', 'DA', 'Q']);
  if ([...incoming.acro.keys()].some(key => !allowedAcroKeys.has(key))) return fail();

  const rootRefs = new Map(collisions.map(root => [root.ref.toKey(), root]));
  const sensitiveRefs = new Map<string, PDFDict>();
  const allowedParents = new Map<PDFDict, string>();
  const allowedKids = new Map<PDFArray, Set<string>>();
  const fieldTrees = new Set<PDFDict>();
  const pendingFields = incoming.roots.map(root => ({ ref: root.ref, dict: root.dict, affected: rootRefs.has(root.ref.toKey()) }));
  while (pendingFields.length) {
    const { ref, dict, affected } = pendingFields.pop()!;
    if (fieldTrees.has(dict) || fieldTrees.size >= 100_000) return fail();
    fieldTrees.add(dict);
    if (affected) sensitiveRefs.set(ref.toKey(), dict);
    const kidsValue = dict.get('Kids');
    if (!kidsValue) continue;
    const kids = resolveRef(kidsValue, source.objects);
    if (!(kids instanceof PDFArray)) return fail();
    if (affected) allowedKids.set(kids, new Set(kids.items.filter((item): item is PDFRef => item instanceof PDFRef).map(item => item.toKey())));
    for (const item of kids.items) {
      if (!(item instanceof PDFRef)) return fail();
      const child = resolveRef(item, source.objects);
      if (!(child instanceof PDFDict)) return fail();
      const parent = child.get('Parent');
      if (!(parent instanceof PDFRef) || parent.toKey() !== ref.toKey()) return fail();
      allowedParents.set(child, ref.toKey());
      pendingFields.push({ ref: item, dict: child, affected });
    }
  }

  const annotations = new Set<PDFArray>();
  for (const page of source.pages) {
    const value = page.dict.get('Annots');
    if (!value) continue;
    const array = resolveRef(value, source.objects);
    if (!(array instanceof PDFArray)) return fail();
    annotations.add(array);
  }
  const sensitiveDicts = new Set(sensitiveRefs.values());
  for (const [key, value] of source.objects) {
    if (sensitiveDicts.has(value as PDFDict) && sensitiveRefs.get(key) !== value) return fail();
  }
  const seen = new Set<PDFObject>();
  const pending: Array<{ value: PDFObject; owner?: PDFObject; key?: string }> =
    [source.catalog, source.xref.trailerDict, ...source.pages.flatMap(page => [page.dict, page.resources])]
      .map(value => ({ value }));
  const actionTypes = new Set(['GoTo', 'GoToR', 'GoToE', 'Launch', 'Thread', 'URI', 'Sound', 'Movie', 'Hide', 'Named', 'SubmitForm', 'ResetForm', 'ImportData', 'JavaScript', 'SetOCGState', 'Rendition', 'Trans', 'GoTo3DView']);
  while (pending.length) {
    const { value, owner, key } = pending.pop()!;
    if (value instanceof PDFRef) {
      if (!source.objects.has(value.toKey())) return fail();
      const field = sensitiveRefs.get(value.toKey());
      if (field && !(owner === incoming.fields && rootRefs.has(value.toKey())) &&
          !(owner instanceof PDFDict && key === 'Parent' && allowedParents.get(owner) === value.toKey()) &&
          !(owner instanceof PDFArray && allowedKids.get(owner)?.has(value.toKey())) &&
          !(owner instanceof PDFArray && annotations.has(owner) && field.getName('Subtype') === 'Widget')) return fail();
      pending.push({ value: source.objects.get(value.toKey())! });
      continue;
    }
    if (sensitiveDicts.has(value as PDFDict) && owner) return fail();
    if (value instanceof PDFString || value instanceof PDFHexString) {
      if (owner instanceof PDFDict && key === 'T' && fieldTrees.has(owner)) continue;
      const text = value instanceof PDFString ? value.toText() : new PDFString(value.toText()).toText();
      if (collisions.some(root => text === root.name || text.startsWith(`${root.name}.`))) return fail();
      continue;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    if (seen.size > 200_000) return fail();
    if (value instanceof PDFDict) {
      if (['A', 'AA', 'OpenAction', 'JS', 'JavaScript', 'XFA'].some(name => value.has(name)) ||
          value.getName('Type') === 'Action' || actionTypes.has(value.getName('S') ?? '')) return fail();
      for (const [name, child] of value.entries()) pending.push({ value: child, owner: value, key: name });
    } else if (value instanceof PDFArray) {
      for (const child of value.items) pending.push({ value: child, owner: value });
    } else if (value instanceof PDFStream) {
      pending.push({ value: value.dict, owner: value });
    }
  }

  // Existing scripts or actions can also depend on the original field namespace.
  const targetSeen = new Set<PDFObject>();
  const targetPending: PDFObject[] = [target.catalog, target.xref.trailerDict, ...target.pages.flatMap(page => [page.dict, page.resources])];
  while (targetPending.length) {
    const value = targetPending.pop()!;
    if (value instanceof PDFRef) {
      const resolved = target.objects.get(value.toKey());
      if (!resolved) return fail();
      targetPending.push(resolved);
      continue;
    }
    if (targetSeen.has(value)) continue;
    targetSeen.add(value);
    if (targetSeen.size > 200_000) return fail();
    if (value instanceof PDFDict) {
      if (['A', 'AA', 'OpenAction', 'JS', 'JavaScript', 'XFA'].some(name => value.has(name)) ||
          value.getName('Type') === 'Action' || actionTypes.has(value.getName('S') ?? '')) return fail();
      targetPending.push(...value.values());
    } else if (value instanceof PDFArray) targetPending.push(...value.items);
    else if (value instanceof PDFStream) targetPending.push(value.dict);
  }

  const names = new Set([...existing, ...incoming.roots.map(root => root.name)]);
  const result = new Map<PDFDict, PDFString>();
  for (const root of collisions) {
    let index = 2;
    let candidate = `${root.name}_${index}`;
    while (names.has(candidate)) candidate = `${root.name}_${++index}`;
    names.add(candidate);
    result.set(root.dict, PDFString.fromText(candidate));
  }
  const renamedFields: Array<{ from: string; to: string }> = [];
  for (const root of collisions) {
    const replacement = result.get(root.dict)!.toText();
    const stack = [{ dict: root.dict, from: root.name, to: replacement }];
    while (stack.length) {
      const item = stack.pop()!;
      renamedFields.push({ from: item.from, to: item.to });
      const kidsValue = item.dict.get('Kids');
      if (!kidsValue) continue;
      const kids = resolveRef(kidsValue, source.objects);
      if (!(kids instanceof PDFArray)) return fail();
      const siblingNames = new Set<string>();
      for (const childRef of kids.items) {
        if (!(childRef instanceof PDFRef)) return fail();
        const child = resolveRef(childRef, source.objects);
        if (!(child instanceof PDFDict)) return fail();
        const nameValue = child.get('T');
        if (!nameValue) {
          if (child.getName('Subtype') !== 'Widget' || child.has('Kids')) return fail();
          continue;
        }
        const name = nameValue instanceof PDFString ? nameValue.toText()
          : nameValue instanceof PDFHexString && /^[\da-f\s]*$/i.test(nameValue.hex)
            ? new PDFString(nameValue.toText()).toText() : '';
        if (!name || /[.\x00-\x1f\x7f\ufffd]/.test(name) || siblingNames.has(name)) return fail();
        siblingNames.add(name);
        stack.push({ dict: child, from: `${item.from}.${name}`, to: `${item.to}.${name}` });
      }
    }
  }
  return { renamedRoots: result, renamedFields };
}

/** Compare complete resource values across documents without assuming that
 * equal resource names imply equal fonts or appearances. Cyclic, unresolved or
 * unusually complex graphs are not considered safely equivalent. */
function equivalentFormResource(
  left: PDFObject, leftObjects: Map<string, PDFObject>,
  right: PDFObject, rightObjects: Map<string, PDFObject>,
): boolean {
  const activeLeft = new Set<PDFObject>();
  const activeRight = new Set<PDFObject>();
  let visited = 0;
  const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((byte, index) => byte === b[index]);
  function dereference(value: PDFObject, objects: Map<string, PDFObject>): PDFObject | undefined {
    const seen = new Set<string>();
    while (value instanceof PDFRef) {
      if (++visited > 50_000 || seen.size >= 64 || seen.has(value.toKey())) return undefined;
      seen.add(value.toKey());
      const resolved = objects.get(value.toKey());
      if (!resolved) return undefined;
      value = resolved;
    }
    return value;
  }
  function compare(leftValue: PDFObject, rightValue: PDFObject, depth: number): boolean {
    const a = dereference(leftValue, leftObjects);
    const b = dereference(rightValue, rightObjects);
    if (!a || !b || ++visited > 50_000 || depth > 64 || activeLeft.has(a) || activeRight.has(b)) return false;
    activeLeft.add(a);
    activeRight.add(b);
    try {
      if (a instanceof PDFNull || b instanceof PDFNull) return a instanceof PDFNull && b instanceof PDFNull;
      if (a instanceof PDFName && b instanceof PDFName) return a.name === b.name;
      if (a instanceof PDFNumber && b instanceof PDFNumber) return Number.isFinite(a.value) && a.value === b.value;
      if (a instanceof PDFBoolean && b instanceof PDFBoolean) return a.value === b.value;
      if (a instanceof PDFString && b instanceof PDFString) return sameBytes(a.toBytes(), b.toBytes());
      if (a instanceof PDFHexString && b instanceof PDFHexString) {
        return /^[\da-f\s]*$/i.test(a.hex) && /^[\da-f\s]*$/i.test(b.hex) && sameBytes(a.toBytes(), b.toBytes());
      }
      if (a instanceof PDFArray && b instanceof PDFArray) {
        return a.length === b.length && a.items.every((value, index) => compare(value, b.items[index], depth + 1));
      }
      if (a instanceof PDFDict && b instanceof PDFDict) {
        if (a.size !== b.size) return false;
        for (const [key, value] of a.entries()) {
          const other = b.get(key);
          if (!other || !compare(value, other, depth + 1)) return false;
        }
        return true;
      }
      if (a instanceof PDFStream && b instanceof PDFStream) {
        return sameBytes(a.rawBytes, b.rawBytes) && compare(a.dict, b.dict, depth + 1);
      }
      return false;
    } finally {
      activeLeft.delete(a);
      activeRight.delete(b);
    }
  }
  return compare(left, right, 0);
}

/** Different resources under the same name require rewriting appearances. */
function assertFormResourcesCompatible(target: PDFDocumentData, source: PDFDocumentData): Map<string, string> {
  const fontRenames = new Map<string, string>();
  const resourceDict = (doc: PDFDocumentData): PDFDict | undefined => {
    const form = doc.catalog.get('AcroForm');
    const acro = form ? resolveRef(form, doc.objects) : undefined;
    if (!(acro instanceof PDFDict)) return undefined;
    const resources = acro.get('DR');
    if (!resources) return undefined;
    const resolved = resolveRef(resources, doc.objects);
    if (!(resolved instanceof PDFDict)) throw new Error('Cannot merge invalid AcroForm default resources.');
    return resolved;
  };
  const sourceResources = resourceDict(source);
  const targetResources = resourceDict(target);
  if (!sourceResources || !targetResources) return fontRenames;
  for (const [category, sourceValue] of sourceResources.entries()) {
    const targetValue = targetResources.get(category);
    if (!targetValue) continue;
    const sourceEntries = resolveRef(sourceValue, source.objects);
    const targetEntries = resolveRef(targetValue, target.objects);
    if (!(sourceEntries instanceof PDFDict) || !(targetEntries instanceof PDFDict)) {
      throw new Error(`Cannot merge AcroForm resource category ${category} safely.`);
    }
    for (const key of sourceEntries.keys()) {
      const existing = targetEntries.get(key);
      const incoming = sourceEntries.get(key)!;
      if (existing && !equivalentFormResource(existing, target.objects, incoming, source.objects)) {
        if (category !== 'Font') throw new Error(`Cannot merge conflicting AcroForm resource ${category}/${key} safely.`);
        // Missing and cyclic entries cannot be safely renamed into a usable resource.
        let resourcesAreDictionaries = false;
        try {
          resourcesAreDictionaries = resolveRef(existing, target.objects) instanceof PDFDict &&
            resolveRef(incoming, source.objects) instanceof PDFDict;
        } catch { /* A cyclic resource is not safe to rename. */ }
        if (!resourcesAreDictionaries) {
          throw new Error(`Cannot merge conflicting AcroForm resource ${category}/${key} safely.`);
        }
        let suffix = 1;
        let replacement = `PaperloomMergedFont${suffix}`;
        while (sourceEntries.has(replacement) || targetEntries.has(replacement) || [...fontRenames.values()].includes(replacement)) {
          replacement = `PaperloomMergedFont${++suffix}`;
        }
        fontRenames.set(key, replacement);
      }
    }
  }
  return fontRenames;
}

/** Validate and rewrite source default appearances before the target changes.
 * Only a bounded, unambiguous text-state subset is supported; unknown syntax
 * and appearance streams that rely on external resources fail closed. */
function prepareAppearanceRewrites(
  target: PDFDocumentData,
  source: PDFDocumentData,
  fontRenames: Map<string, string>,
): Map<PDFDict, PDFObject> {
  const rewritten = new Map<PDFDict, PDFObject>();
  if (!fontRenames.size) return rewritten;
  const fail = (): never => { throw new Error('Cannot merge conflicting AcroForm resource Font safely: unsupported default appearance or widget resources.'); };
  const getDict = (doc: PDFDocumentData, obj: PDFObject | undefined): PDFDict | undefined => {
    if (!obj) return undefined;
    const value = resolveRef(obj, doc.objects);
    return value instanceof PDFDict ? value : undefined;
  };
  const acro = getDict(source, source.catalog.get('AcroForm'));
  const targetAcro = getDict(target, target.catalog.get('AcroForm'));
  if (!acro || !acro.has('DA') || !targetAcro) return fail();

  const rewrite = (value: PDFObject): PDFObject => {
    const raw = resolveRef(value, source.objects);
    if (!(raw instanceof PDFString || raw instanceof PDFHexString)) return fail();
    if (raw instanceof PDFHexString && !/^[\da-f\s]*$/i.test(raw.hex)) return fail();
    const bytes = raw.toBytes();
    if (bytes.length > 8192 || bytes.some(byte => byte > 127)) return fail();
    const lexer = new PDFLexer(bytes);
    type Operand = { kind: 'name' | 'number'; value: string | number; start: number; end: number };
    const operands: Operand[] = [];
    const substitutions: Array<{ start: number; end: number; name: string }> = [];
    const numericOperators: Record<string, number> = {
      g: 1, G: 1, rg: 3, RG: 3, k: 4, K: 4,
      Tc: 1, Tw: 1, Tz: 1, TL: 1, Tr: 1, Ts: 1,
      w: 1, J: 1, j: 1, M: 1, i: 1, cm: 6, q: 0, Q: 0,
    };
    while (!lexer.isEOF) {
      const previous = lexer.position;
      const token = lexer.nextToken();
      if (!token || token.type === TokenType.EOF) break;
      if (lexer.position <= previous) return fail();
      if (token.type === TokenType.Name) {
        operands.push({ kind: 'name', value: String(token.value), start: token.offset, end: lexer.position });
      } else if (token.type === TokenType.Integer || token.type === TokenType.Real) {
        if (typeof token.value !== 'number' || !Number.isFinite(token.value)) return fail();
        operands.push({ kind: 'number', value: token.value, start: token.offset, end: lexer.position });
      } else if (token.type === TokenType.Keyword) {
        const op = String(token.value);
        if (op === 'Tf') {
          if (operands.length !== 2 || operands[0].kind !== 'name' || operands[1].kind !== 'number') return fail();
          const name = fontRenames.get(String(operands[0].value));
          if (name) substitutions.push({ start: operands[0].start, end: operands[0].end, name });
        } else {
          const count = numericOperators[op];
          if (count === undefined || operands.length !== count || operands.some(operand => operand.kind !== 'number')) return fail();
        }
        operands.length = 0;
      } else return fail();
      if (operands.length > 16) return fail();
    }
    if (operands.length) return fail();
    let text = '';
    let offset = 0;
    for (const substitution of substitutions) {
      for (; offset < substitution.start; offset++) text += String.fromCharCode(bytes[offset]);
      text += `/${substitution.name}`;
      offset = substitution.end;
    }
    for (; offset < bytes.length; offset++) text += String.fromCharCode(bytes[offset]);
    return new PDFString(text);
  };

  const checkAppearance = (value: PDFObject, active = new Set<PDFObject>(), depth = 0): void => {
    const resolved = resolveRef(value, source.objects);
    if (!resolved || depth > 64 || active.has(resolved)) return fail();
    active.add(resolved);
    try {
      if (resolved instanceof PDFStream) {
        const resources = resolved.dict.get('Resources');
        if (!resources || !(resolveRef(resources, source.objects) instanceof PDFDict)) return fail();
      } else if (resolved instanceof PDFDict) {
        for (const item of resolved.values()) checkAppearance(item, active, depth + 1);
      } else return fail();
    } finally { active.delete(resolved); }
  };
  const seen = new Set<PDFDict>();
  const pending: PDFObject[] = [];
  const fields = acro.get('Fields');
  const roots = fields && resolveRef(fields, source.objects);
  if (!(roots instanceof PDFArray)) return fail();
  if (roots.items.some(item => !(item instanceof PDFRef))) return fail();
  pending.push(...roots.items);
  for (const page of source.pages) {
    const value = page.dict.get('Annots');
    if (!value) continue;
    const annots = resolveRef(value, source.objects);
    if (!(annots instanceof PDFArray)) return fail();
    for (const item of annots.items) {
      const annot = resolveRef(item, source.objects);
      if (!(annot instanceof PDFDict)) return fail();
      if (annot.getName('Subtype') === 'Widget') {
        if (!(item instanceof PDFRef)) return fail();
        pending.push(item);
      }
    }
  }
  rewritten.set(acro, rewrite(acro.get('DA')!));
  while (pending.length) {
    if (seen.size >= 50_000) return fail();
    const value = resolveRef(pending.pop()!, source.objects);
    if (!(value instanceof PDFDict)) return fail();
    if (seen.has(value)) continue;
    seen.add(value);
    const da = value.get('DA');
    if (da) rewritten.set(value, rewrite(da));
    const ap = value.get('AP');
    if (ap) checkAppearance(ap);
    const kids = value.get('Kids');
    if (kids) {
      const children = resolveRef(kids, source.objects);
      if (!(children instanceof PDFArray) || children.items.some(item => !(item instanceof PDFRef))) return fail();
      pending.push(...children.items);
    }
  }
  return rewritten;
}

/** Copy only AcroForm fields that have widgets on the pages being inserted. */
function mergeInsertedAcroForm(
  target: PDFDocumentData,
  source: PDFDocumentData,
  refMap: Map<string, PDFRef>,
  sourcePages: PDFPageInfo[],
  copyObject: (value: PDFObject) => PDFObject,
  allocateRef: () => PDFRef,
  fontRenames: Map<string, string> = new Map(),
  rewrittenAppearances: Map<PDFDict, PDFObject> = new Map(),
  renamedRoots: Map<PDFDict, PDFString> = new Map(),
  quaddingDefaults: Map<PDFDict, PDFNumber> = new Map(),
): void {
  const sourceAcroValue = source.catalog.get('AcroForm');
  const sourceAcro = sourceAcroValue instanceof PDFRef
    ? source.objects.get(sourceAcroValue.toKey())
    : sourceAcroValue;
  if (!(sourceAcro instanceof PDFDict)) return;

  const insertedWidgets = new Set<string>();
  for (const page of sourcePages) {
    const annots = page.dict.get('Annots');
    const annotItems = annots instanceof PDFArray
      ? annots.items
      : annots instanceof PDFRef && source.objects.get(annots.toKey()) instanceof PDFArray
        ? (source.objects.get(annots.toKey()) as PDFArray).items
        : [];
    for (const annot of annotItems) {
      const ref = annot instanceof PDFRef ? annot : undefined;
      const value = ref ? source.objects.get(ref.toKey()) : annot;
      if (value instanceof PDFDict && value.getName('Subtype') === 'Widget' && ref) {
        insertedWidgets.add(ref.toKey());
      }
    }
  }
  if (!insertedWidgets.size) return;

  const relevantFields = new Set<string>();
  const rootValue = sourceAcro.get('Fields');
  const fieldRoots = rootValue instanceof PDFRef ? source.objects.get(rootValue.toKey()) : rootValue;
  const visiting = new Set<PDFDict>();
  const markField = (value: PDFObject): boolean => {
    const ref = value instanceof PDFRef ? value : undefined;
    const field = ref ? source.objects.get(ref.toKey()) : value;
    if (!(field instanceof PDFDict)) return false;
    if (visiting.has(field)) return false;
    visiting.add(field);
    const widget = ref && insertedWidgets.has(ref.toKey());
    const kidsValue = field.get('Kids');
    const kids = kidsValue instanceof PDFRef ? source.objects.get(kidsValue.toKey()) : kidsValue;
    let hasRelevantChild = false;
    if (kids instanceof PDFArray) {
      for (const kid of kids.items) if (markField(kid)) hasRelevantChild = true;
    }
    if (ref && (widget || hasRelevantChild)) relevantFields.add(ref.toKey());
    visiting.delete(field);
    return !!widget || hasRelevantChild;
  };
  if (!(fieldRoots instanceof PDFArray)) return;
  fieldRoots.items.forEach(markField);

  const clonedFields = new Set<string>();
  const cloneField = (sourceRef: PDFRef): PDFRef => {
    const existing = refMap.get(sourceRef.toKey());
    if (existing && clonedFields.has(sourceRef.toKey())) return existing;
    const newRef = existing ?? allocateRef();
    refMap.set(sourceRef.toKey(), newRef);
    clonedFields.add(sourceRef.toKey());
    const sourceField = source.objects.get(sourceRef.toKey());
    if (!(sourceField instanceof PDFDict)) return newRef;
    const cloned = new PDFDict();
    target.objects.set(newRef.toKey(), cloned);
    for (const [key, value] of sourceField.entries()) {
      if (key === 'Parent') continue;
      const kids = key === 'Kids' && value instanceof PDFRef ? source.objects.get(value.toKey()) : value;
      if (key === 'Kids' && kids instanceof PDFArray) {
        cloned.set('Kids', new PDFArray(kids.items
          // Keep direct widgets as well as nested fields marked by the walk
          // above. Direct widgets are the common AcroForm shape and must stay
          // reachable even when their parent field is cloned after page copy.
          .filter((kid) => kid instanceof PDFRef &&
            (insertedWidgets.has(kid.toKey()) || relevantFields.has(kid.toKey())))
          .map((kid) => cloneField(kid as PDFRef))));
      } else {
        const rewritten = key === 'DA' ? rewrittenAppearances.get(sourceField)
          : key === 'T' ? renamedRoots.get(sourceField) : undefined;
        cloned.set(key, rewritten ?? copyObject(value));
      }
    }
    const quadding = quaddingDefaults.get(sourceField);
    if (quadding && !cloned.has('Q')) cloned.set('Q', quadding);
    const kids = cloned.get('Kids');
    if (kids instanceof PDFArray) {
      for (const kid of kids.items) {
        const child = kid instanceof PDFRef ? target.objects.get(kid.toKey()) : undefined;
        if (child instanceof PDFDict) child.set('Parent', newRef);
      }
    }
    return newRef;
  };

  const acroValue = target.catalog.get('AcroForm');
  const targetAcro = acroValue instanceof PDFRef
    ? target.objects.get(acroValue.toKey())
    : acroValue;
  const acro = targetAcro instanceof PDFDict ? targetAcro : new PDFDict();
  if (!(targetAcro instanceof PDFDict)) target.catalog.set('AcroForm', acro);
  const targetFieldsValue = acro.get('Fields');
  const resolvedTargetFields = targetFieldsValue instanceof PDFRef ? target.objects.get(targetFieldsValue.toKey()) : targetFieldsValue;
  const targetFields = resolvedTargetFields instanceof PDFArray ? resolvedTargetFields : new PDFArray();
  if (!(resolvedTargetFields instanceof PDFArray)) acro.set('Fields', targetFields);
  for (const root of fieldRoots.items) {
    if (!(root instanceof PDFRef) || !relevantFields.has(root.toKey())) continue;
    const copiedRef = cloneField(root);
    const copiedField = target.objects.get(copiedRef.toKey());
    // A different destination AcroForm default must not change the source
    // field's inherited default appearance.
    if (copiedField instanceof PDFDict && !copiedField.has('DA') && sourceAcro.has('DA')) {
      copiedField.set('DA', rewrittenAppearances.get(sourceAcro) ?? copyObject(sourceAcro.get('DA')!));
    }
    targetFields.push(copiedRef);
  }
  if (!acro.has('DA') && sourceAcro.has('DA')) acro.set('DA', rewrittenAppearances.get(sourceAcro) ?? copyObject(sourceAcro.get('DA')!));
  if (sourceAcro.getBool('NeedAppearances') === true) {
    acro.set('NeedAppearances', copyObject(sourceAcro.get('NeedAppearances')!));
  } else if (!acro.has('NeedAppearances') && sourceAcro.has('NeedAppearances')) {
    acro.set('NeedAppearances', copyObject(sourceAcro.get('NeedAppearances')!));
  }
  const sourceDRValue = sourceAcro.get('DR');
  const targetDRValue = acro.get('DR');
  if (sourceDRValue && !targetDRValue) {
    acro.set('DR', copyObject(sourceDRValue));
  } else if (sourceDRValue && targetDRValue) {
    const sourceDR = resolveRef(sourceDRValue, source.objects) as PDFDict;
    const targetDR = resolveRef(targetDRValue, target.objects) as PDFDict;
    for (const [category, value] of sourceDR.entries()) {
      const existing = targetDR.get(category);
      if (!existing) {
        targetDR.set(category, copyObject(value));
        continue;
      }
      const sourceEntries = resolveRef(value, source.objects) as PDFDict;
      const targetEntries = resolveRef(existing, target.objects) as PDFDict;
      for (const [name, entry] of sourceEntries.entries()) {
        const destination = category === 'Font' ? fontRenames.get(name) ?? name : name;
        // Existing entries passed the equivalence check and stay untouched.
        if (!targetEntries.has(destination)) targetEntries.set(destination, copyObject(entry));
      }
    }
  }
}


/**
 * Extract specific pages into a new document data structure.
 * The extracted document can be serialized independently.
 */
export function extractPages(
  doc: PDFDocumentData,
  pageIndices: number[],
): PDFDocumentData {
  if (hasDocumentSignature(doc)) throw new Error('Splitting a digitally signed PDF would invalidate its signatures.');
  if (doc.decryptedFromEncrypted || doc.xref.trailerDict.has('Encrypt')) {
    throw new Error('Use the protected document extraction workflow to preserve encryption.');
  }
  if (!pageIndices.length || pageIndices.some(index => !Number.isInteger(index) || index < 0 || index >= doc.pages.length)) {
    throw new Error('Select at least one valid page to extract.');
  }
  if (new Set(pageIndices).size !== pageIndices.length) throw new Error('Duplicate page indices cannot be extracted.');
  const pageContents = preparePageContents(doc, pageIndices.map(index => doc.pages[index]));
  const quaddingDefaults = preparePageForm(doc, true);
  const popupParents = preparePopupParents(doc, pageIndices.map(index => doc.pages[index]));
  const fieldRefs = preparePageFieldReferences(doc, pageIndices.map(index => doc.pages[index]), popupParents);
  const selectedPageKeys = new Set(pageIndices.map(index => doc.pages[index].ref.toKey()));
  const selectedPageDicts = new Set(pageIndices.map(index => doc.pages[index].dict));
  const omittedPageKeys = new Set(doc.pages.filter(page => !selectedPageKeys.has(page.ref.toKey())).map(page => page.ref.toKey()));
  const newObjects = new Map<string, PDFObject>();
  const newPages: PDFPageInfo[] = [];
  let nextObj = 1;

  // Copy referenced objects recursively
  const refMap = new Map<string, PDFRef>(); // old key → new ref

  function copyObject(obj: PDFObject): PDFObject {
    if (obj instanceof PDFRef) {
      const oldKey = obj.toKey();
      if (omittedPageKeys.has(oldKey)) {
        throw new Error('A selected page references a page outside the extraction. Remove or update the reference before splitting.');
      }
      if (refMap.has(oldKey)) return refMap.get(oldKey)!;

      // Allocate new ref
      const newRef = new PDFRef(nextObj++, 0);
      refMap.set(oldKey, newRef);

      if (fieldRefs.has(oldKey)) return newRef;

      // Copy the referenced object
      const resolved = doc.objects.get(oldKey);
      if (resolved) {
        newObjects.set(newRef.toKey(), copyObjectDeep(resolved));
      }

      return newRef;
    }
    return copyObjectDeep(obj);
  }

  function copyObjectDeep(obj: PDFObject): PDFObject {
    if (obj instanceof PDFDict) {
      if (obj.getName('Type') === 'Page' && !selectedPageDicts.has(obj)) {
        throw new Error('A selected page references a page outside the extraction. Remove or update the reference before splitting.');
      }
      const newDict = new PDFDict();
      const entries = Array.from(obj.entries());
      for (let i = 0; i < entries.length; i++) {
        const [key, value] = entries[i];
        // Skip Parent reference to avoid circular refs
        if (key === 'Parent' && !popupParents.has(obj)) continue;
        newDict.set(key, copyObject(value));
      }
      const quadding = quaddingDefaults.get(obj);
      if (quadding && !newDict.has('Q')) newDict.set('Q', quadding);
      return newDict;
    }

    if (obj instanceof PDFArray) {
      return new PDFArray(obj.items.map((item) => copyObject(item)));
    }

    if (obj instanceof PDFStream) {
      const newStreamDict = copyObjectDeep(obj.dict) as PDFDict;
      return new PDFStream(
        newStreamDict,
        new Uint8Array(obj.rawBytes),
        obj.decodedBytes ? new Uint8Array(obj.decodedBytes) : null,
      );
    }

    if (obj instanceof PDFRef) {
      return copyObject(obj);
    }

    return obj;
  }

  // Create root pages node
  const pagesRef = new PDFRef(nextObj++, 0);
  const pagesDict = new PDFDict();
  pagesDict.set('Type', new PDFName('Pages'));

  // Copy selected pages
  const kidsRefs: PDFRef[] = [];

  for (let i = 0; i < pageIndices.length; i++) {
    const srcPage = doc.pages[pageIndices[i]];
    if (!srcPage) continue;

    const pageRef = copyObject(srcPage.ref) as PDFRef;
    kidsRefs.push(pageRef);

    // Set parent to new pages node
    const pageDictObj = newObjects.get(pageRef.toKey());
    if (pageDictObj instanceof PDFDict) {
      pageDictObj.set('Parent', pagesRef);

      const copiedResources = copyObjectDeep(srcPage.resources) as PDFDict;
      pageDictObj.set('Resources', copiedResources);
      pageDictObj.set('MediaBox', new PDFArray([
        new PDFNumber(srcPage.mediaBox.x),
        new PDFNumber(srcPage.mediaBox.y),
        new PDFNumber(srcPage.mediaBox.x + srcPage.mediaBox.width),
        new PDFNumber(srcPage.mediaBox.y + srcPage.mediaBox.height),
      ]));
      pageDictObj.set('CropBox', new PDFArray([
        new PDFNumber(srcPage.cropBox.x),
        new PDFNumber(srcPage.cropBox.y),
        new PDFNumber(srcPage.cropBox.x + srcPage.cropBox.width),
        new PDFNumber(srcPage.cropBox.y + srcPage.cropBox.height),
      ]));
      pageDictObj.set('Rotate', new PDFNumber(srcPage.rotate));

      newPages.push(bindPageContentRefs({
        index: i,
        dict: pageDictObj,
        mediaBox: { ...srcPage.mediaBox },
        cropBox: { ...srcPage.cropBox },
        rotate: srcPage.rotate,
        ref: pageRef,
        resources: copiedResources,
        contentRefs: pageContents.get(srcPage)!.map(ref => copyObject(ref) as PDFRef),
        ...(srcPage.contentInspectionComplete === false ? { contentInspectionComplete: false } : {}),
      }));
    }
  }

  pagesDict.set('Kids', new PDFArray(kidsRefs));
  pagesDict.set('Count', new PDFNumber(kidsRefs.length));
  newObjects.set(pagesRef.toKey(), pagesDict);

  // Create catalog
  const catalogRef = new PDFRef(nextObj++, 0);
  const catalogDict = new PDFDict();
  catalogDict.set('Type', new PDFName('Catalog'));
  catalogDict.set('Pages', pagesRef);
  newObjects.set(catalogRef.toKey(), catalogDict);

  // Build xref
  const trailerDict = new PDFDict();
  trailerDict.set('Size', new PDFNumber(nextObj));
  trailerDict.set('Root', catalogRef);

  const extracted: PDFDocumentData = {
    version: doc.version,
    objects: newObjects,
    xref: { entries: new Map(), trailerDict },
    catalog: catalogDict,
    pages: newPages,
    info: { ...doc.info },
    rawBytes: new Uint8Array(0),
  };
  for (const page of newPages) bindPageContentRefs(page, extracted);
  const selectedPages = pageIndices.map(index => doc.pages[index]).filter((page): page is PDFPageInfo => !!page);
  mergeInsertedAcroForm(extracted, doc, refMap, selectedPages, copyObject, () => new PDFRef(nextObj++, 0),
    undefined, undefined, undefined, quaddingDefaults);
  trailerDict.set('Size', new PDFNumber(nextObj));
  return extracted;
}

// ─── Page tree helpers ──────────────────────────────────────────────────────

function removePageFromTree(
  pageRef: PDFRef,
  catalog: PDFDict,
  objects: Map<string, PDFObject>,
): void {
  const pagesRef = catalog.getRef('Pages');
  if (!pagesRef) return;

  const pagesObj = resolveRef(pagesRef, objects);
  if (!(pagesObj instanceof PDFDict)) return;

  const visited = new Set<PDFDict>();
  function removeFromNode(node: PDFDict): boolean {
    if (visited.has(node)) return false;
    visited.add(node);
    const kidsObj = node.get('Kids');
    const kids = kidsObj ? resolveRef(kidsObj, objects) : undefined;
    if (!(kids instanceof PDFArray)) return false;

    for (let i = 0; i < kids.items.length; i++) {
      const kid = kids.items[i];
      if (kid instanceof PDFRef && kid.equals(pageRef)) {
        kids.items.splice(i, 1);
      } else {
        const child = resolveRef(kid, objects);
        if (!(child instanceof PDFDict) || child.getName('Type') !== 'Pages' || !removeFromNode(child)) {
          continue;
        }
        const childKidsObj = child.get('Kids');
        const childKids = childKidsObj ? resolveRef(childKidsObj, objects) : undefined;
        if (childKids instanceof PDFArray && childKids.items.length === 0) {
          kids.items.splice(i, 1);
        }
      }
      const count = node.get('Count');
      const resolvedCount = count ? resolveRef(count, objects) : undefined;
      const nextCount = new PDFNumber((resolvedCount instanceof PDFNumber ? resolvedCount.value : 0) - 1);
      if (count instanceof PDFRef) objects.set(count.toKey(), nextCount);
      else node.set('Count', nextCount);
      return true;
    }
    return false;
  }

  removeFromNode(pagesObj);
}

function rebuildKidsArray(doc: PDFDocumentData): void {
  const pagesRef = doc.catalog.getRef('Pages');
  if (!pagesRef) return;

  const pagesObj = resolveRef(pagesRef, doc.objects);
  if (!(pagesObj instanceof PDFDict)) return;

  // Flattening changes inheritance. Materialize each leaf's effective values
  // before reparenting, including an explicit zero rotation under a rotated root.
  for (const page of doc.pages) {
    if (!page.dict.has('Resources')) page.dict.set('Resources', page.resources);
    if (!page.dict.has('MediaBox')) page.dict.set('MediaBox', rectangleArray(page.mediaBox));
    if (!page.dict.has('CropBox')) page.dict.set('CropBox', rectangleArray(page.cropBox));
    if (!page.dict.has('Rotate')) page.dict.set('Rotate', new PDFNumber(page.rotate));
    page.dict.set('Parent', pagesRef);
  }
  const newKids = new PDFArray(doc.pages.map((p) => p.ref));
  const kids = pagesObj.get('Kids');
  if (kids instanceof PDFRef) doc.objects.set(kids.toKey(), newKids);
  else pagesObj.set('Kids', newKids);
  const count = pagesObj.get('Count');
  const newCount = new PDFNumber(doc.pages.length);
  if (count instanceof PDFRef) doc.objects.set(count.toKey(), newCount);
  else pagesObj.set('Count', newCount);
}


function rectangleArray(rect: PDFRectangle): PDFArray {
  return new PDFArray([
    rect.x, rect.y, rect.x + rect.width, rect.y + rect.height,
  ].map(value => new PDFNumber(value)));
}
