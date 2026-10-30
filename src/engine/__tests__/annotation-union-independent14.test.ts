import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFStream, PDFString } from '../types';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { prepareWholePageRedaction } from '../security/redaction/whole-page-redaction';
import { serializeDocument } from '../writer/serializer';
import { saveQuick } from '../writer/save-pipeline';

async function fixture(secret = 'ZQXJ') {
  const pdf = await PDFDocument.create(); pdf.addPage([200, 200]); pdf.addPage([200, 200]);
  const doc = await parsePDF(await pdf.save({useObjectStreams:false}));
  const info = doc.objects.get(doc.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;
  for (const key of [...info.keys()]) info.delete(key);
  const note = new PDFRef(900, 0), stream = new PDFRef(901, 0), page = doc.pages[0], other = doc.pages[1];
  doc.objects.set(note.toKey(), new PDFDict([['Subtype',new PDFName('Text')], ['Rect',new PDFArray([10,10,20,20].map(n => new PDFNumber(n)))], ['Contents',new PDFString(secret)]]));
  page.dict.set('Annots',new PDFArray([note]));
  const fonts = new PDFDict([['F1', new PDFDict([['Type',new PDFName('Font')], ['Subtype',new PDFName('Type1')], ['BaseFont',new PDFName('Helvetica')]])]]);
  other.resources.set('Font', fonts); other.dict.set('Resources',other.resources);
  const bytes = new TextEncoder().encode('BT /F1 12 Tf 10 50 Td (public) Tj ET');
  doc.objects.set(stream.toKey(), new PDFStream(new PDFDict([['Length',new PDFNumber(bytes.length)]]),bytes));
  other.dict.set('Contents',stream); other.contentRefs.push(stream);
  redactionEngine.markRegion(doc,0,{x:0,y:0,width:200,height:200});
  return { doc, info, page, other, stream };
}

const be = (s: string) => [...s].map(c => c.charCodeAt(0).toString(16).padStart(4,'0')).join('');

describe('independent annotation fragment union audit', () => {
  it('allows a harmless shared-character fixture while retaining the other page', async () => {
    const { doc } = await fixture('publicQZ');
    const original = await serializeDocument(doc);
    expect(prepareWholePageRedaction(doc).commit().annotationsRemoved).toBe(2);
    const saved = await saveQuick(doc);
    const reopened = await PDFDocument.load(saved);
    expect(reopened.getPageCount()).toBe(2);
    expect(reopened.getPage(0).node.Annots()).toBeUndefined();
    if (spawnSync('pdftotext',['-v'],{stdio:'ignore'}).status === 0 && spawnSync('pdftoppm',['-v'],{stdio:'ignore'}).status === 0) {
      const dir = mkdtempSync(join(tmpdir(),'paperloom-union-audit14-'));
      try {
        const old = join(dir,'before.pdf'), now = join(dir,'after.pdf'); writeFileSync(old,original); writeFileSync(now,saved);
        expect(execFileSync('pdftotext',[now,'-'],{encoding:'utf8'})).toContain('public');
        expect(execFileSync('pdftotext',[now,'-'],{encoding:'utf8'})).not.toContain('publicQZ');
        for (const dpi of [72,150]) {
          execFileSync('pdftoppm',['-f','2','-l','2','-singlefile','-r',String(dpi),old,join(dir,`old-${dpi}`)]);
          execFileSync('pdftoppm',['-f','2','-l','2','-singlefile','-r',String(dpi),now,join(dir,`new-${dpi}`)]);
          expect(readFileSync(join(dir,`old-${dpi}.ppm`))).toEqual(readFileSync(join(dir,`new-${dpi}.ppm`)));
        }
      } finally { rmSync(dir,{recursive:true,force:true}); }
    }
  }, 20_000);

  it.each(['dict-keys','mixed-values','utf16','array'])('rejects rearranged fragments in %s before mutation', async mode => {
    const { doc, info } = await fixture();
    if (mode === 'dict-keys') {
      doc.catalog.set('before_ZQ_after',new PDFName('safe'));
      doc.catalog.set('before_JX_after',new PDFName('safe'));
    } else if (mode === 'mixed-values') {
      doc.catalog.set('FragmentZ',new PDFString('prefix Z suffix'));
      info.set('Subject',new PDFString('prefix Q suffix'));
      doc.catalog.set('FragmentName',new PDFName('JX'));
    } else if (mode === 'utf16') {
      info.set('Title',new PDFHexString('feff'+be('prefix JQ suffix')));
      info.set('Subject',new PDFHexString('feff'+be('prefix XZ suffix')));
    } else {
      doc.catalog.set('MixedArray',new PDFArray([new PDFString('J'),new PDFName('Z'),new PDFString('Q'),new PDFString('X')]));
    }
    const before = await serializeDocument(doc);
    expect(() => prepareWholePageRedaction(doc)).toThrow(/retained data contains removed annotation text/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it.each(['name','key'])('rejects non-byte %s whose serialized escapes can carry secret fragments', async kind => {
    const { doc } = await fixture();
    const text = '\u05a0\u0510\u0580\u04a0';
    // Writer emits multi-digit name escapes; the parser interprets the first
    // two hex digits as a byte and leaves subsequent digits in the name.
    if (kind === 'name') doc.catalog.set('Custom', new PDFName(text));
    else doc.catalog.set(text, new PDFName('Safe'));
    const before = await serializeDocument(doc);
    const reopened = await parsePDF(before);
    if (kind === 'name') expect(reopened.catalog.getName('Custom')).toBe('Z0Q0X0J0');
    else expect(reopened.catalog.has('Z0Q0X0J0')).toBe(true);
    expect(() => prepareWholePageRedaction(doc)).toThrow(/retained|inspect/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it.each(['name','key'])('rejects byte-valued %s escape fragments in serialized output', async kind => {
    const { doc } = await fixture('e9QZ');
    if (kind === 'name') doc.catalog.set('Custom', new PDFName('\u00e9'));
    else doc.catalog.set('\u00e9', new PDFName('Safe'));
    doc.catalog.set('Other', new PDFString('QZ'));
    const before = await serializeDocument(doc);
    expect(Buffer.from(before).toString('latin1')).toContain('/#e9');
    const reopened = await parsePDF(before);
    if (kind === 'name') expect(reopened.catalog.getName('Custom')).toBe('\u00e9');
    else expect(reopened.catalog.has('\u00e9')).toBe(true);
    expect(() => prepareWholePageRedaction(doc)).toThrow(/retained data contains removed annotation text/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('rejects a non-byte retained name for whole-page text redaction without a Text annotation', async () => {
    const { doc, page } = await fixture();
    const annots = page.dict.get('Annots') as PDFArray;
    annots.items.splice(0, 1); // Keep the redaction mark; remove the Text note.
    const stream = new PDFRef(1902, 0);
    const bytes = new TextEncoder().encode('BT /F2 12 Tf 10 80 Td (ZQXJ) Tj ET');
    doc.objects.set(stream.toKey(), new PDFStream(new PDFDict([['Length', new PDFNumber(bytes.length)]]), bytes));
    page.dict.set('Contents', stream); page.contentRefs.push(stream);
    page.resources.set('Font', new PDFDict([['F2', new PDFDict([['Type',new PDFName('Font')], ['Subtype',new PDFName('Type1')], ['BaseFont',new PDFName('Helvetica')]])]]));
    page.dict.set('Resources', page.resources);
    doc.catalog.set('Custom', new PDFName('\u05a0\u0510\u0580\u04a0'));
    const before = await serializeDocument(doc);
    expect((await parsePDF(before)).catalog.getName('Custom')).toBe('Z0Q0X0J0');
    expect(() => prepareWholePageRedaction(doc)).toThrow(/retained|inspect/i);
    expect(await serializeDocument(doc)).toEqual(before);
  });

  it('rejects a changed retained stream after prepare without modifying the page', async () => {
    const { doc, other, stream, page } = await fixture('publicQZ');
    const plan = prepareWholePageRedaction(doc);
    const content = doc.objects.get(stream.toKey()) as PDFStream;
    content.rawBytes[0] ^= 1;
    expect(() => plan.commit()).toThrow(/changed/i);
    expect(page.dict.has('Annots')).toBe(true);
    expect(other.contentRefs[0].toKey()).toBe(stream.toKey());
  });
});
