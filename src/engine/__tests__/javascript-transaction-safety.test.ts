import { installSignatureBase } from '../signatures/crypto/signing-pipeline';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parsePDF } from '../parser/parser';
import { PDFArray, PDFDict, PDFName, PDFRef, PDFString } from '../types';
import { dehydrateDocument, sameDocumentSnapshot } from '../worker/codec';
import { javaScriptSecurityEngine as engine } from '../security/javascript/javascript-engine';
import { saveQuick } from '../writer/save-pipeline';
import { serializeDocument } from '../writer/serializer';
import { createSignatureField, importFromPem, signDocumentCryptographic, validateDocumentSignatures } from '../signatures';
import { getTestCredentials } from './signatures/test-credentials';

async function fixture() {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  return parsePDF(await pdf.save({ useObjectStreams: false }));
}
const action = (kind: string) => new PDFDict([['S', new PDFName(kind)]]);

describe('action cleanup transaction safety', () => {
  it('preserves a pre-existing empty continuation during incremental save', async () => {
    const source = await fixture();
    const open = action('GoTo');
    open.set('Next', new PDFArray());
    source.catalog.set('OpenAction', open);
    const doc = await parsePDF(await serializeDocument(source));
    const before = dehydrateDocument(doc);
    expect(engine.removeJavaScript(doc)).toEqual({ removed: 0, disabled: 0, locations: [] });
    expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
    expect(doc.requiresFullRewrite).toBeUndefined();
    const root = doc.xref.trailerDict.getRef('Root')!.toKey();
    const output = await saveQuick(doc, new Set([root]));
    expect(output.slice(0, doc.rawBytes.length)).toEqual(doc.rawBytes);
    expect((await parsePDF(output)).catalog.getDict('OpenAction')?.getArray('Next')?.length).toBe(0);
  });

  it('keeps a real signature valid when an empty continuation requires no cleanup', async () => {
    const doc = await fixture();
    const open = action('GoTo');
    open.set('Next', new PDFArray());
    doc.catalog.set('OpenAction', open);
    const field = createSignatureField(doc, 0, { x: 20, y: 20, width: 100, height: 40 }, 'Signer');
    await installSignatureBase(doc, await serializeDocument(doc));
    const credentials = getTestCredentials();
    const bundle = await importFromPem(credentials.pem, 'test');
    const signed = await signDocumentCryptographic(doc, field, bundle.key!.privateKey, {
      certificateDer: bundle.leaf!.der, hashAlgorithm: 'sha256', contentsSize: 4096, enableTimestamp: false,
    });
    const reopened = await parsePDF(signed.bytes);
    const before = dehydrateDocument(reopened);
    expect(engine.removeJavaScript(reopened)).toEqual({ removed: 0, disabled: 0, locations: [] });
    expect(sameDocumentSnapshot(before, dehydrateDocument(reopened))).toBe(true);
    expect(await saveQuick(reopened)).toEqual(signed.bytes);
    const report = await validateDocumentSignatures(reopened, { allowSelfSigned: true });
    expect(report.signatures.some(item => item.digestMatch && item.cmsSignatureOk === true)).toBe(true);
  }, 30000);

  it('preserves originally empty and cyclic shared arrays while removing newly emptied shared arrays', async () => {
    const doc = await fixture();
    const emptyRef = new PDFRef(9000, 0);
    const cyclicRef = new PDFRef(9001, 0);
    const dirtyRef = new PDFRef(9002, 0);
    doc.objects.set(emptyRef.toKey(), new PDFArray());
    doc.objects.set(cyclicRef.toKey(), new PDFArray([cyclicRef]));
    doc.objects.set(dirtyRef.toKey(), new PDFArray([action('JavaScript')]));
    const owners = [emptyRef, emptyRef, cyclicRef, cyclicRef, dirtyRef, dirtyRef].map(ref => {
      const owner = action('GoTo');
      owner.set('Next', ref);
      return owner;
    });
    doc.catalog.set('OpenAction', new PDFArray(owners));
    expect(engine.removeJavaScript(doc)).toEqual({
      removed: 1, disabled: 1, locations: ['Catalog.OpenAction[5].Next[0]'],
    });
    expect(owners.slice(0, 4).every(owner => owner.has('Next'))).toBe(true);
    expect(owners.slice(4).every(owner => !owner.has('Next'))).toBe(true);
    expect(doc.requiresFullRewrite).toBe(true);
  });

  it('removes early and deeply chained actions, then saves and reopens', async () => {
    const doc = await fixture();
    const leaf = action('JavaScript');
    leaf.set('JS', new PDFString('DEEP_PRIVATE_SCRIPT'));
    let next: PDFRef | PDFDict = leaf;
    for (let i = 0; i < 16_000; i++) {
      const ref = new PDFRef(10_000 + i, 0);
      doc.objects.set(ref.toKey(), new PDFDict([['S', new PDFName('GoTo')], ['Next', next]]));
      next = ref;
    }
    const early = action('JavaScript');
    early.set('JS', new PDFString('EARLY_PRIVATE_SCRIPT'));
    doc.catalog.set('AA', new PDFDict([['Early', early], ['Later', next]]));
    expect(engine.analyze(doc).hasJavaScript).toBe(true);
    expect(engine.removeJavaScript(doc).removed).toBe(2);
    const output = await saveQuick(doc);
    const serialized = new TextDecoder().decode(output);
    expect(serialized).not.toContain('EARLY_PRIVATE_SCRIPT');
    expect(serialized).not.toContain('DEEP_PRIVATE_SCRIPT');
    expect(engine.analyze(await parsePDF(output)).hasJavaScript).toBe(false);
    if (spawnSync('qpdf', ['--version'], { stdio: 'ignore' }).status === 0) {
      const dir = mkdtempSync(join(tmpdir(), 'paperloom-action-chain-'));
      try {
        const file = join(dir, 'output.pdf');
        writeFileSync(file, output);
        execFileSync('qpdf', ['--check', file], { stdio: 'ignore', timeout: 20_000 });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  }, 30000);

  it('leaves earlier actions and raw bytes unchanged when later work exceeds the budget', async () => {
    const doc = await fixture();
    const early = action('JavaScript');
    early.set('JS', new PDFString('EARLY_PRIVATE_SCRIPT'));
    const safe = action('GoTo');
    doc.catalog.set('AA', new PDFDict([
      ['Early', early], ['Later', new PDFArray(Array.from({ length: 100_001 }, () => safe))],
    ]));
    const before = dehydrateDocument(doc);
    expect(() => engine.removeJavaScript(doc)).toThrow(/inspection limit/i);
    expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
    expect(doc.requiresFullRewrite).toBeUndefined();
    expect(doc.catalog.getDict('AA')?.get('Early')).toBe(early);
  }, 30000);

  it('handles deeply nested field owners without stack overflow', async () => {
    const doc = await fixture();
    const root = new PDFDict();
    let current = root;
    for (let i = 0; i < 12_000; i++) {
      const child = new PDFDict();
      current.set('Kids', new PDFArray([child]));
      current = child;
    }
    const script = action('JavaScript');
    script.set('JS', new PDFString('DEEP_FIELD_SCRIPT'));
    current.set('AA', new PDFDict([['K', script]]));
    doc.catalog.set('AcroForm', new PDFDict([['Fields', new PDFArray([root])]]));
    expect(engine.analyze(doc).hasJavaScript).toBe(true);
    expect(engine.removeJavaScript(doc).removed).toBe(1);
    expect(current.has('AA')).toBe(false);
    expect(engine.analyze(doc).hasJavaScript).toBe(false);
  }, 30000);
});
