import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parsePDF } from '../../parser/parser';
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFRef } from '../../types';
import { dehydrateDocument } from '../../worker/codec';
import { extractPages } from '../../writer/page-operations';
import { hasDocumentSignature, saveQuick } from '../../writer/save-pipeline';

const source = new URL('./fixtures/irs-w9-2024.pdf', import.meta.url);
const digest = '2d420cbb4123dcf1fb82595b2359cfbb5d81f00b9df9d359fcc7af361d093f53';
const openssl = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;
const qpdf = spawnSync('qpdf', ['--version'], { stdio: 'ignore' }).status === 0;

describe('IRS W-9 real PDF corpus', () => {
  it('preserves the usage-rights signature and rejects destructive edits', async () => {
    const bytes = readFileSync(source);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(digest);
    const doc = await parsePDF(bytes);
    expect(doc.pages).toHaveLength(6);
    const formRef = doc.catalog.get('AcroForm');
    const form = formRef instanceof PDFRef ? doc.objects.get(formRef.toKey()) : formRef;
    expect(form).toBeInstanceOf(PDFDict);
    expect((form as PDFDict).has('XFA')).toBe(true);
    expect(hasDocumentSignature(doc)).toBe(true);
    const permsRef = doc.catalog.get('Perms');
    const perms = permsRef instanceof PDFRef ? doc.objects.get(permsRef.toKey()) : permsRef;
    expect(perms).toBeInstanceOf(PDFDict);
    expect((perms as PDFDict).has('UR3')).toBe(true);
    const signature = doc.objects.get('1075_0') as PDFDict;
    expect(signature.getName('Type')).toBe('Sig');
    expect((signature.get('ByteRange') as PDFArray).asNumbers()).toEqual([0, 127526, 139796, 1019]);
    expect(signature.get('Contents')).toBeInstanceOf(PDFHexString);
    expect(Buffer.from(await saveQuick(doc))).toEqual(bytes);
    const snapshot = dehydrateDocument(doc);
    expect(() => extractPages(doc, [0])).toThrow(/signed/i);
    expect(dehydrateDocument(doc)).toEqual(snapshot);
    expect((await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount()).toBe(6);
    doc.catalog.set('PaperloomTestEdit', new PDFName('Pending'));
    await expect(saveQuick(doc)).rejects.toThrow(/signed/i);
    expect(doc.catalog.getName('PaperloomTestEdit')).toBe('Pending');
    expect(Buffer.from(doc.rawBytes)).toEqual(bytes);
  }, 20_000);

  it.skipIf(!qpdf)('passes independent PDF syntax checks', () => {
    expect(() => execFileSync('qpdf', ['--check', fileURLToPath(source)], { stdio: 'ignore' })).not.toThrow();
  });

  it.skipIf(!openssl)('verifies the original usage-rights CMS and rejects tampering', () => {
    const bytes = readFileSync(source);
    const gap = bytes.subarray(127526, 139796);
    expect(gap[0]).toBe(0x3c);
    expect(gap[gap.length - 1]).toBe(0x3e);
    const cms = Buffer.from(gap.subarray(1, -1).toString('ascii'), 'hex');
    const content = Buffer.concat([bytes.subarray(0, 127526), bytes.subarray(139796)]);
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-irs-w9-'));
    try {
      const sigPath = join(dir, 'sig.der'), contentPath = join(dir, 'content.bin'), outputPath = join(dir, 'out.bin');
      writeFileSync(sigPath, cms); writeFileSync(contentPath, content);
      const verify = () => execFileSync('openssl', ['cms', '-verify', '-binary', '-inform', 'DER', '-in', sigPath,
        '-content', contentPath, '-noverify', '-out', outputPath], { stdio: 'ignore' });
      expect(() => verify()).not.toThrow();
      content[0] ^= 1;
      writeFileSync(contentPath, content);
      expect(() => verify()).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
