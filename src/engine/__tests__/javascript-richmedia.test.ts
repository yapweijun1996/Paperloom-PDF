import { describe, expect, it } from 'vitest';
import { PDFArray as LibArray, PDFDict as LibDict, PDFDocument, PDFName as LibName, PDFString as LibString } from 'pdf-lib';
import { parsePDF } from '../parser/parser';
import { javaScriptSecurityEngine as engine } from '../security/javascript/javascript-engine';
import { richMediaScripts, removeRichMediaScripts } from '../security/javascript/richmedia-javascript';
import { sanitizationEngine } from '../security/sanitization/sanitization-engine';
import { saveQuick } from '../writer/save-pipeline';
import { PDFArray, PDFDict, PDFNumber, PDFRef } from '../types';
import { serializeDocument } from '../writer/serializer';
import { dehydrateDocument, sameDocumentSnapshot } from '../worker/codec';
import { installSignatureBase } from '../signatures/crypto/signing-pipeline';
import { createSignatureField, importFromPem, signDocumentCryptographic, validateDocumentSignatures } from '../signatures';
import { getTestCredentials } from './signatures/test-credentials';

const onlyActions = { metadata: false, embeddedFiles: false, comments: false, annotations: false, unusedObjects: false, hiddenLayers: false, alternativeImages: false };
const scriptMarker = 'RICHMEDIA_SCRIPT_SAMPLE';
const videoMarker = 'RICHMEDIA_VIDEO_SAMPLE';
async function fixture(mode: 'normal' | 'shared-spec' | 'shared-stream' | 'shared-tree' | 'unknown-tree' | 'cyclic-script' | 'multiple-scripts' = 'normal') {
  const pdf = await PDFDocument.create(); const page = pdf.addPage([200, 200]); const c = pdf.context;
  pdf.catalog.set(LibName.of('Extensions'), c.obj({ ADBE: { BaseVersion: '1.7', ExtensionLevel: 3 } }));
  const js = c.register(c.stream(scriptMarker, { Type: 'EmbeddedFile' }));
  const video = c.register(c.stream(videoMarker, { Type: 'EmbeddedFile' }));
  const spec = c.register(c.obj({ Type: 'Filespec', F: LibString.of('script.js'), EF: { F: js } }));
  const js2 = c.register(c.stream('SECOND_RICHMEDIA_SCRIPT', { Type: 'EmbeddedFile' }));
  const spec2 = c.register(c.obj({ Type: 'Filespec', F: LibString.of('script2.js'), EF: { F: js2 } }));
  const media = c.register(c.obj({ Type: 'Filespec', F: LibString.of('movie.mp4'), EF: { F: mode === 'shared-stream' ? js : video } }));
  const instance = c.register(c.obj({ Type: 'RichMediaInstance', Subtype: 'Video', Asset: mode === 'shared-spec' ? spec : media }));
  const config = c.register(c.obj({ Type: 'RichMediaConfiguration', Subtype: 'Video', Instances: [instance] }));
  const assets = c.register(c.obj(mode === 'unknown-tree' ? { Kids: [] } : { Names: mode === 'multiple-scripts' ? [LibString.of('movie.mp4'), media, LibString.of('script.js'), spec, LibString.of('script2.js'), spec2] : [LibString.of('movie.mp4'), media, LibString.of('script.js'), spec] }));
  const annotation = c.register(c.obj({ Type: 'Annot', Subtype: 'RichMedia', Rect: [20, 20, 150, 150],
    RichMediaContent: { Assets: assets, Configurations: [config] }, RichMediaSettings: { Activation: { Condition: 'PO', Scripts: mode === 'multiple-scripts' ? [spec, spec2] : [spec] } } }));
  page.node.set(LibName.of('Annots'), c.obj([annotation]));
  if (mode === 'shared-tree') pdf.catalog.set(LibName.of('PieceInfo'), assets);
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  if (mode === 'cyclic-script') {
    const annots = doc.pages[0].dict.getArray('Annots')!;
    const annot = doc.objects.get((annots.get(0) as PDFRef).toKey()) as PDFDict;
    const settings = annot.getDict('RichMediaSettings')!;
    const activation = settings.getDict('Activation')!;
    const cycle = new PDFRef(9000, 0); doc.objects.set(cycle.toKey(), cycle);
    activation.set('Scripts', new PDFArray([cycle]));
  }
  return doc;
}

