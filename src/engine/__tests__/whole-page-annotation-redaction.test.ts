import { it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePDF } from '../parser/parser';
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFStream, PDFString } from '../types';
import { serializeDocument } from '../writer/serializer';
import { saveQuick } from '../writer/save-pipeline';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { prepareWholePageRedaction } from '../security/redaction/whole-page-redaction';

it('deletes marked page note and retains an independent note on other page', async () => {
 const pdf = await PDFDocument.create();
 pdf.addPage([200, 200]).drawText('SECRET_PAGE', {x:20,y:100});
 pdf.addPage([200, 200]);
 let doc = await parsePDF(await pdf.save({useObjectStreams:false}));
 const note = new PDFRef(900,0), keep = new PDFRef(901,0);
 const makeNote = (p: PDFRef, text:string) => new PDFDict([
  ['Type',new PDFName('Annot')],['Subtype',new PDFName('Text')], ['P',p],
  ['Rect',new PDFArray([10,10,20,20].map(n => new PDFNumber(n)))],['Contents',new PDFString(text)]
 ]);
 doc.objects.set(note.toKey(), makeNote(doc.pages[0].ref,'SECRET_ANNOT'));
 doc.objects.set(keep.toKey(), makeNote(doc.pages[1].ref,'unrelated'));
 doc.pages[0].dict.set('Annots', new PDFArray([note]));
 doc.pages[1].dict.set('Annots', new PDFArray([keep]));
 const before = await serializeDocument(doc);
 doc = await parsePDF(before);
 redactionEngine.markRegion(doc,0,{x:0,y:0,width:200,height:200});
 const result = prepareWholePageRedaction(doc).commit();
 expect(result.annotationsRemoved).toBe(2);
 const output = await saveQuick(doc), text = new TextDecoder().decode(output);
 expect(text).not.toContain('SECRET_ANNOT');
 expect(text).not.toContain('SECRET_PAGE');
 expect(text).toContain('unrelated');
 const independent = await PDFDocument.load(output);
 expect(independent.getPage(0).node.Annots()).toBeUndefined();
 expect(independent.getPage(1).node.Annots()?.size()).toBe(1);
 const tmp = mkdtempSync(join(tmpdir(), 'paperloom-note13-'));
 try {
  const input=join(tmp,'input.pdf'), saved=join(tmp,'output.pdf'); writeFileSync(input,before); writeFileSync(saved,output);
  expect(execFileSync('pdftotext',[input,'-'],{encoding:'utf8'})).toContain('SECRET_PAGE');
  expect(execFileSync('pdftotext',[saved,'-'],{encoding:'utf8'})).not.toContain('SECRET_PAGE');
  for (const dpi of [36,72,150,300]) {
   execFileSync('pdftoppm',['-f','2','-l','2','-singlefile','-r',String(dpi),input,join(tmp,'before')]);
   execFileSync('pdftoppm',['-f','2','-l','2','-singlefile','-r',String(dpi),saved,join(tmp,'after')]);
   expect(readFileSync(join(tmp,'before.ppm'))).toEqual(readFileSync(join(tmp,'after.ppm')));
  }
 } finally { rmSync(tmp,{recursive:true,force:true}); }
}, 30_000);

it('deletes a verified popup and parent without following page back-references', async () => {
 const pdf=await PDFDocument.create(); pdf.addPage([200,200]); pdf.addPage([200,200]);
 const original=await parsePDF(await pdf.save({useObjectStreams:false}));
 const page=original.pages[0];
 const text=new PDFRef(900,0), popup=new PDFRef(901,0);
 const rect=() => new PDFArray([10,10,20,20].map(n=>new PDFNumber(n)));
 original.objects.set(text.toKey(), new PDFDict([['Type',new PDFName('Annot')],['Subtype',new PDFName('Text')],['Rect',rect()],['P',page.ref],['Contents',new PDFString('PRIVATE_NOTE')],['Popup',popup]]));
 original.objects.set(popup.toKey(),new PDFDict([['Type',new PDFName('Annot')],['Subtype',new PDFName('Popup')],['Rect',rect()],['P',page.ref],['Parent',text]]));
 page.dict.set('Annots',new PDFArray([text,popup]));
 const doc=await parsePDF(await serializeDocument(original)); redactionEngine.markRegion(doc,0,{x:0,y:0,width:200,height:200});
 expect(prepareWholePageRedaction(doc).commit()).toMatchObject({annotationsRemoved:3});
 const output=await saveQuick(doc); expect(new TextDecoder().decode(output)).not.toContain('PRIVATE_NOTE');
 const check=await PDFDocument.load(output); expect(check.getPage(0).node.Annots()).toBeUndefined();
});

