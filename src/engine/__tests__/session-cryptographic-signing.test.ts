import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PDFDict, PDFName, PDFRef, PDFString, type PDFDocumentData } from '../types';
import { createVisualSignature } from '../signatures/visual/signature-model';
import { findVisualSignatureRefs } from '../session/signature-edit';
import { assertSignatureFieldIdentityAllowed } from '@/app/editor/signature-change';
import { getPageContentBytes, parsePDF } from '../parser/parser';
import { SessionDocumentEditor } from '../session/document-edit';
import { signDocumentTransaction } from '../session/signature-transaction';
import { SessionEditorHistory } from '../session/editor-history';
import { captureHistoryEntry, restoreDocumentStructure } from '../editing/editor-history';
import { updatePageContent } from '../editor/stream-compiler';
import { securityEngine } from '../security';
import { createSignatureFieldAtPoint, detectSignatureFieldsOnPage, importFromPem, signDocumentCryptographic } from '../signatures';
import { saveQuick } from '../writer/save-pipeline';
import { getTestCredentials } from './signatures/test-credentials';
import { rawPDF } from './audit-p1-fixtures';

async function document(): Promise<PDFDocumentData> {
  return parsePDF(rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 240] /Resources << >> >>',
  ]));
}

describe('signature byte transactions', () => {
  it('restores signed revisions and independently verifies two signatures', async () => {
    const doc = await document();
    const objects = doc.objects;
    const original = doc.rawBytes.slice();
    const credentials = getTestCredentials();
    const imported = await importFromPem(credentials.pem, 'test');
    const results: Awaited<ReturnType<typeof signDocumentCryptographic>>[] = [];
    const editors: SessionDocumentEditor[] = [];
    for (let index = 0; index < 2; index++) {
      const signed = await signDocumentTransaction(doc, {
        pageIndex: 0, selectedFieldId: null, point: { x: 30 + index * 100, y: 120 },
        privateKey: imported.key!.privateKey, signOptions: { certificateDer: credentials.certificateDer }, isCurrent: () => true,
      });
      results.push(signed.result);
      editors.push(signed.editor);
      expect(doc.objects).toBe(objects);
      expect(doc.rawBytes).toEqual(results[index].bytes);
      expect(detectSignatureFieldsOnPage(await parsePDF(doc.rawBytes), 0)).toHaveLength(index + 1);
      expect(await saveQuick(doc)).toEqual(results[index].bytes);
    }
    expect(results[1].bytes.slice(0, results[0].bytes.length)).toEqual(results[0].bytes);
    const directory = mkdtempSync(join(tmpdir(), 'paperloom-signature-'));
    const signaturePath = join(directory, 'signature.der');
    const contentPath = join(directory, 'content.bin');
    try {
      for (const result of results) {
        const [start1, length1, start2, length2] = result.byteRange;
        writeFileSync(signaturePath, result.cms);
        writeFileSync(contentPath, Buffer.concat([
          Buffer.from(result.bytes.slice(start1, start1 + length1)),
          Buffer.from(result.bytes.slice(start2, start2 + length2)),
        ]));
        const verified = spawnSync('openssl', ['cms', '-verify', '-inform', 'DER', '-in', signaturePath, '-content', contentPath, '-binary', '-noverify'], { encoding: 'utf8' });
        expect(verified.error).toBeUndefined();
        expect(verified.status).toBe(0);
      }
    } finally {
      unlinkSync(signaturePath);
      unlinkSync(contentPath);
      rmdirSync(directory);
    }
    expect(await editors[1].undo(doc)).toBe(true);
    expect(doc.rawBytes).toEqual(results[0].bytes);
    expect(detectSignatureFieldsOnPage(doc, 0)).toHaveLength(1);
    expect(await saveQuick(doc)).toEqual(results[0].bytes);
    expect(await editors[0].undo(doc)).toBe(true);
    expect(doc.rawBytes).toEqual(original);
    expect(detectSignatureFieldsOnPage(doc, 0)).toHaveLength(0);
    expect(await editors[0].redo(doc)).toBe(true);
    expect(doc.rawBytes).toEqual(results[0].bytes);
    expect(await editors[1].redo(doc)).toBe(true);
    expect(doc.rawBytes).toEqual(results[1].bytes);
    expect(detectSignatureFieldsOnPage(doc, 0)).toHaveLength(2);
    expect(await saveQuick(doc)).toEqual(results[1].bytes);
    expect(doc.objects).toBe(objects);
    expect((await parsePDF(doc.rawBytes)).pages).toHaveLength(1);
  }, 30000);

  it('discards a failed signing operation without publishing a field or bytes', async () => {
    const doc = await document();
    const before = doc.rawBytes.slice();
    const originalSize = doc.objects.size;
    const key = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const editor = new SessionDocumentEditor();
    await expect(editor.edit(doc, 'sign', async staged => {
      const field = createSignatureFieldAtPoint(staged, 0, 30, 120);
      await signDocumentCryptographic(staged, field.ref, key.publicKey);
    }, { includeRawBytes: true })).rejects.toThrow();
    expect(doc.rawBytes).toEqual(before);
    expect(doc.objects.size).toBe(originalSize);
    expect(doc.catalog.get('AcroForm')).toBeUndefined();
    expect(editor.canUndo).toBe(false);
  });

  it('does not publish a successful signature after the document is replaced', async () => {
    const doc = await document();
    const before = doc.rawBytes.slice();
    const credentials = getTestCredentials();
    const imported = await importFromPem(credentials.pem, 'test');
    let checks = 0;
    await expect(signDocumentTransaction(doc, {
      pageIndex: 0, selectedFieldId: null, point: { x: 30, y: 120 },
      privateKey: imported.key!.privateKey, signOptions: { certificateDer: credentials.certificateDer },
      isCurrent: () => ++checks === 1,
    })).rejects.toThrow('Document changed');
    expect(doc.rawBytes).toEqual(before);
    expect(detectSignatureFieldsOnPage(doc, 0)).toHaveLength(0);
  }, 30000);

  it('includes prior edits and signs an existing field', async () => {
    const doc = await document();
    const field = createSignatureFieldAtPoint(doc, 0, 30, 120);
    doc.catalog.set('PriorEdit', new PDFName('Present'));
    const credentials = getTestCredentials();
    const imported = await importFromPem(credentials.pem, 'test');
    const signed = await signDocumentTransaction(doc, {
      pageIndex: 0, selectedFieldId: field.id, point: { x: 0, y: 0 },
      privateKey: imported.key!.privateKey, signOptions: { certificateDer: credentials.certificateDer }, isCurrent: () => true,
    });
    const reopened = await parsePDF(signed.result.bytes);
    expect(reopened.catalog.getName('PriorEdit')).toBe('Present');
    const fields = detectSignatureFieldsOnPage(reopened, 0);
    expect(fields).toHaveLength(1);
    expect(fields[0].signed).toBe(true);
    expect(fields[0].id).toBe(field.id);
  }, 30000);

  it('downloads a signed PDF that was created with object streams', async () => {
    const source = await PDFDocument.create();
    const page = source.addPage([612, 792]);
    page.drawText('Synthetic signing test', { x: 70, y: 700, font: await source.embedFont(StandardFonts.Helvetica) });
    const doc = await parsePDF(await source.save());
    const credentials = getTestCredentials();
    const imported = await importFromPem(credentials.pem, 'test');
    const signed = await signDocumentTransaction(doc, {
      pageIndex: 0, selectedFieldId: null, point: { x: 30, y: 120 },
      privateKey: imported.key!.privateKey, signOptions: { certificateDer: credentials.certificateDer }, isCurrent: () => true,
    });
    expect(await saveQuick(doc)).toEqual(signed.result.bytes);
    const second = await signDocumentTransaction(doc, {
      pageIndex: 0, selectedFieldId: null, point: { x: 150, y: 120 },
      privateKey: imported.key!.privateKey, signOptions: { certificateDer: credentials.certificateDer }, isCurrent: () => true,
    });
    expect(second.result.bytes.slice(0, signed.result.bytes.length)).toEqual(signed.result.bytes);
    expect(await saveQuick(doc)).toEqual(second.result.bytes);
    expect(await second.editor.undo(doc)).toBe(true);
    expect(await saveQuick(doc)).toEqual(signed.result.bytes);
    expect(await second.editor.redo(doc)).toBe(true);
    expect(await saveQuick(doc)).toEqual(second.result.bytes);
  }, 30000);

  it('makes field creation and signing one toolbar history step', async () => {
    const doc = await document();
    const original = doc.rawBytes.slice();
    const history = new SessionEditorHistory();
    const capture = (label: string) => captureHistoryEntry(doc, 0, getPageContentBytes(doc.pages[0], doc.objects),
      { drawnPaths: [], floatingTexts: [], floatingImages: [], signatures: [] }, label);
    history.seed(capture('initial'));
    const credentials = getTestCredentials();
    const imported = await importFromPem(credentials.pem, 'test');
    const signed = await signDocumentTransaction(doc, {
      pageIndex: 0, selectedFieldId: null, point: { x: 30, y: 120 },
      privateKey: imported.key!.privateKey, signOptions: { certificateDer: credentials.certificateDer }, isCurrent: () => true,
    });
    history.push(capture('digital-sign'), signed.editor);
    expect((await history.undo(doc))?.entry.label).toBe('initial');
    expect(doc.rawBytes).toEqual(original);
    expect(detectSignatureFieldsOnPage(doc, 0)).toHaveLength(0);
    expect(history.canUndo()).toBe(false);
    expect((await history.redo(doc))?.entry.label).toBe('digital-sign');
    expect(doc.rawBytes).toEqual(signed.result.bytes);
    expect(detectSignatureFieldsOnPage(doc, 0)[0]?.signed).toBe(true);
    expect(await saveQuick(doc)).toEqual(signed.result.bytes);
  }, 30000);

  it('restores complete signed bytes through atomic toolbar history', async () => {
    const doc = await document();
    const original = doc.rawBytes.slice();
    const history = new SessionEditorHistory();
    const capture = (label: string) => captureHistoryEntry(doc, 0, getPageContentBytes(doc.pages[0], doc.objects),
      { drawnPaths: [], floatingTexts: [], floatingImages: [], signatures: [] }, label);
    history.seed(capture('initial'));
    const credentials = getTestCredentials();
    const imported = await importFromPem(credentials.pem, 'test');
    const signed = await signDocumentTransaction(doc, {
      pageIndex: 0, selectedFieldId: null, point: { x: 30, y: 120 },
      privateKey: imported.key!.privateKey, signOptions: { certificateDer: credentials.certificateDer }, isCurrent: () => true,
    });
    history.push(capture('digital-sign'), signed.editor);
    const options = { isCurrent: () => true, applyLegacy: (draft: PDFDocumentData, entry: ReturnType<typeof capture>) => restoreDocumentStructure(draft, entry, updatePageContent) };
    expect((await history.moveAtomic(doc, 'undo', options))?.entry.label).toBe('initial');
    expect(doc.rawBytes).toEqual(original);
    expect(detectSignatureFieldsOnPage(doc, 0)).toHaveLength(0);
    expect((await history.moveAtomic(doc, 'redo', options))?.entry.label).toBe('digital-sign');
    expect(doc.rawBytes).toEqual(signed.result.bytes);
    expect(detectSignatureFieldsOnPage(doc, 0)[0]?.signed).toBe(true);
    expect(await saveQuick(doc)).toEqual(signed.result.bytes);
  }, 30000);

  it('undoes and redoes two signed revisions through atomic toolbar history', async () => {
    const doc = await document();
    const original = doc.rawBytes.slice();
    const history = new SessionEditorHistory();
    const capture = (label: string) => captureHistoryEntry(doc, 0, getPageContentBytes(doc.pages[0], doc.objects),
      { drawnPaths: [], floatingTexts: [], floatingImages: [], signatures: [] }, label);
    history.seed(capture('initial'));
    const credentials = getTestCredentials();
    const imported = await importFromPem(credentials.pem, 'test');
    const revisions: Uint8Array[] = [];
    for (let index = 0; index < 2; index++) {
      const signed = await signDocumentTransaction(doc, {
        pageIndex: 0, selectedFieldId: null, point: { x: 30 + index * 100, y: 120 },
        privateKey: imported.key!.privateKey, signOptions: { certificateDer: credentials.certificateDer }, isCurrent: () => true,
      });
      revisions.push(signed.result.bytes);
      history.push(capture(`sign-${index}`), signed.editor);
    }
    const options = { isCurrent: () => true, applyLegacy: (draft: PDFDocumentData, entry: ReturnType<typeof capture>) => restoreDocumentStructure(draft, entry, updatePageContent) };
    await history.moveAtomic(doc, 'undo', options);
    expect(doc.rawBytes).toEqual(revisions[0]);
    expect(await saveQuick(doc)).toEqual(revisions[0]);
    await history.moveAtomic(doc, 'undo', options);
    expect(doc.rawBytes).toEqual(original);
    await history.moveAtomic(doc, 'redo', options);
    expect(doc.rawBytes).toEqual(revisions[0]);
    await history.moveAtomic(doc, 'redo', options);
    expect(doc.rawBytes).toEqual(revisions[1]);
    expect(await saveQuick(doc)).toEqual(revisions[1]);
  }, 30000);

  it('restores two atomic signatures from object-stream input', async () => {
    const source = await PDFDocument.create();
    source.addPage([200, 200]).drawText('Object-stream test');
    const doc = await parsePDF(await source.save());
    const original = doc.rawBytes.slice();
    const history = new SessionEditorHistory();
    const capture = (label: string) => captureHistoryEntry(doc, 0, getPageContentBytes(doc.pages[0], doc.objects),
      { drawnPaths: [], floatingTexts: [], floatingImages: [], signatures: [] }, label);
    history.seed(capture('initial'));
    const credentials = getTestCredentials();
    const imported = await importFromPem(credentials.pem, 'test');
    const revisions: Uint8Array[] = [];
    for (let index = 0; index < 2; index++) {
      const signed = await signDocumentTransaction(doc, {
        pageIndex: 0, selectedFieldId: null, point: { x: 30 + index * 100, y: 120 },
        privateKey: imported.key!.privateKey, signOptions: { certificateDer: credentials.certificateDer }, isCurrent: () => true,
      });
      revisions.push(signed.result.bytes);
      history.push(capture(`sign-${index}`), signed.editor);
    }
    const options = { isCurrent: () => true, applyLegacy: (draft: PDFDocumentData, entry: ReturnType<typeof capture>) => restoreDocumentStructure(draft, entry, updatePageContent) };
    await history.moveAtomic(doc, 'undo', options);
    expect(await saveQuick(doc)).toEqual(revisions[0]);
    await history.moveAtomic(doc, 'undo', options);
    expect(doc.rawBytes).toEqual(original);
    await history.moveAtomic(doc, 'redo', options);
    expect(await saveQuick(doc)).toEqual(revisions[0]);
    await history.moveAtomic(doc, 'redo', options);
    expect(await saveQuick(doc)).toEqual(revisions[1]);
  }, 30000);

  it('rejects an opened encrypted document without changing it', async () => {
    const bytes = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'encrypted', 'aes-256-r6.pdf')));
    const parsed = await parsePDF(bytes);
    const doc = (await securityEngine.open(parsed, 'userpass')).doc;
    const before = doc.rawBytes.slice();
    const credentials = getTestCredentials();
    const imported = await importFromPem(credentials.pem, 'test');
    await expect(signDocumentTransaction(doc, {
      pageIndex: 0, selectedFieldId: null, point: { x: 30, y: 120 },
      privateKey: imported.key!.privateKey, signOptions: {}, isCurrent: () => true,
    })).rejects.toThrow('encrypted documents');
    expect(doc.rawBytes).toEqual(before);
    expect(doc.decryptedFromEncrypted).toBe(true);
    expect(doc.xref.trailerDict.getRef('Encrypt')).toBeDefined();
  }, 30000);

  it.each(['graph', 'bytes', 'document'] as const)('rejects a concurrent %s change', async change => {
    const doc = await document();
    const original = doc.rawBytes.slice();
    const replacement = new Uint8Array([1, 2, 3]);
    let current = true;
    const editor = new SessionDocumentEditor();
    await expect(editor.edit(doc, 'sign', async staged => {
      staged.catalog.set('StagedOnly', new PDFName('Yes'));
      staged.rawBytes = new Uint8Array([4, 5, 6]);
      if (change === 'graph') doc.catalog.set('Concurrent', new PDFName('Yes'));
      if (change === 'bytes') doc.rawBytes = replacement;
      if (change === 'document') current = false;
    }, { includeRawBytes: true, isCurrent: () => current })).rejects.toThrow('Document changed');
    expect(doc.catalog.get('StagedOnly')).toBeUndefined();
    expect(doc.rawBytes).toEqual(change === 'bytes' ? replacement : original);
    if (change === 'graph') expect(doc.catalog.get('Concurrent')).toBeInstanceOf(PDFName);
    expect(editor.canUndo).toBe(false);
  });
});


