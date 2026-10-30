import { PDFDocument } from 'pdf-lib';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';
import { embedDssIncremental } from '../signatures/ltv/dss-builder';
import { importFromPem } from '../signatures';
import { signDocumentTransaction } from '../session/signature-transaction';
import { getTestCredentials } from './signatures/test-credentials';
import { dehydrateDocument, sameDocumentSnapshot } from '../worker/codec';

it('does not alter the graph if a stale xref proof blocks DSS embedding', async () => {
  const source = await PDFDocument.create(); source.addPage([200, 200]);
  const doc = await parsePDF(await source.save({ useObjectStreams: false }));
  doc.rawBytes[15] ^= 1;
  const before = dehydrateDocument(doc);
  expect(() => embedDssIncremental(doc, { certificates: [new Uint8Array([1, 2, 3])] })).toThrow();
  expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
});

it('preserves a genuine signature and rejects a stale xref without changing the signed document', async () => {
  const source = await PDFDocument.create(); source.addPage([200, 200]);
  const doc = await parsePDF(await source.save({ useObjectStreams: false }));
  const credentials = getTestCredentials();
  const imported = await importFromPem(credentials.pem, 'test');
  const signed = await signDocumentTransaction(doc, { pageIndex: 0, selectedFieldId: null,
    point: { x: 30, y: 100 }, privateKey: imported.key!.privateKey,
    signOptions: { certificateDer: credentials.certificateDer }, isCurrent: () => true });
  const original = new Uint8Array(doc.rawBytes);
  const output = embedDssIncremental(doc, { certificates: [credentials.certificateDer] });
  expect(output.bytes.slice(0, original.length)).toEqual(original);
  expect((await parsePDF(output.bytes)).catalog.has('DSS')).toBe(true);
  const dir = mkdtempSync(join(tmpdir(), 'paperloom-dss-audit-'));
  try {
    const pdf = join(dir, 'signed.pdf'), cms = join(dir, 'signature.der'), data = join(dir, 'content.bin');
    writeFileSync(pdf, output.bytes); writeFileSync(cms, signed.result.cms);
    const [a, b, c, d] = signed.result.byteRange;
    writeFileSync(data, Buffer.concat([Buffer.from(output.bytes.slice(a, a + b)), Buffer.from(output.bytes.slice(c, c + d))]));
    if (!spawnSync('qpdf', ['--version'], { stdio: 'ignore' }).error || process.env.CI === 'true' || process.env.CI === '1') {
      execFileSync('qpdf', ['--check', pdf], { stdio: 'ignore' });
    }
    execFileSync('openssl', ['cms', '-verify', '-inform', 'DER', '-in', cms, '-content', data, '-binary', '-noverify'], { stdio: 'ignore' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const entry = [...doc.xref.entries.values()].find(value => value.type === 'n')!;
  entry.offset += 1;
  const before = dehydrateDocument(doc);
  expect(() => embedDssIncremental(doc, { certificates: [credentials.certificateDer] })).toThrow();
  expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
}, 30_000);
