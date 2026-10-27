/**
 * Sanitization Engine — Phase 11.
 * Removes metadata, JS, attachments, comments, unused objects, optional annots.
 */

import {
  PDFArray,
  PDFDict,
  PDFRef,
  type PDFDocumentData,
} from '../../types';
import { resolveRef } from '../../parser/parser';
import { garbageCollect } from '../../optimize/garbage-collect';
import { metadataEngine } from '../metadata/metadata-engine';
import { javaScriptSecurityEngine } from '../javascript/javascript-engine';
import { embeddedFileSecurityEngine } from '../embedded-files/embedded-file-engine';
import type { ISanitizationEngine } from '../types';

export interface SanitizeOptions {
  metadata?: boolean;
  javascript?: boolean;
  embeddedFiles?: boolean;
  comments?: boolean;
  annotations?: boolean;
  unusedObjects?: boolean;
  hiddenLayers?: boolean;
  alternativeImages?: boolean;
}

export interface SanitizeReport {
  actions: string[];
  metadataRemoved: boolean;
  javascriptRemoved: number;
  attachmentsRemoved: number;
  commentsRemoved: number;
  annotationsRemoved: number;
  unusedObjectsRemoved: number;
  layersRemoved: number;
}

export class SanitizationEngine implements ISanitizationEngine {
  async sanitize(
    doc: PDFDocumentData,
    options: SanitizeOptions = {},
  ): Promise<{ doc: PDFDocumentData; report: string[]; detail: SanitizeReport }> {
    const opts: Required<SanitizeOptions> = {
      metadata: options.metadata !== false,
      javascript: options.javascript !== false,
      embeddedFiles: options.embeddedFiles !== false,
      comments: options.comments !== false,
      annotations: options.annotations === true,
      unusedObjects: options.unusedObjects !== false,
      hiddenLayers: options.hiddenLayers !== false,
      alternativeImages: options.alternativeImages !== false,
    };

    const actions: string[] = [];
    const detail: SanitizeReport = {
      actions,
      metadataRemoved: false,
      javascriptRemoved: 0,
      attachmentsRemoved: 0,
      commentsRemoved: 0,
      annotationsRemoved: 0,
      unusedObjectsRemoved: 0,
      layersRemoved: 0,
    };

    if (opts.metadata) {
      metadataEngine.stripMetadata(doc, { stripInfo: true, stripXmp: true, stripCustom: true });
      detail.metadataRemoved = true;
      actions.push('Removed Info dictionary and XMP metadata');
    }

    if (opts.javascript) {
      const js = javaScriptSecurityEngine.disableActions(doc, [
        'JavaScript', 'Launch', 'SubmitForm', 'ImportData', 'ResetForm', 'OpenAction',
      ]);
      detail.javascriptRemoved = js.removed;
      if (js.removed > 0) actions.push(`Removed ${js.removed} risky action(s)`);
    }

    if (opts.embeddedFiles) {
      const n = embeddedFileSecurityEngine.removeAllAttachments(doc);
      detail.attachmentsRemoved = n;
      if (n > 0) actions.push(`Removed ${n} embedded attachment(s)`);
    }

    if (opts.comments || opts.annotations) {
      const r = removePageAnnots(doc, {
        commentsOnly: opts.comments && !opts.annotations,
        all: opts.annotations,
      });
      detail.commentsRemoved = r.comments;
      detail.annotationsRemoved = r.annots;
      if (r.comments > 0) actions.push(`Removed ${r.comments} comment annotation(s)`);
      if (r.annots > 0) actions.push(`Removed ${r.annots} annotation(s)`);
    }

    if (opts.hiddenLayers) {
      const n = removeOptionalContent(doc);
      detail.layersRemoved = n;
      if (n > 0) actions.push(`Removed ${n} optional content / hidden layer reference(s)`);
    }

    if (opts.alternativeImages) {
      const n = stripAlternativeImages(doc);
      if (n > 0) actions.push(`Removed ${n} alternative image reference(s)`);
    }

    if (opts.unusedObjects) {
      try {
        const rootRef = doc.xref.trailerDict.getRef('Root');
        const infoRef = doc.xref.trailerDict.getRef('Info');
        const encryptRef = doc.xref.trailerDict.getRef('Encrypt');
        const roots: PDFRef[] = [];
        if (rootRef) roots.push(rootRef);
        if (infoRef) roots.push(infoRef);
        if (encryptRef) roots.push(encryptRef);
        const gc = garbageCollect(doc.objects, roots, { deduplicateStreams: false });
        // Apply cleaned map
        doc.objects.clear();
        for (const [k, v] of gc.objects) doc.objects.set(k, v);
        detail.unusedObjectsRemoved = gc.removedKeys.length;
        if (detail.unusedObjectsRemoved > 0) {
          actions.push(`Garbage-collected ${detail.unusedObjectsRemoved} unused object(s)`);
        }
      } catch {
        actions.push('Unused-object cleanup skipped (GC unavailable for this document)');
      }
    }

    if (actions.length === 0) actions.push('Nothing to sanitize');

    return { doc, report: actions, detail };
  }
}

function removePageAnnots(
  doc: PDFDocumentData,
  mode: { commentsOnly: boolean; all: boolean },
): { comments: number; annots: number } {
  let comments = 0;
  let annots = 0;
  const commentTypes = new Set(['Text', 'FreeText', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Caret', 'Stamp', 'Ink', 'Popup']);

  for (const page of doc.pages) {
    const annotsObj = page.dict.get('Annots');
    if (!annotsObj) continue;
    const arr = annotsObj instanceof PDFRef ? resolveRef(annotsObj, doc.objects) : annotsObj;
    if (!(arr instanceof PDFArray)) continue;

    for (let i = arr.length - 1; i >= 0; i--) {
      const item = arr.get(i);
      if (!(item instanceof PDFRef)) continue;
      const dict = resolveRef(item, doc.objects);
      if (!(dict instanceof PDFDict)) continue;
      const subtype = dict.getName('Subtype') ?? '';
      const isComment = commentTypes.has(subtype);
      if (mode.all || (mode.commentsOnly && isComment)) {
        arr.items.splice(i, 1);
        doc.objects.delete(item.toKey());
        if (isComment) comments++;
        else annots++;
      }
    }
  }
  return { comments, annots };
}

function removeOptionalContent(doc: PDFDocumentData): number {
  let n = 0;
  if (doc.catalog.has('OCProperties')) {
    doc.catalog.delete('OCProperties');
    n++;
  }
  for (const [, obj] of doc.objects) {
    if (!(obj instanceof PDFDict)) continue;
    if (obj.has('OC')) {
      obj.delete('OC');
      n++;
    }
  }
  return n;
}

function stripAlternativeImages(doc: PDFDocumentData): number {
  let n = 0;
  for (const [, obj] of doc.objects) {
    if (!(obj instanceof PDFDict) && !(obj && 'dict' in obj)) continue;
    const dict = obj instanceof PDFDict ? obj : (obj as { dict: PDFDict }).dict;
    if (dict instanceof PDFDict && dict.has('Alternates')) {
      dict.delete('Alternates');
      n++;
    }
  }
  // Also streams
  for (const [, obj] of doc.objects) {
    if (obj && typeof obj === 'object' && 'dict' in obj) {
      const streamDict = (obj as { dict: PDFDict }).dict;
      if (streamDict instanceof PDFDict && streamDict.has('Alternates')) {
        streamDict.delete('Alternates');
        n++;
      }
    }
  }
  return n;
}

export const sanitizationEngine = new SanitizationEngine();