describe('locked visual signature during digital signing', () => {
  for (const selection of ['explicit', 'automatic'] as const) it(`refuses the ${selection} field without modifying bytes or appearance`, async () => {
    const doc = await document();
    const field = createSignatureFieldAtPoint(doc, 0, 30, 120, { withPlaceholderAppearance: true });
    const locked = createVisualSignature({ pageIndex: 0, x: 500, y: 500, appearanceId: 'test', appearanceType: 'typed', locked: true });
    const widget = doc.objects.get(field.ref.toKey());
    if (!(widget instanceof PDFDict)) throw new Error('Missing test Widget');
    widget.set('PaperloomSignatureId', new PDFString(locked.id));
    const rawBefore = doc.rawBytes.slice(), before = await saveQuick(doc), ap = widget.get('AP'), size = doc.objects.size;
    const credentials = getTestCredentials();
    const imported = await importFromPem(credentials.pem, 'test');
    const guard = (staged: PDFDocumentData, chosen: typeof field) => assertSignatureFieldIdentityAllowed(
      [locked], chosen.ref, findVisualSignatureRefs(staged, new Set([locked.id])));
    await expect(signDocumentTransaction(doc, { pageIndex: 0, selectedFieldId: selection === 'explicit' ? field.id : null,
      point: { x: 0, y: 0 }, privateKey: imported.key!.privateKey, signOptions: { certificateDer: credentials.certificateDer },
      isCurrent: () => true, assertFieldAllowed: guard })).rejects.toThrow(/unlock/i);
    expect(doc.rawBytes).toEqual(rawBefore);
    expect(doc.objects.size).toBe(size);
    expect(widget.get('AP')).toBe(ap);
    expect(widget.get('V')).toBeUndefined();
    expect(await saveQuick(doc)).toEqual(before);
    const signed = await signDocumentTransaction(doc, { pageIndex: 0, selectedFieldId: field.id, point: { x: 0, y: 0 },
      privateKey: imported.key!.privateKey, signOptions: { certificateDer: credentials.certificateDer }, isCurrent: () => true,
      assertFieldAllowed: (staged, chosen) => assertSignatureFieldIdentityAllowed([{ ...locked, locked: false }],
        chosen.ref, findVisualSignatureRefs(staged, new Set([locked.id]))) });
    expect(detectSignatureFieldsOnPage(await parsePDF(signed.result.bytes), 0)[0].signed).toBe(true);
  }, 30000);
});


