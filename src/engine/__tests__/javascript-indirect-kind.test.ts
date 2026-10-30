import { describe, expect, it } from 'vitest';
import { PDFDict as LibDict, PDFDocument, PDFName as LibName, PDFString as LibString } from 'pdf-lib';
import { parsePDF } from '../parser/parser';
import { PDFDict, PDFNumber, PDFRef } from '../types';
import { javaScriptSecurityEngine as engine } from '../security/javascript/javascript-engine';
import { sanitizationEngine } from '../security/sanitization/sanitization-engine';
import { serializeDocument } from '../writer/serializer';
import { saveQuick } from '../writer/save-pipeline';
import { dehydrateDocument, sameDocumentSnapshot } from '../worker/codec';
import { installSignatureBase } from '../signatures/crypto/signing-pipeline';
import { createSignatureField, importFromPem, signDocumentCryptographic, validateDocumentSignatures } from '../signatures';
import { getTestCredentials } from './signatures/test-credentials';

const onlyActions = { metadata: false, embeddedFiles: false, comments: false, unusedObjects: false, hiddenLayers: false, alternativeImages: false };
const marker = 'PRIVATE_INDIRECT_ACTION_16';

async function fixture(nested: boolean) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([200, 200]);
  const ctx = pdf.context;
  const kind = ctx.register(LibName.of('JavaScript'));
  const script = ctx.obj({ S: kind, JS: LibString.of(`app.alert("${marker}")`) });
  const action = nested ? ctx.obj({ S: 'URI', URI: LibString.of('https://example.test'), Next: [script] }) : script;
  page.node.set(LibName.of('AA'), ctx.obj({ O: action }));
  return parsePDF(await pdf.save({ useObjectStreams: false }));
}