it('rejects duplicate annotation contents in retained metadata before mutation', async () => {
 const pdf=await PDFDocument.create();pdf.addPage([200,200]);pdf.addPage([200,200]);
 const doc=await parsePDF(await pdf.save({useObjectStreams:false})); const ref=new PDFRef(900,0), page=doc.pages[0];
 doc.objects.set(ref.toKey(),new PDFDict([['Subtype',new PDFName('Text')],['Rect',new PDFArray([10,10,20,20].map(n=>new PDFNumber(n)))],['Contents',new PDFString('PRIVATE_NOTE')]]));
 page.dict.set('Annots',new PDFArray([ref]));
 const info=doc.objects.get(doc.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;
 info.set('Keywords',new PDFString('PRIVATE_NOTE'));
 redactionEngine.markRegion(doc,0,{x:0,y:0,width:200,height:200});
 const before=await serializeDocument(doc);
 expect(()=>prepareWholePageRedaction(doc)).toThrow(/retained data contains removed annotation text/i);
 expect(await serializeDocument(doc)).toEqual(before);
});

it.each([
  ['BT /F1 12 Tf 10 50 Td (other words) Tj ET', true],
  ['BT /F1 12 Tf 10 50 Td (PRIVATE_) Tj (NOTE) Tj ET', false],
  ['BT /F1 12 Tf 10 50 Td <505249564154455f4e4f5445> Tj ET', false],
  ['BT /F1 12 Tf 10 50 Td [(PRIVATE_NOTE)] TJ ET', false],
])('checks retained content before removing a note: %s', async (content,allowed) => {
 const pdf=await PDFDocument.create();pdf.addPage([200,200]);pdf.addPage([200,200]);
 const doc=await parsePDF(await pdf.save({useObjectStreams:false}));
 const page=doc.pages[0], other=doc.pages[1], note=new PDFRef(900,0), stream=new PDFRef(901,0);
 doc.objects.set(note.toKey(),new PDFDict([['Subtype',new PDFName('Text')],['Rect',new PDFArray([10,10,20,20].map(n=>new PDFNumber(n)))],['Contents',new PDFString('PRIVATE_NOTE')]]));
 page.dict.set('Annots',new PDFArray([note]));
 other.resources.set('Font',new PDFDict([['F1',new PDFDict([['Type',new PDFName('Font')],['Subtype',new PDFName('Type1')],['BaseFont',new PDFName('Helvetica')]])]]));other.dict.set('Resources',other.resources);
 const bytes=new TextEncoder().encode(content);doc.objects.set(stream.toKey(), new PDFStream(new PDFDict([['Length',new PDFNumber(bytes.length)]]),bytes));
 other.dict.set('Contents',stream);other.contentRefs.push(stream);
 redactionEngine.markRegion(doc,0,{x:0,y:0,width:200,height:200});
 const before=await serializeDocument(doc);
 if (allowed) {
  expect(prepareWholePageRedaction(doc).commit().annotationsRemoved).toBe(2);
  const saved=await saveQuick(doc);expect(new TextDecoder().decode(saved)).not.toContain('PRIVATE_NOTE');
  expect((await PDFDocument.load(saved)).getPageCount()).toBe(2);
 } else {
  expect(()=>prepareWholePageRedaction(doc)).toThrow(/retained/i);
  expect(await serializeDocument(doc)).toEqual(before);
 }
});

it.each(['foreign-page','widget','unsupported-key','missing-popup','shared-string','utf16-copy','non-ascii','out-of-page'] as const)(
 'rejects unsafe note %s without mutation', async mode => {
 const pdf=await PDFDocument.create();pdf.addPage([200,200]);pdf.addPage([200,200]);
 const doc=await parsePDF(await pdf.save({useObjectStreams:false}));const page=doc.pages[0], note=new PDFRef(900,0), shared=new PDFRef(901,0);
 const annot=new PDFDict([['Type',new PDFName('Annot')],['Subtype',new PDFName(mode==='widget'?'Widget':'Text')],['Rect',new PDFArray([10,10,20,20].map(n=>new PDFNumber(n)))],['Contents',new PDFString(mode==='non-ascii'?'\u00e9':'PRIVATE_NOTE')]]);
 if (mode==='foreign-page') annot.set('P',doc.pages[1].ref);
 if (mode==='unsupported-key') annot.set('AP',new PDFDict());
 if (mode==='missing-popup') annot.set('Popup',shared);
 if (mode==='out-of-page') annot.set('Rect',new PDFArray([10,10,201,20].map(n=>new PDFNumber(n))));
 if (mode==='shared-string') {doc.objects.set(shared.toKey(),new PDFString('PRIVATE_NOTE'));annot.set('Contents',shared);doc.catalog.set('Extra',shared);}
 if (mode==='utf16-copy') {const info=doc.objects.get(doc.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;info.set('Keywords',new PDFHexString('0050005200490056004100540045005f004e004f00540045'));}
 doc.objects.set(note.toKey(),annot);page.dict.set('Annots',new PDFArray([note]));redactionEngine.markRegion(doc,0,{x:0,y:0,width:200,height:200});
 const before=await serializeDocument(doc);expect(()=>prepareWholePageRedaction(doc)).toThrow();expect(await serializeDocument(doc)).toEqual(before);
});

it.each(['differences', 'tounicode', 'customfont', 'missing-font', 'short-note', 'encoded-quote', 'array-fragments', 'numeric-copy', 'name-copy'] as const)(
 'rejects unverified font or retained copy (%s)', async mode => {
 const pdf=await PDFDocument.create();pdf.addPage([200,200]);pdf.addPage([200,200]);
 const doc=await parsePDF(await pdf.save({useObjectStreams:false})); const page=doc.pages[0],other=doc.pages[1],note=new PDFRef(900,0),stream=new PDFRef(901,0);
 const text=mode==='short-note'?'abc':mode==='encoded-quote'?"Don't":mode==='numeric-copy'?'1000':mode==='name-copy'?'PRIVATE_NOTE':'PRIVATE_NOTE';
 const annot=new PDFDict([['Subtype',new PDFName('Text')],['Rect',new PDFArray([10,10,20,20].map(n=>new PDFNumber(n)))],['Contents',new PDFString(text)]]);
 doc.objects.set(note.toKey(),annot);page.dict.set('Annots',new PDFArray([note]));
 const font=new PDFDict([['Type',new PDFName('Font')],['Subtype',new PDFName('Type1')],['BaseFont',new PDFName(mode==='customfont'?'CustomFont':'Helvetica')]]);
 if(mode==='differences') font.set('Encoding',new PDFDict([['Differences',new PDFArray()]]));
 if(mode==='tounicode') font.set('ToUnicode',new PDFString('custom'));
 if(mode!=='missing-font') {other.resources.set('Font',new PDFDict([['F1',font]]));other.dict.set('Resources',other.resources);}
 const bytes=new TextEncoder().encode('BT /F1 12 Tf 10 50 Td (other words) Tj ET');
 doc.objects.set(stream.toKey(),new PDFStream(new PDFDict([['Length',new PDFNumber(bytes.length)]]),bytes));other.dict.set('Contents',stream);other.contentRefs.push(stream);
 if(mode==='array-fragments') doc.catalog.set('Test',new PDFArray([new PDFString('PRIVATE_'),new PDFString('NOTE')]));
 if(mode==='numeric-copy') doc.catalog.set('Test',new PDFNumber(1000));
 if(mode==='name-copy') doc.catalog.set('Test',new PDFName('PRIVATE_NOTE'));
 redactionEngine.markRegion(doc,0,{x:0,y:0,width:200,height:200});const before=await serializeDocument(doc);
 expect(()=>prepareWholePageRedaction(doc)).toThrow();expect(await serializeDocument(doc)).toEqual(before);
});
