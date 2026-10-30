import { PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';
import { PDFArray, PDFDict, PDFHexString as EngineHexString, PDFRef } from '../types';
import { finalizeSignatureOnDocument } from '../signatures/crypto/finalizer';
import { importFromPem } from '../signatures';
import { getTestCredentials } from './signatures/test-credentials';

it('finalizes a uniquely identifiable signature without an explicit optional sigRef', async () => {
  const pdf = await PDFDocument.create(); const page = pdf.addPage([200, 200]);
  const sig = pdf.context.obj({ Type: 'Sig', ByteRange: [0, 9999999999, 9999999999, 9999999999], Contents: PDFHexString.of('0'.repeat(8192)) });
  const pdfRef = pdf.context.register(sig);
  const widget = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig',
    T: PDFString.of('Signature'), Rect: [20, 20, 100, 60], P: page.ref, V: pdfRef, F: 4 }));
  page.node.set(PDFName.of('Annots'), pdf.context.obj([widget]));
  pdf.catalog.set(PDFName.of('AcroForm'), pdf.context.register(pdf.context.obj({ Fields: [widget], SigFlags: 3 })));
  const bytes = await pdf.save({ useObjectStreams: false });
  const doc = await parsePDF(bytes);
  const credentials = getTestCredentials();
  const keys = await importFromPem(credentials.pem, 'test');
  const result = await finalizeSignatureOnDocument(doc, bytes, keys.key!.privateKey,
    { contentsSize: 4096, certificateDer: credentials.certificateDer });
  expect(result.validation.ok).toBe(true);
  expect(result.byteRangePatched).toBe(true);
  expect(doc.rawBytes).toEqual(result.bytes);
  const current = doc.objects.get(new PDFRef(pdfRef.objectNumber, pdfRef.generationNumber).toKey()) as PDFDict;
  expect(current.get('ByteRange')).toBeInstanceOf(PDFArray);
  expect((current.get('Contents') as EngineHexString).toBytes().slice(0, result.cms.length)).toEqual(result.cms);
  const dir = mkdtempSync(join(tmpdir(), 'paperloom-finalizer-audit-'));
  try {
    const saved = join(dir, 'signed.pdf'), cms = join(dir, 'signature.der'), data = join(dir, 'content.bin');
    writeFileSync(saved, result.bytes); writeFileSync(cms, result.cms);
    const [a, b, c, d] = result.byteRange;
    writeFileSync(data, Buffer.concat([Buffer.from(result.bytes.slice(a, a + b)), Buffer.from(result.bytes.slice(c, c + d))]));
    if (!spawnSync('qpdf', ['--version'], { stdio: 'ignore' }).error || process.env.CI === 'true' || process.env.CI === '1') {
      execFileSync('qpdf', ['--check', saved], { stdio: 'ignore' });
    }
    execFileSync('openssl', ['cms', '-verify', '-inform', 'DER', '-in', cms, '-content', data, '-binary', '-noverify'], { stdio: 'ignore' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
