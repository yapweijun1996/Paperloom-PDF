/**
 * Sanitization Engine — Phase 11.
 * Removes metadata, JS, attachments, comments, unused objects, optional annots.
 */

import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFDocumentData,
  type PDFObject,
} from '../../types';
import { garbageCollect } from '../../optimize/garbage-collect';
import { dehydrateDocument, hydrateDocument, sameDocumentSnapshot } from '../../worker/codec';
import { hasDocumentSignature, SignedDocumentEditError } from '../../writer/save-pipeline';
import { metadataEngine } from '../metadata/metadata-engine';
import { assertJavaScriptRemovalSupported, javaScriptSecurityEngine } from '../javascript/javascript-engine';
import { embeddedFileSecurityEngine } from '../embedded-files/embedded-file-engine';
import { assertAllAttachmentsRemovable, assertAttachmentGraphResolvable } from '../embedded-files/attachment-removal';
import { assertHiddenTextSourceSafe, removeIsolatedHiddenText } from './isolated-hidden-text';
import { assertCompletePageTree } from '../validate-page-tree';
import { assertComponentMetadataRemovable, removeComponentMetadata } from './component-metadata';
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
    if (Object.values(opts).some(Boolean)) {
      assertCompletePageTree(doc, reason => {
        throw new Error(`Cannot safely sanitize: ${reason}; no changes were made.`);
      });
    }
    if (opts.javascript) assertJavaScriptRemovalSupported(doc);
    if (opts.embeddedFiles) assertAllAttachmentsRemovable(doc);
    if (opts.metadata) assertMetadataRemovable(doc);
    if (opts.hiddenLayers) assertHiddenTextSourceSafe(doc);
    // Validate the complete ordered operation before touching the live document:
    // earlier steps can change reachability and make later removal unsafe.
    const draft = hydrateDocument(dehydrateDocument(doc, { includeRawBytes: false }));
    const signed = hasDocumentSignature(doc);
    const before = signed ? dehydrateDocument(draft, { includeRawBytes: false }) : undefined;
    this.applySanitization(draft, opts);
    assertAttachmentGraphResolvable(draft);
    if (before) {
      const after = dehydrateDocument(draft, { includeRawBytes: false });
      // A rewrite flag alone is not an edit; retain the original signed bytes
      // when a cleanup produces no change to the document.
      before.requiresFullRewrite = after.requiresFullRewrite = undefined;
      if (!sameDocumentSnapshot(before, after)) throw new SignedDocumentEditError();
      // Preview reports can describe attempted work even when there was no
      // metadata or other content to remove. Only report actual changes.
      const actions = ['Nothing to sanitize'];
      return { doc, report: actions, detail: {
        actions, metadataRemoved: false, javascriptRemoved: 0, attachmentsRemoved: 0,
        commentsRemoved: 0, annotationsRemoved: 0, unusedObjectsRemoved: 0, layersRemoved: 0,
      } };
    }
    return this.applySanitization(doc, opts);
  }

  private applySanitization(
    doc: PDFDocumentData,
    opts: Required<SanitizeOptions>,
  ): { doc: PDFDocumentData; report: string[]; detail: SanitizeReport } {
    // Removed content remains in doc.rawBytes until a full rewrite is emitted.
    if (Object.values(opts).some(Boolean)) doc.requiresFullRewrite = true;

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

    if (opts.hiddenLayers) {
      detail.layersRemoved = removeIsolatedHiddenText(doc, opts.metadata);
      assertHiddenLayersRemovable(doc);
      if (detail.layersRemoved) actions.push(`Removed ${detail.layersRemoved} hidden layer(s)`);
    }

    if (opts.metadata) {
      const infoEntry = doc.xref.trailerDict.get('Info');
      const info = resolveSanitizationObject(infoEntry, doc.objects);
      const removedInfo = info instanceof PDFDict && (info.size > 0 || infoEntry instanceof PDFRef);
      const removedXmp = doc.catalog.has('Metadata');
      const removedComponents = removeComponentMetadata(doc);
      metadataEngine.stripMetadata(doc, { stripInfo: true, stripXmp: true, stripCustom: true });
      detail.metadataRemoved = removedInfo || removedXmp || removedComponents > 0;
      if (removedInfo) actions.push('Removed document information metadata');
      if (removedXmp) actions.push('Removed document XMP metadata');
      if (removedComponents) actions.push(`Removed ${removedComponents} component metadata reference(s)`);
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

  const removed = new Set<PDFDict>();
  for (const page of doc.pages) {
    const annotsObj = page.dict.get('Annots');
    if (!annotsObj) continue;
    const arr = resolveSanitizationObject(annotsObj, doc.objects);
    if (!(arr instanceof PDFArray)) throw new Error('Cannot safely inspect page annotations.');

    const retained: PDFObject[] = [];
    for (let i = 0; i < arr.length; i++) {
      const item = arr.get(i);
      const dict = resolveSanitizationObject(item, doc.objects);
      if (!(dict instanceof PDFDict) || !dict.getName('Subtype')) {
        throw new Error('Cannot safely inspect a page annotation.');
      }
      const subtype = dict.getName('Subtype')!;
      const isComment = commentTypes.has(subtype);
      if (mode.all || (mode.commentsOnly && isComment)) {
        removed.add(dict);
        if (isComment) comments++;
        else annots++;
      } else if (item) retained.push(item);
    }
    if (retained.length !== arr.length) {
      // Do not mutate a potentially shared annotation array or delete an
      // indirect object another part of the document might still reference.
      if (retained.length) page.dict.set('Annots', new PDFArray(retained));
      else page.dict.delete('Annots');
    }
  }
  if (removed.size) {
    const sensitive = new Set<PDFObject>(), sensitiveRefs = new Set<string>();
    const pageDicts = new Set(doc.pages.map(page => page.dict));
    const seen = new Set<PDFObject>(), pending: PDFObject[] = [...removed];
    const pendingResources: PDFObject[] = [], seenResources = new Set<PDFObject>();
    const fail = (): never => { throw new Error('Cannot safely inspect removed annotation data; no changes were made.'); };
    let inspectionWork = 0;
    const charge = (): void => { if (++inspectionWork > 500_000) fail(); };
    const resolvedRefs = new Map<string, PDFObject>();
    const resolve = (value: PDFObject): PDFObject => {
      const path: string[] = [], visited = new Set<string>();
      while (value instanceof PDFRef) {
        const key = value.toKey(), cached = resolvedRefs.get(key);
        if (cached) { value = cached; break; }
        charge();
        if (visited.has(key) || path.length >= 100_000) return fail();
        visited.add(key); path.push(key);
        const next = doc.objects.get(key);
        if (!next) return fail();
        value = next;
      }
      if (resolvedRefs.size + path.length > 100_000) return fail();
      for (const key of path) resolvedRefs.set(key, value);
      return value;
    };
    const standardFonts = new Set([
      'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
      'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
      'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic', 'Symbol', 'ZapfDingbats',
    ]);
    const inspectFont = (value: PDFObject): void => {
      const font = resolve(value);
      if (!(font instanceof PDFDict)) return fail();
      const encoding = font.get('Encoding');
      const resourceName = font.get('Name');
      const standard = (!font.has('Type') || font.getName('Type') === 'Font') &&
        font.getName('Subtype') === 'Type1' && standardFonts.has(font.getName('BaseFont') ?? '') &&
        [...font.keys()].every(key => ['Type', 'Subtype', 'BaseFont', 'Name', 'Encoding'].includes(key)) &&
        (!resourceName || resourceName instanceof PDFName) &&
        (!encoding || (encoding instanceof PDFName && ['StandardEncoding', 'WinAnsiEncoding', 'MacRomanEncoding', 'MacExpertEncoding'].includes(encoding.name)));
      // Custom fonts, Type3 glyph procedures and embedded font programs may
      // themselves carry annotation data; inspect their full object graph.
      if (!standard) pending.push(value);
    };
    const collectStateData = (value: PDFObject): void => {
      const queue = [value], seenArrays = new Set<PDFObject>();
      while (queue.length) {
        charge();
        if (seenArrays.size >= 100_000 || queue.length > 100_000) return fail();
        const item = queue.pop()!, target = resolve(item);
        if (target instanceof PDFArray) {
          if (seenArrays.has(target)) continue;
          seenArrays.add(target);
          if (target.length + queue.length > 100_000) return fail();
          for (const child of target.items) queue.push(child);
        } else if (target instanceof PDFDict || target instanceof PDFStream || target instanceof PDFString || target instanceof PDFHexString) {
          pending.push(item);
        }
      }
    };
    const inspectColor = (value: PDFObject): void => {
      const queue = [value], inspected = new Set<PDFObject>();
      while (queue.length) {
        charge();
        if (inspected.size >= 100_000 || queue.length > 100_000) return fail();
        const target = resolve(queue.pop()!);
        if (inspected.has(target)) continue;
        inspected.add(target);
        if (target instanceof PDFName) {
          if (!['DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'G', 'RGB', 'CMYK', 'Pattern'].includes(target.name)) return fail();
          continue;
        }
        if (!(target instanceof PDFArray) || !target.length) return fail();
        const kind = resolve(target.items[0]);
        if (!(kind instanceof PDFName)) return fail();
        if (kind.name === 'ICCBased') {
          if (target.length !== 2 || !(resolve(target.items[1]) instanceof PDFStream)) return fail();
          // ICC profiles can carry arbitrary tags or appended bytes, so an
          // independently retained profile can preserve annotation content.
          collectStateData(target.items[1]);
        } else if (kind.name === 'Indexed' || kind.name === 'I') {
          if (target.length !== 4 || !(resolve(target.items[2]) instanceof PDFNumber)) return fail();
          const lookup = resolve(target.items[3]);
          if (!(lookup instanceof PDFString || lookup instanceof PDFHexString || lookup instanceof PDFStream)) return fail();
          queue.push(target.items[1]); collectStateData(target.items[3]);
        } else if (kind.name === 'Separation') {
          if (target.length !== 4 || !(resolve(target.items[1]) instanceof PDFName)) return fail();
          queue.push(target.items[2]); collectStateData(target.items[3]);
        } else if (kind.name === 'DeviceN') {
          if (target.length < 4 || target.length > 5) return fail();
          const names = resolve(target.items[1]);
          if (!(names instanceof PDFArray) || !names.length || names.length > 100_000 ||
              names.items.some(name => { charge(); return !(resolve(name) instanceof PDFName); })) return fail();
          queue.push(target.items[2]); collectStateData(target.items[3]);
          if (target.length === 5) collectStateData(target.items[4]);
        } else if (kind.name === 'Pattern') {
          if (target.length > 2) return fail();
          if (target.length === 2) queue.push(target.items[1]);
        } else if (['CalGray', 'CalRGB', 'Lab'].includes(kind.name)) {
          if (target.length !== 2) return fail();
          const params = resolve(target.items[1]);
          if (!(params instanceof PDFDict)) return fail();
          for (const child of params.values()) collectStateData(child);
        } else return fail();
      }
    };
    const collectAppearanceResources = (value: PDFObject): void => {
      const resources = resolve(value);
      charge();
      if (!(resources instanceof PDFDict)) return fail();
      if (seenResources.has(resources)) return;
      seenResources.add(resources);
      if (seenResources.size > 100_000) return fail();
      const knownKeys = new Set(['ExtGState', 'ColorSpace', 'Pattern', 'Shading', 'XObject', 'Font', 'Properties', 'ProcSet']);
      if ([...resources.keys()].some(key => !knownKeys.has(key))) return fail();
      const rawFonts = resources.get('Font');
      if (rawFonts) {
        const fonts = resolve(rawFonts);
        if (!(fonts instanceof PDFDict)) return fail();
        for (const font of fonts.values()) { charge(); inspectFont(font); }
      }
      const rawColorSpaces = resources.get('ColorSpace');
      if (rawColorSpaces) {
        const colorSpaces = resolve(rawColorSpaces);
        if (!(colorSpaces instanceof PDFDict)) return fail();
        for (const color of colorSpaces.values()) { charge(); inspectColor(color); }
      }
      const rawXObjects = resources.get('XObject');
      if (rawXObjects) {
        const xobjects = resolve(rawXObjects);
        if (!(xobjects instanceof PDFDict)) return fail();
        // Form and image XObjects may carry the annotation's actual content;
        // font and color resources can be shared independently of that content.
        for (const child of xobjects.values()) {
          charge();
          if (!(resolve(child) instanceof PDFStream)) return fail();
          pending.push(child);
        }
      }
      for (const key of ['Pattern', 'Shading']) {
        const raw = resources.get(key);
        if (!raw) continue;
        const entries = resolve(raw);
        if (!(entries instanceof PDFDict)) return fail();
        for (const child of entries.values()) {
          charge();
          const target = resolve(child);
          if (!(target instanceof PDFDict) && !(target instanceof PDFStream)) return fail();
          pending.push(child);
        }
      }
      const rawProperties = resources.get('Properties');
      if (rawProperties) {
        const properties = resolve(rawProperties);
        if (!(properties instanceof PDFDict)) return fail();
        for (const child of properties.values()) {
          charge();
          if (!(resolve(child) instanceof PDFDict)) return fail();
          pending.push(child);
        }
      }
      const rawStates = resources.get('ExtGState');
      if (rawStates) {
        const states = resolve(rawStates);
        if (!(states instanceof PDFDict)) return fail();
        for (const child of states.values()) {
          charge();
          const state = resolve(child);
          if (!(state instanceof PDFDict)) return fail();
          for (const [key, entry] of state.entries()) {
            charge();
            if (key === 'Font') {
              const fontSetting = resolve(entry);
              if (!(fontSetting instanceof PDFArray) || fontSetting.length !== 2) return fail();
              const [font, size] = fontSetting.items;
              if (!(resolve(size) instanceof PDFNumber)) return fail();
              inspectFont(font);
            } else collectStateData(entry);
          }
        }
      }
    };
    while (pending.length || pendingResources.length) {
      charge();
      if (seen.size >= 100_000 || pending.length > 100_000 || pendingResources.length > 100_000) return fail();
      if (pendingResources.length) { collectAppearanceResources(pendingResources.pop()!); continue; }
      const value = pending.pop()!;
      if (seen.has(value)) continue;
      seen.add(value);
      if (value instanceof PDFRef) {
        const target = resolve(value);
        if (!target) return fail();
        if (target instanceof PDFRef || target instanceof PDFArray || target instanceof PDFDict ||
            target instanceof PDFStream || target instanceof PDFString || target instanceof PDFHexString) {
          sensitiveRefs.add(value.toKey());
          const next = doc.objects.get(value.toKey());
          if (!next) return fail();
          pending.push(next);
        }
      } else if (value instanceof PDFArray) {
        sensitive.add(value);
        if (value.length + pending.length > 100_000) return fail();
        for (const item of value.items) pending.push(item);
      } else if (value instanceof PDFDict) {
        sensitive.add(value);
        for (const [key, child] of value.entries()) {
          // A page back-reference is structural, not annotation content.
          if (key === 'P' && pageDicts.has(resolve(child) as PDFDict)) continue;
          if (key === 'ColorSpace') { inspectColor(child); continue; }
          if (key === 'Resources') pendingResources.push(child);
          else pending.push(child);
        }
      } else if (value instanceof PDFStream) {
        sensitive.add(value);
        sensitive.add(value.dict);
        for (const [key, child] of value.dict.entries()) {
          if (key === 'Resources') pendingResources.push(child);
          else if (key === 'ColorSpace') inspectColor(child);
          else pending.push(child);
        }
      } else if (value instanceof PDFString || value instanceof PDFHexString) sensitive.add(value);
    }
    walkLiveObjects(doc, value => {
      if (sensitive.has(value) || (value instanceof PDFRef && sensitiveRefs.has(value.toKey()))) {
        throw new Error('A removed annotation is shared with retained document content.');
      }
    });
  }
  return { comments, annots };
}

function resolveSanitizationObject(value: PDFObject | undefined, objects: Map<string, PDFObject>): PDFObject | undefined {
  const seen = new Set<string>();
  while (value instanceof PDFRef) {
    const key = value.toKey();
    if (seen.has(key)) throw new Error('Cannot safely inspect a cyclic document reference.');
    seen.add(key);
    value = objects.get(key);
    if (!value) throw new Error('Cannot safely inspect an unresolved document reference.');
  }
  return value;
}

function walkLiveObjects(doc: PDFDocumentData, visit: (value: PDFObject) => void,
  skip?: (dict: PDFDict, key: string) => boolean): void {
  const pending: PDFObject[] = [doc.catalog, doc.xref.trailerDict];
  for (const page of doc.pages) pending.push(page.dict, page.resources, ...page.contentRefs);
  const seen = new Set<PDFObject>();
  while (pending.length) {
    const value = pending.pop()!;
    if (seen.has(value)) continue;
    seen.add(value);
    visit(value);
    if (value instanceof PDFRef) {
      const target = doc.objects.get(value.toKey());
      if (!target) throw new Error('Cannot safely inspect an unresolved document reference.');
      pending.push(target);
    } else if (value instanceof PDFArray) pending.push(...value.items);
    else if (value instanceof PDFDict) {
      for (const [key, child] of value.entries()) if (!skip?.(value, key)) pending.push(child);
    }
    else if (value instanceof PDFStream) pending.push(value.dict);
  }
}

function assertHiddenLayersRemovable(doc: PDFDocumentData): void {
  walkLiveObjects(doc, value => {
    if (value instanceof PDFDict && (value.has('OCProperties') || value.has('OC') ||
        value.getName('Type') === 'OCG' || value.getName('Type') === 'OCMD')) {
      // Removing layer settings alone can expose the original marked content.
      // Until content streams can be rewritten safely, do not claim removal.
      throw new Error('Hidden layer cleanup is unavailable for optional content; no changes were made.');
    }
  });
}

function assertMetadataRemovable(doc: PDFDocumentData): void {
  assertComponentMetadataRemovable(doc);
  const info = doc.xref.trailerDict.get('Info');
  if (info !== undefined && !(resolveSanitizationObject(info, doc.objects) instanceof PDFDict)) {
    throw new Error('Cannot safely inspect document information metadata; no changes were made.');
  }
  const metadata = doc.catalog.get('Metadata');
  if (metadata !== undefined) {
    // The metadata engine currently handles direct streams and one indirect
    // reference only; silently accepting other forms would leave data behind.
    const stream = metadata instanceof PDFRef ? doc.objects.get(metadata.toKey()) : metadata;
    if (!(stream instanceof PDFStream)) {
      throw new Error('Cannot safely inspect document XMP metadata; no changes were made.');
    }
  }
}

function stripAlternativeImages(doc: PDFDocumentData): number {
  const owners = new Set<PDFDict>();
  // Resource dictionaries may be direct descendants of a page or another
  // container rather than independent entries in the object table.
  walkLiveObjects(doc, value => { if (value instanceof PDFDict && value.has('Alternates')) owners.add(value); });
  const sensitive = new Set<PDFObject>(), sensitiveRefs = new Set<string>();
  const pending = [...owners].map(owner => owner.get('Alternates')!);
  const seen = new Set<PDFObject>();
  while (pending.length) {
    const value = pending.pop()!;
    if (seen.has(value)) continue;
    seen.add(value);
    if (seen.size > 100_000) throw new Error('Cannot safely inspect alternative images; no changes were made.');
    if (value instanceof PDFRef) {
      sensitiveRefs.add(value.toKey());
      const target = doc.objects.get(value.toKey());
      if (!target) throw new Error('Cannot safely inspect alternative images; no changes were made.');
      pending.push(target);
    } else if (value instanceof PDFArray) { sensitive.add(value); pending.push(...value.items); }
    else if (value instanceof PDFDict) { sensitive.add(value); pending.push(...value.values()); }
    else if (value instanceof PDFStream) {
      // Masks carry image pixels, but shared color profiles are not image data.
      sensitive.add(value); sensitive.add(value.dict);
      for (const key of ['Mask', 'SMask']) {
        const mask = value.dict.get(key);
        if (!mask) continue;
        const target = resolveSanitizationObject(mask, doc.objects);
        // A color-key mask is only numeric ranges; retaining it cannot retain
        // pixels from the alternative image.
        if (key === 'Mask' && target instanceof PDFArray && target.length > 0 &&
            target.length % 2 === 0 && target.items.every(item => item instanceof PDFNumber)) continue;
        if (key === 'SMask' && target instanceof PDFName && target.name === 'None') continue;
        if (!(target instanceof PDFStream) || target.dict.getName('Subtype') !== 'Image') {
          throw new Error('Cannot safely inspect an alternative image mask; no changes were made.');
        }
        pending.push(mask);
      }
    } else if (value instanceof PDFString || value instanceof PDFHexString) sensitive.add(value);
  }
  walkLiveObjects(doc, value => {
    if (sensitive.has(value) || (value instanceof PDFRef && sensitiveRefs.has(value.toKey()))) {
      throw new Error('Cannot safely remove alternative images shared with retained data; no changes were made.');
    }
  }, (_dict, key) => key === 'Alternates');
  let n = 0;
  const strip = (dict: PDFDict) => {
    if (dict.has('Alternates')) { dict.delete('Alternates'); n++; }
  };
  for (const owner of owners) strip(owner);
  // Preserve cleanup of detached object-table entries from earlier versions.
  for (const [, obj] of doc.objects) {
    if (obj instanceof PDFDict) strip(obj);
    else if (obj instanceof PDFStream) strip(obj.dict);
  }
  return n;
}

export const sanitizationEngine = new SanitizationEngine();
