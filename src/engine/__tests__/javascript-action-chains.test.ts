import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { parsePDF } from '../parser/parser';
import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream, PDFString } from '../types';
import { javaScriptSecurityEngine as engine } from '../security/javascript/javascript-engine';
import { sanitizationEngine } from '../security/sanitization/sanitization-engine';
import { serializeDocument, serializeDocumentCompact } from '../writer/serializer';
import { appendIncrementalUpdate } from '../writer/incremental-writer';
import { saveOptimized, saveQuick } from '../writer/save-pipeline';
import { dehydrateDocument } from '../worker/codec';
import { handleWorkerCommand } from '../worker/handler';
import { SessionDocumentEditor, publishHistoryDraft } from '../session/document-edit';
import { signDocumentCryptographic } from '../signatures/crypto/signing-pipeline';
import { finalizeSignatureOnDocument } from '../signatures/crypto/finalizer';
import { embedDssIncremental } from '../signatures/ltv/dss-builder';
import { canAddSignatureWithoutInvalidating } from '../signatures/multi/multi-signature-manager';

async function fixture() {
  const source = await PDFDocument.create();
  source.addPage([200, 200]);
  return parsePDF(await source.save({ useObjectStreams: false }));
}

function action(kind: string): PDFDict {
  return new PDFDict([['S', new PDFName(kind)]]);
}