describe('indirect action type names', () => {
  it.each(['removeJavaScript', 'sanitize'] as const)('%s detects and removes an indirect /S name after saving and reopening', async mode => {
    const doc = await fixture(false);
    expect(engine.analyze(doc).hasJavaScript).toBe(true);
    if (mode === 'sanitize') {
      expect((await sanitizationEngine.sanitize(doc, onlyActions)).detail.javascriptRemoved).toBe(1);
    } else expect(engine.removeJavaScript(doc).removed).toBe(1);
    const output = await saveQuick(doc);
    expect(Buffer.from(output).toString('latin1')).not.toContain(marker);
    const reopened = await PDFDocument.load(output, { updateMetadata: false });
    expect(reopened.getPage(0).node.has(LibName.of('AA'))).toBe(false);
  });

  it('removes an indirect script in a retained action continuation', async () => {
    const doc = await fixture(true);
    expect(engine.analyze(doc).hasJavaScript).toBe(true);
    expect(engine.removeJavaScript(doc).removed).toBe(1);
    const output = await saveQuick(doc);
    expect(Buffer.from(output).toString('latin1')).not.toContain(marker);
    const reopened = await PDFDocument.load(output, { updateMetadata: false });
    const aa = reopened.getPage(0).node.lookup(LibName.of('AA'), LibDict);
    const uri = aa.lookup(LibName.of('O'), LibDict);
    expect(uri.lookup(LibName.of('S'), LibName).asString()).toBe('/URI');
    expect(uri.has(LibName.of('Next'))).toBe(false);
  });

  it.each(['missing', 'cyclic', 'wrong type'] as const)('rejects %s action types without changing an earlier script', async type => {
    const doc = await fixture(false);
    const ref = new PDFRef(9000, 0);
    if (type === 'cyclic') doc.objects.set(ref.toKey(), ref);
    if (type === 'wrong type') doc.objects.set(ref.toKey(), new PDFNumber(42));
    const malformed = new PDFDict([['S', ref]]);
    const aa = doc.pages[0].dict.getDict('AA')!;
    aa.set('C', malformed);
    const before = dehydrateDocument(doc);
    expect(() => engine.analyze(doc)).toThrow(/action type/i);
    expect(() => engine.removeJavaScript(doc)).toThrow(/action type/i);
    expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
    await expect(sanitizationEngine.sanitize(doc, onlyActions)).rejects.toThrow(/action type/i);
    expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
  });

  it.each(['Launch', 'SubmitForm'] as const)('detects and sanitizes an indirect %s action', async action => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    const ctx = pdf.context;
    const kind = ctx.register(LibName.of(action));
    page.node.set(LibName.of('AA'), ctx.obj({ O: { S: kind, F: LibString.of('example') } }));
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    expect(engine.analyze(doc).actions.some(item => item.kind === action)).toBe(true);
    expect((await sanitizationEngine.sanitize(doc, onlyActions)).detail.javascriptRemoved).toBe(1);
    const reopened = await PDFDocument.load(await saveQuick(doc), { updateMetadata: false });
    expect(reopened.getPage(0).node.has(LibName.of('AA'))).toBe(false);
  });

  it('rejects a malformed 3D subtype without changing an earlier script', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    const ctx = pdf.context;
    page.node.set(LibName.of('AA'), ctx.obj({ O: { S: 'JavaScript', JS: LibString.of('hello') } }));
    const subtype = ctx.register(LibName.of('3D'));
    const artwork = ctx.register(ctx.stream('U3D', { OnInstantiate: ctx.stream('noop') }));
    const annotation = ctx.register(ctx.obj({ Type: 'Annot', Subtype: subtype, Rect: [0, 0, 50, 50], '3DD': artwork }));
    page.node.set(LibName.of('Annots'), ctx.obj([annotation]));
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    const annotations = doc.pages[0].dict.getArray('Annots')!;
    const annot = doc.objects.get((annotations.get(0) as PDFRef).toKey()) as PDFDict;
    annot.set('Subtype', new PDFNumber(7));
    const before = await serializeDocument(doc);
    expect(() => engine.analyze(doc)).toThrow(/subtype/i);
    expect(() => engine.removeJavaScript(doc)).toThrow(/subtype/i);
    await expect(sanitizationEngine.sanitize(doc, onlyActions)).rejects.toThrow(/subtype/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('preserves a real signed document when cleanup would remove an indirect action', async () => {
    const doc = await fixture(false);
    const field = createSignatureField(doc, 0, { x: 20, y: 20, width: 100, height: 40 }, 'Signer');
    await installSignatureBase(doc, await serializeDocument(doc));
    const credentials = getTestCredentials();
    const bundle = await importFromPem(credentials.pem, 'test');
    const signed = await signDocumentCryptographic(doc, field, bundle.key!.privateKey, {
      certificateDer: bundle.leaf!.der, hashAlgorithm: 'sha256', contentsSize: 4096, enableTimestamp: false,
    });
    const reopened = await parsePDF(signed.bytes);
    const before = dehydrateDocument(reopened);
    expect(engine.analyze(reopened).hasJavaScript).toBe(true);
    expect(() => engine.removeJavaScript(reopened)).toThrow(/signed|signature/i);
    await expect(sanitizationEngine.sanitize(reopened, onlyActions)).rejects.toThrow(/signed|signature/i);
    expect(sameDocumentSnapshot(before, dehydrateDocument(reopened))).toBe(true);
    expect(await saveQuick(reopened)).toEqual(signed.bytes);
    const report = await validateDocumentSignatures(reopened, { allowSelfSigned: true });
    expect(report.signatures.some(item => item.digestMatch && item.cmsSignatureOk === true)).toBe(true);
  }, 30000);

  it('removes 3D scripts when the annotation subtype is an indirect name', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([200, 200]);
    const ctx = pdf.context;
    const subtype = ctx.register(LibName.of('3D'));
    const script = ctx.register(ctx.stream('app.alert("3D_PRIVATE_16")'));
    const artwork = ctx.register(ctx.stream('U3D', { Type: '3D', Subtype: 'U3D', OnInstantiate: script }));
    const annot = ctx.register(ctx.obj({ Type: 'Annot', Subtype: subtype, Rect: [0, 0, 50, 50], '3DD': artwork }));
    page.node.set(LibName.of('Annots'), ctx.obj([annot]));
    const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
    expect(engine.analyze(doc).hasJavaScript).toBe(true);
    expect(engine.removeJavaScript(doc).removed).toBe(1);
    const bytes = await saveQuick(doc);
    expect(Buffer.from(bytes).toString('latin1')).not.toContain('3D_PRIVATE_16');
    const reopened = await PDFDocument.load(bytes, { updateMetadata: false });
    const annotations = reopened.getPage(0).node.lookup(LibName.of('Annots'));
    expect(annotations).toBeDefined();
  });
});