describe('RichMedia activation scripts', () => {
  it.each(['remove', 'sanitize'] as const)('%s removes script and retains unrelated media after save and reopen', async mode => {
    const doc = await fixture();
    expect(engine.analyze(doc).hasJavaScript).toBe(true);
    if (mode === 'remove') expect(engine.removeJavaScript(doc).removed).toBe(1);
    else expect((await sanitizationEngine.sanitize(doc, onlyActions)).detail.javascriptRemoved).toBe(1);
    const bytes = await saveQuick(doc);
    expect(Buffer.from(bytes).toString('latin1')).not.toContain(scriptMarker);
    expect(Buffer.from(bytes).toString('latin1')).toContain(videoMarker);
    const independentlyOpened = await PDFDocument.load(bytes, { updateMetadata:false });
    const annots = independentlyOpened.getPage(0).node.lookup(LibName.of('Annots'), LibArray);
    const annot = annots.lookup(0, LibDict);
    const content = annot.lookup(LibName.of('RichMediaContent'), LibDict);
    const assets = content.lookup(LibName.of('Assets'), LibDict);
    const names = assets.lookup(LibName.of('Names'), LibArray);
    expect(names.size()).toBe(2);
    expect((names.get(0) as LibString).asString()).toBe('movie.mp4');
    const settings = annot.lookup(LibName.of('RichMediaSettings'), LibDict);
    const activation = settings.lookup(LibName.of('Activation'), LibDict);
    expect(activation.has(LibName.of('Scripts'))).toBe(false);
    expect(content.lookup(LibName.of('Configurations'), LibArray).size()).toBe(1);
    expect(engine.analyze(await parsePDF(bytes)).hasJavaScript).toBe(false);
  });
  it('removes multiple script assets while preserving the movie', async () => {
    const doc = await fixture('multiple-scripts');
    expect(engine.analyze(doc).hasJavaScript).toBe(true);
    expect(engine.removeJavaScript(doc).removed).toBe(2);
    const output = Buffer.from(await saveQuick(doc)).toString('latin1');
    expect(output).not.toContain(scriptMarker);
    expect(output).not.toContain('SECOND_RICHMEDIA_SCRIPT');
    expect(output).toContain(videoMarker);
  });
  it('refuses inspection beyond the graph budget without modifying input', async () => {
    const doc = await fixture();
    doc.catalog.set('BudgetProbe', new PDFArray(Array.from({ length: 100_001 }, () => new PDFDict())));
    const before = dehydrateDocument(doc);
    expect(() => engine.removeJavaScript(doc)).toThrow(/RichMedia/i);
    expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
  }, 30000);
  it('counts every primitive edge in the inspection budget and leaves the document unchanged', async () => {
    const doc = await fixture();
    const value = new PDFNumber(7);
    doc.catalog.set('PrimitiveBudgetProbe', new PDFArray(Array.from({ length: 5 }, () => new PDFArray(Array(40_000).fill(value)))));
    const before = dehydrateDocument(doc);
    expect(() => engine.removeJavaScript(doc)).toThrow(/RichMedia/i);
    expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
  }, 30000);
  it('charges repeated indirect reference hops to the same budget', async () => {
    const doc = await fixture();
    const first = 10_000;
    for (let i = 0; i < 5_000; i++) doc.objects.set(new PDFRef(first + i, 0).toKey(), i === 4_999 ? new PDFDict() : new PDFRef(first + i + 1, 0));
    doc.catalog.set('ReferenceBudgetProbe', new PDFArray(Array(50).fill(new PDFRef(first, 0))));
    const before = dehydrateDocument(doc);
    expect(() => engine.removeJavaScript(doc)).toThrow(/RichMedia/i);
    expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
  }, 30000);
  it('does not mutate the graph if the second reachability scan exhausts its budget', async () => {
    const getAnnot = (doc: Awaited<ReturnType<typeof fixture>>) => {
      const annots = doc.pages[0].dict.getArray('Annots')!;
      return doc.objects.get((annots.get(0) as PDFRef).toKey()) as PDFDict;
    };
    const baseline = await fixture();
    const first = getAnnot(baseline);
    const fullBudget = { remaining: 200_000 };
    expect(removeRichMediaScripts(first, baseline, richMediaScripts(first, baseline)!, fullBudget)).toBe(1);
    const needed = 200_000 - fullBudget.remaining;
    const doc = await fixture();
    const annot = getAnnot(doc);
    const before = await serializeDocument(doc);
    expect(() => removeRichMediaScripts(annot, doc, richMediaScripts(annot, doc)!, { remaining: needed - 1 })).toThrow(/RichMedia/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });
  it('preserves real signed bytes when the script cannot be removed', async () => {
    const doc = await fixture();
    const field = createSignatureField(doc, 0, { x: 10, y: 10, width: 100, height: 30 }, 'Signer');
    await installSignatureBase(doc, await serializeDocument(doc));
    const credentials = getTestCredentials();
    const bundle = await importFromPem(credentials.pem, 'test');
    const signed = await signDocumentCryptographic(doc, field, bundle.key!.privateKey, {
      certificateDer: bundle.leaf!.der, hashAlgorithm: 'sha256', contentsSize: 4096, enableTimestamp: false,
    });
    const reopened = await parsePDF(signed.bytes);
    expect(engine.analyze(reopened).hasJavaScript).toBe(true);
    expect(() => engine.removeJavaScript(reopened)).toThrow(/signed|signature/i);
    await expect(sanitizationEngine.sanitize(reopened, onlyActions)).rejects.toThrow(/signed|signature/i);
    expect(await saveQuick(reopened)).toEqual(signed.bytes);
    const report = await validateDocumentSignatures(reopened, { allowSelfSigned: true });
    expect(report.signatures.some(item => item.digestMatch && item.cmsSignatureOk === true)).toBe(true);
  }, 30000);
  it.each(['shared-spec', 'shared-stream', 'shared-tree', 'unknown-tree', 'cyclic-script'] as const)('refuses %s without modifying input', async mode => {
    const doc = await fixture(mode); const before = await serializeDocument(doc);
    expect(() => engine.removeJavaScript(doc)).toThrow(/RichMedia/i);
    await expect(sanitizationEngine.sanitize(doc, onlyActions)).rejects.toThrow(/RichMedia/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });
});