describe('chained PDF action sanitization', () => {
  it.each(['removeJavaScript', 'disableActions'] as const)(
    'refuses %s when the page cache omits a page with JavaScript', async method => {
      const source = await PDFDocument.create();
      source.addPage([200, 200]);
      source.addPage([200, 200]);
      const doc = await parsePDF(await source.save({ useObjectStreams: false }));
      const script = action('JavaScript');
      script.set('JS', new PDFString('MISSED_PAGE_SCRIPT'));
      doc.pages[1].dict.set('AA', new PDFDict([['O', script]]));
      doc.pages.pop();
      const before = await serializeDocument(doc);
      expect(new TextDecoder().decode(before)).toContain('MISSED_PAGE_SCRIPT');
      expect(() => engine.analyze(doc)).not.toThrow();
      expect(() => method === 'removeJavaScript' ? engine.removeJavaScript(doc) : engine.disableActions(doc)).toThrow(/page tree/i);
      expect(await serializeDocument(doc)).toEqual(before);
      expect(doc.requiresFullRewrite).toBeUndefined();
    },
  );

  it('removes direct and indirect JavaScript in nested /Next arrays while retaining unrelated actions after full save', async () => {
    const doc = await fixture();
    const js = action('JavaScript');
    js.set('JS', new PDFString('DANGEROUS_CHAIN_MARKER'));
    const jsRef = new PDFRef(900, 0);
    doc.objects.set(jsRef.toKey(), js);
    const first = action('URI');
    first.set('URI', new PDFString('https://example.test'));
    const safe = action('GoTo');
    const inner = new PDFArray([safe, jsRef]);
    const arrayRef = new PDFRef(901, 0);
    doc.objects.set(arrayRef.toKey(), inner);
    first.set('Next', new PDFArray([arrayRef, jsRef]));
    doc.catalog.set('OpenAction', first);
    const aa = new PDFDict([['O', first]]);
    doc.pages[0].dict.set('AA', aa);
    expect(engine.analyze(doc).hasJavaScript).toBe(true);

    expect(engine.removeJavaScript(doc).removed).toBe(2);
    const bytes = await serializeDocument(doc);
    expect(new TextDecoder().decode(bytes)).not.toContain('DANGEROUS_CHAIN_MARKER');
    const reopened = await parsePDF(bytes);
    const report = engine.analyze(reopened);
    expect(report.hasJavaScript).toBe(false);
    expect(report.actions.some(a => a.kind === 'URI')).toBe(true);
    expect(report.actions.some(a => a.kind === 'GoTo')).toBe(true);
  });

  it('cleans direct annotation additional actions and handles indirect cycles', async () => {
    const doc = await fixture();
    const js = action('JavaScript');
    js.set('JS', new PDFString('danger'));
    const go = action('GoTo');
    const ref = new PDFRef(920, 0);
    doc.objects.set(ref.toKey(), go);
    go.set('Next', new PDFArray([ref, js]));
    const annot = new PDFDict([['A', ref], ['AA', new PDFDict([['E', ref]])]]);
    doc.pages[0].dict.set('Annots', new PDFArray([annot]));
    expect(engine.analyze(doc).hasJavaScript).toBe(true);
    expect(engine.removeJavaScript(doc).removed).toBe(1);
    expect(engine.analyze(doc).hasJavaScript).toBe(false);
    expect(go.getArray('Next')?.length).toBe(1);
  });

  it('cleans nested field and outline actions that are not page annotations', async () => {
    const doc = await fixture();
    const js = action('JavaScript');
    js.set('JS', new PDFString('FIELD_OUTLINE_SCRIPT'));
    const safe = action('URI');
    safe.set('Next', js);
    const field = new PDFDict([['AA', new PDFDict([['K', safe]])]]);
    const parent = new PDFDict([['Kids', new PDFArray([field])]]);
    doc.catalog.set('AcroForm', new PDFDict([['Fields', new PDFArray([parent])]]));
    const outline = new PDFDict([['A', js]]);
    doc.catalog.set('Outlines', new PDFDict([['First', outline]]));
    expect(engine.analyze(doc).actions.filter(a => a.kind === 'JavaScript')).toHaveLength(2);
    expect(engine.removeJavaScript(doc).removed).toBe(2);
    const bytes = await serializeDocument(doc);
    expect(new TextDecoder().decode(bytes)).not.toContain('FIELD_OUTLINE_SCRIPT');
    expect(engine.analyze(await parsePDF(bytes)).hasJavaScript).toBe(false);
    expect(safe.has('Next')).toBe(false);
    expect(outline.has('A')).toBe(false);
  });

  it('stops safely on cycles in names trees and chains of indirect references', async () => {
    const doc = await fixture();
    const tree = new PDFDict();
    const treeRef = new PDFRef(930, 0);
    doc.objects.set(treeRef.toKey(), tree);
    tree.set('Kids', new PDFArray([treeRef]));
    doc.catalog.set('Names', new PDFDict([['JavaScript', treeRef]]));
    const a = new PDFRef(931, 0), b = new PDFRef(932, 0);
    doc.objects.set(a.toKey(), b);
    doc.objects.set(b.toKey(), a);
    doc.catalog.set('OpenAction', a);
    expect(() => engine.analyze(doc)).not.toThrow();
    expect(() => engine.removeJavaScript(doc)).not.toThrow();
    expect(doc.catalog.getDict('Names')?.has('JavaScript')).toBe(false);
  });

  it('honors OpenAction removal when it is requested with other kinds', async () => {
    const doc = await fixture();
    doc.catalog.set('OpenAction', action('URI'));
    const result = await sanitizationEngine.sanitize(doc, { metadata: false, embeddedFiles: false, comments: false, unusedObjects: false, hiddenLayers: false, alternativeImages: false });
    expect(result.detail.javascriptRemoved).toBe(1);
    expect(doc.catalog.has('OpenAction')).toBe(false);
  });

  it('sanitizes chained page actions through the public sanitization API', async () => {
    const doc = await fixture();
    const js = action('JavaScript');
    js.set('JS', new PDFString('SANITIZE_CHAIN_MARKER'));
    const safe = action('GoTo');
    safe.set('Next', new PDFArray([js, action('URI')]));
    doc.pages[0].dict.set('AA', new PDFDict([['O', safe]]));
    const { detail } = await sanitizationEngine.sanitize(doc, {
      metadata: false, embeddedFiles: false, comments: false,
      unusedObjects: false, hiddenLayers: false, alternativeImages: false,
    });
    expect(detail.javascriptRemoved).toBe(1);
    const bytes = await serializeDocument(doc);
    expect(new TextDecoder().decode(bytes)).not.toContain('SANITIZE_CHAIN_MARKER');
    const report = engine.analyze(await parsePDF(bytes));
    expect(report.hasJavaScript).toBe(false);
    expect(report.actions.map(a => a.kind)).toEqual(['GoTo', 'URI']);
  });

  it('removes 3D instantiation scripts and chained presentation navigation actions', async () => {
    const doc = await fixture();
    const js = action('JavaScript');
    js.set('JS', new PDFString('NAVIGATION_SCRIPT'));
    const node = new PDFDict([['NA', new PDFArray([action('GoTo'), js])], ['PA', js]]);
    const nodeRef = new PDFRef(940, 0);
    node.set('Next', nodeRef);
    doc.objects.set(nodeRef.toKey(), node);
    doc.pages[0].dict.set('PresSteps', nodeRef);
    const scriptRef = new PDFRef(941, 0);
    const scriptBytes = new TextEncoder().encode('INSTANTIATE_SCRIPT');
    doc.objects.set(scriptRef.toKey(), new PDFStream(new PDFDict(), scriptBytes));
    const artwork = new PDFStream(new PDFDict([['Subtype', new PDFName('U3D')], ['OnInstantiate', scriptRef]]), new Uint8Array([1, 2, 3]));
    const artworkRef = new PDFRef(942, 0);
    doc.objects.set(artworkRef.toKey(), artwork);
    const annotation = new PDFDict([['Subtype', new PDFName('3D')], ['3DD', artworkRef]]);
    doc.pages[0].dict.set('Annots', new PDFArray([annotation]));
    expect(engine.analyze(doc).actions.filter(a => a.kind === 'JavaScript')).toHaveLength(3);
    expect(engine.removeJavaScript(doc).removed).toBe(3);
    const output = await serializeDocument(doc);
    const text = new TextDecoder().decode(output);
    expect(text).not.toContain('NAVIGATION_SCRIPT');
    expect(text).not.toContain('INSTANTIATE_SCRIPT');
    expect(engine.analyze(await parsePDF(output)).hasJavaScript).toBe(false);
  });

  it('forces a full rewrite after action removal, including through worker serialization', async () => {
    const original = await fixture();
    const js = action('JavaScript');
    js.set('JS', new PDFString('HISTORICAL_SCRIPT_MARKER'));
    original.catalog.set('OpenAction', js);
    const doc = await parsePDF(await serializeDocument(original));
    expect(new TextDecoder().decode(doc.rawBytes)).toContain('HISTORICAL_SCRIPT_MARKER');
    engine.removeJavaScript(doc);
    const root = doc.xref.trailerDict.getRef('Root')!.toKey();
    expect(() => appendIncrementalUpdate(doc, new Set([root]))).toThrow(/full rewrite/i);
    const output = await saveQuick(doc, new Set([root]));
    expect(new TextDecoder().decode(output)).not.toContain('HISTORICAL_SCRIPT_MARKER');
    const reply = await handleWorkerCommand({ type: 'SAVE_PDF', requestId: 'cleanup', document: dehydrateDocument(doc), modifiedKeys: [root] });
    expect(reply.type).toBe('RESULT');
    if (reply.type !== 'RESULT' || !reply.bytes) throw new Error('Missing output');
    expect(new TextDecoder().decode(reply.bytes)).not.toContain('HISTORICAL_SCRIPT_MARKER');
    await expect(saveQuick(doc, new Set([root]), new Map([['999_0', new PDFString('new')]])))
      .rejects.toThrow(/add new objects/i);
    await expect(handleWorkerCommand({ type: 'SAVE_PDF', requestId: 'new-objects', document: dehydrateDocument({ ...doc, objects: new Map([...doc.objects, ['999_0', new PDFString('new')]]) }), modifiedKeys: [root], newObjectKeys: ['999_0'] }))
      .rejects.toThrow(/add new objects/i);
  });

  it('forces a full rewrite after non-JavaScript sanitization', async () => {
    const original = await fixture();
    original.catalog.set('Metadata', new PDFRef(943, 0));
    original.objects.set('943_0', new PDFStream(new PDFDict(), new TextEncoder().encode('PRIVATE_METADATA_MARKER')));
    const doc = await parsePDF(await serializeDocument(original));
    await sanitizationEngine.sanitize(doc, { javascript: false, embeddedFiles: false, comments: false, unusedObjects: false, hiddenLayers: false, alternativeImages: false });
    expect(() => appendIncrementalUpdate(doc, new Set())).toThrow(/full rewrite/i);
    const bytes = await saveQuick(doc, new Set([doc.xref.trailerDict.getRef('Root')!.toKey()]));
    expect(new TextDecoder().decode(bytes)).not.toContain('PRIVATE_METADATA_MARKER');
  });

  it('refuses XFA cleanup before changing actions, metadata or the save policy', async () => {
    const doc = await fixture();
    const xfa = new PDFStream(new PDFDict(), new TextEncoder().encode('<script>xfa_script()</script>'));
    const form = new PDFDict([['XFA', xfa]]);
    const js = action('JavaScript');
    js.set('JS', new PDFString('retained'));
    doc.catalog.set('AcroForm', form);
    doc.catalog.set('OpenAction', js);
    doc.catalog.set('Metadata', new PDFStream(new PDFDict(), new TextEncoder().encode('metadata')));
    const before = await serializeDocument(doc);
    expect(() => engine.removeJavaScript(doc)).toThrow(/XFA.*no changes/i);
    await expect(sanitizationEngine.sanitize(doc)).rejects.toThrow(/XFA.*no changes/i);
    expect(doc.catalog.get('AcroForm')).toBe(form);
    expect(doc.catalog.get('OpenAction')).toBe(js);
    expect(doc.catalog.has('Metadata')).toBe(true);
    expect(doc.requiresFullRewrite).toBeUndefined();
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('fails closed when an interactive form cannot be inspected', async () => {
    const doc = await fixture();
    doc.catalog.set('AcroForm', new PDFRef(999, 0));
    expect(() => engine.removeJavaScript(doc)).toThrow(/cannot safely inspect/i);
    await expect(sanitizationEngine.sanitize(doc)).rejects.toThrow(/cannot safely inspect/i);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it.each(['edit transaction', 'history draft'] as const)(
    'retains the full rewrite requirement when cleanup is published from a %s',
    async (mode) => {
      const original = await fixture();
      const js = action('JavaScript');
      js.set('JS', new PDFString('TRANSACTION_OLD_SCRIPT'));
      original.catalog.set('OpenAction', js);
      const doc = await parsePDF(await serializeDocument(original));
      if (mode === 'edit transaction') {
        await new SessionDocumentEditor().edit(doc, 'clean', async staged => { engine.removeJavaScript(staged); });
      } else {
        await publishHistoryDraft(doc, async staged => { engine.removeJavaScript(staged); }, () => true, () => {});
      }
      expect(doc.requiresFullRewrite).toBe(true);
      expect(() => appendIncrementalUpdate(doc, new Set())).toThrow(/full rewrite/i);
      expect(new TextDecoder().decode(await saveQuick(doc, new Set([doc.xref.trailerDict.getRef('Root')!.toKey()]))))
        .not.toContain('TRANSACTION_OLD_SCRIPT');
    },
  );

  it('refuses signing and DSS incremental workflows before modifying a cleaned graph', async () => {
    const doc = await fixture();
    const fieldRef = new PDFRef(950, 0);
    const field = new PDFDict([['FT', new PDFName('Sig')]]);
    doc.objects.set(fieldRef.toKey(), field);
    const js = action('JavaScript');
    doc.catalog.set('OpenAction', js);
    engine.removeJavaScript(doc);
    const objectCount = doc.objects.size;
    const raw = doc.rawBytes.slice();
    const unusedKey = {} as CryptoKey;
    expect(canAddSignatureWithoutInvalidating(doc)).toMatchObject({ ok: false, reason: expect.stringMatching(/reopen/i) });
    await expect(signDocumentCryptographic(doc, fieldRef, unusedKey)).rejects.toThrow(/full rewrite/i);
    await expect(finalizeSignatureOnDocument(doc, doc.rawBytes, unusedKey)).rejects.toThrow(/full rewrite/i);
    expect(() => embedDssIncremental(doc, { certificates: [new Uint8Array([1])] })).toThrow(/full rewrite/i);
    expect(doc.objects.size).toBe(objectCount);
    expect(field.has('V')).toBe(false);
    expect(doc.catalog.has('DSS')).toBe(false);
    expect(doc.rawBytes).toEqual(raw);
  });

  it('does not pack detached sensitive objects during compact output after cleanup', async () => {
    const original = await fixture();
    const ref = new PDFRef(951, 0);
    const js = action('JavaScript');
    js.set('JS', new PDFString('DETACHED_COMPACT_SCRIPT'));
    original.objects.set(ref.toKey(), js);
    original.catalog.set('OpenAction', ref);
    const doc = await parsePDF(await serializeDocument(original));
    engine.removeJavaScript(doc);
    const saved = await parsePDF(await serializeDocumentCompact(doc));
    expect(engine.analyze(saved).hasJavaScript).toBe(false);
    expect([...saved.objects.values()].some(value => value instanceof PDFDict && value.getString('JS') === 'DETACHED_COMPACT_SCRIPT')).toBe(false);
  });

  it.each(['missing', 'unknown', 'wrong type', 'different catalog'] as const)(
    'rejects cleaned output without a valid trailer root (%s) in direct and worker writers',
    async kind => {
      const doc = await fixture();
      const js = action('JavaScript');
      js.set('JS', new PDFString('INVALID_ROOT_SCRIPT'));
      const jsRef = new PDFRef(952, 0);
      doc.objects.set(jsRef.toKey(), js);
      doc.catalog.set('OpenAction', jsRef);
      engine.removeJavaScript(doc);
      if (kind === 'missing') doc.xref.trailerDict.delete('Root');
      if (kind === 'unknown') doc.xref.trailerDict.set('Root', new PDFRef(953, 0));
      if (kind === 'wrong type') {
        doc.objects.set('953_0', new PDFDict([['Type', new PDFName('Pages')]]));
        doc.xref.trailerDict.set('Root', new PDFRef(953, 0));
      }
      if (kind === 'different catalog') {
        doc.objects.set('953_0', new PDFDict([['Type', new PDFName('Catalog')]]));
        doc.xref.trailerDict.set('Root', new PDFRef(953, 0));
      }
      const before = [...doc.objects.entries()];
      await expect(serializeDocument(doc)).rejects.toThrow(/trailer root/i);
      await expect(serializeDocumentCompact(doc)).rejects.toThrow(/trailer root/i);
      await expect(saveOptimized(doc)).rejects.toThrow(/trailer root/i);
      expect([...doc.objects.entries()]).toEqual(before);
      await expect(handleWorkerCommand({ type: 'OPTIMIZE_PDF', requestId: 'bad-root', document: dehydrateDocument(doc) }))
        .rejects.toThrow(/trailer root/i);
    },
  );
});
