import { describe, expect, it, vi } from 'vitest';
import { PDFName } from '../../types';
import { parsePDF } from '../../parser/parser';
import { assertXrefProvenanceAsync } from '../../parser/xref-provenance';
import { dehydrateDocument } from '../../worker/codec';
import { createSignatureFieldAtPoint, importFromPem, signDocumentCryptographic } from '../../signatures';
import * as finalizer from '../../signatures/crypto/finalizer';
import { rawPDF } from '../audit-p1-fixtures';
import { getTestCredentials } from './test-credentials';

async function fixture() {
  const doc = await parsePDF(rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 240] /Resources << >> >>',
  ]));
  const field = createSignatureFieldAtPoint(doc, 0, 30, 120);
  const credentials = getTestCredentials();
  const imported = await importFromPem(credentials.pem, 'test');
  return { doc, field, key: imported.key!.privateKey, credentials };
}

describe('signing cross-reference provenance', () => {
  it('binds the published xref to the finalized bytes', async () => {
    const { doc, field, key, credentials } = await fixture();
    const result = await signDocumentCryptographic(doc, field.ref, key, { certificateDer: credentials.certificateDer });
    expect(doc.rawBytes).toEqual(result.bytes);
    expect(await assertXrefProvenanceAsync(doc.rawBytes, doc.xref)).toBe(true);
    const reopened = await parsePDF(result.bytes);
    expect(reopened.objects.get(result.sigRef.toKey())).toBeDefined();
    for (const key of ['Size', 'Prev', 'XRefStm']) {
      expect(doc.xref.trailerDict.getNumber(key)).toBe(reopened.xref.trailerDict.getNumber(key));
    }
  });

  it.each(['bytes', 'xref'] as const)('rejects altered source %s without publishing changes', async kind => {
    const { doc, field, key } = await fixture();
    if (kind === 'bytes') doc.rawBytes[10] ^= 1;
    else doc.xref.entries.values().next().value!.offset += 1;
    const before = dehydrateDocument(doc);
    await expect(signDocumentCryptographic(doc, field.ref, key)).rejects.toThrow(/xref|cross-reference/i);
    expect(dehydrateDocument(doc)).toEqual(before);
  });

  it('preserves a concurrent edit made while the signature is being finalized', async () => {
    const { doc, field, key } = await fixture();
    const raw = doc.rawBytes.slice();
    const original = finalizer.finalizePdfSignature;
    let arrived!: () => void;
    let release!: () => void;
    const reached = new Promise<void>(resolve => { arrived = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(finalizer, 'finalizePdfSignature').mockImplementation(async options => {
      arrived();
      await gate;
      return original(options);
    });
    try {
      const pending = signDocumentCryptographic(doc, field.ref, key);
      await reached;
      doc.catalog.set('Concurrent', new PDFName('Preserved'));
      release();
      await expect(pending).rejects.toThrow('Document changed');
      expect(doc.rawBytes).toEqual(raw);
      expect(doc.catalog.getName('Concurrent')).toBe('Preserved');
      expect((doc.objects.get(field.ref.toKey()) as import('../../types').PDFDict).get('V')).toBeUndefined();
    } finally {
      release();
      spy.mockRestore();
    }
  });
});