it('signs an independent field at the same coordinates as a locked Stamp', async () => {
  const doc = await document();
  const field = createSignatureFieldAtPoint(doc, 0, 30, 120, { withPlaceholderAppearance: true });
  const locked = { ...createVisualSignature({ pageIndex: 0, x: 30, y: 120, appearanceId: 'test', appearanceType: 'typed', locked: true }),
    x: field.rect.x, y: field.rect.y };
  const stampRef = new PDFRef(100, 0), stamp = new PDFDict();
  stamp.set('Type', new PDFName('Annot')); stamp.set('Subtype', new PDFName('Stamp')); stamp.set('NM', new PDFString(locked.id));
  const originalField = doc.objects.get(field.ref.toKey()) as PDFDict;
  stamp.set('Rect', originalField.get('Rect')!); stamp.set('AP', originalField.get('AP')!);
  doc.objects.set(stampRef.toKey(), stamp);
  doc.pages[0].dict.getArray('Annots')!.push(stampRef);
  const credentials = getTestCredentials(), imported = await importFromPem(credentials.pem, 'test');
  const result = await signDocumentTransaction(doc, { pageIndex: 0, selectedFieldId: field.id, point: { x: 30, y: 120 },
    privateKey: imported.key!.privateKey, signOptions: { certificateDer: credentials.certificateDer }, isCurrent: () => true,
    assertFieldAllowed: (staged, chosen) => assertSignatureFieldIdentityAllowed([locked], chosen.ref,
      findVisualSignatureRefs(staged, new Set([locked.id]))) });
  const reopened = await parsePDF(result.result.bytes);
  expect(detectSignatureFieldsOnPage(reopened, 0)[0].signed).toBe(true);
  const savedStamp = findVisualSignatureRefs(reopened, new Set([locked.id])).get(locked.id);
  expect(savedStamp?.toKey()).toBe(stampRef.toKey());
  const saved = reopened.objects.get(stampRef.toKey()) as PDFDict;
  expect(saved.getName('Subtype')).toBe('Stamp');
  expect(saved.get('AP')).toBeDefined();
  expect(saved.getArray('Rect')?.asNumbers()).toEqual(stamp.getArray('Rect')?.asNumbers());
}, 30000);
