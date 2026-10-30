import { it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { parsePDF } from '../parser/parser';
import { PDFArray, PDFBoolean, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, PDFString } from '../types';
import { serializeDocument } from '../writer/serializer';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { prepareWholePageRedaction } from '../security/redaction/whole-page-redaction';

it('rejects metadata split copies of removed note text', async () => {
 const pdf=await PDFDocument.create();pdf.addPage([200,200]);pdf.addPage([200,200]);
 const doc=await parsePDF(await pdf.save({useObjectStreams:false}));
 const ref=new PDFRef(900,0), page=doc.pages[0];
 doc.objects.set(ref.toKey(),new PDFDict([['Subtype',new PDFName('Text')],['Rect',new PDFArray([10,10,20,20].map(n=>new PDFNumber(n)))],['Contents',new PDFString('PRIVATE_NOTE')]]));
 page.dict.set('Annots',new PDFArray([ref]));
 const info=doc.objects.get(doc.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;
 info.set('Title',new PDFString('PRIVATE_'));info.set('Subject',new PDFString('NOTE'));
 redactionEngine.markRegion(doc,0,{x:0,y:0,width:200,height:200});
 const before=await serializeDocument(doc);
 expect(()=>prepareWholePageRedaction(doc)).toThrow(/retained/i);
 expect(await serializeDocument(doc)).toEqual(before);
});

it('rejects a retained secret mapped through a custom font CMap', async () => {
 const pdf=await PDFDocument.create();pdf.addPage([200,200]);pdf.addPage([200,200]);
 let doc=await parsePDF(await pdf.save({useObjectStreams:false}));
 const page=doc.pages[0], other=doc.pages[1], note=new PDFRef(900,0), stream=new PDFRef(901,0), font=new PDFRef(902,0), cmap=new PDFRef(903,0);
 doc.objects.set(note.toKey(),new PDFDict([['Subtype',new PDFName('Text')],['Rect',new PDFArray([10,10,20,20].map(n=>new PDFNumber(n)))],['Contents',new PDFString('PRIVATE_NOTE')]]));
 page.dict.set('Annots',new PDFArray([note]));
 const text='BT /F1 12 Tf 10 50 Td (abcdefghijkl) Tj ET';
 const content=new TextEncoder().encode(text);
 doc.objects.set(stream.toKey(), new PDFStream(new PDFDict([['Length',new PDFNumber(content.length)]]),content));
 other.dict.set('Contents',stream);other.contentRefs.push(stream);
 const mapping='PRIVATE_NOTE';
 const pairs=Array.from(mapping,(v,i)=>`<${(97+i).toString(16)}> <${v.charCodeAt(0).toString(16).padStart(4,'0')}>`).join('\n');
 const cmapBytes=new TextEncoder().encode(`/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Test def\n/CMapType 2 def\n1 begincodespacerange\n<00> <ff>\nendcodespacerange\n12 beginbfchar\n${pairs}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`);
 doc.objects.set(cmap.toKey(),new PDFStream(new PDFDict([['Length',new PDFNumber(cmapBytes.length)]]),cmapBytes));
 doc.objects.set(font.toKey(),new PDFDict([['Type',new PDFName('Font')],['Subtype',new PDFName('Type1')],['BaseFont',new PDFName('Helvetica')],['ToUnicode',cmap]]));
 other.resources.set('Font',new PDFDict([['F1',font]]));other.dict.set('Resources',other.resources);
 const saved=await serializeDocument(doc);
 if (spawnSync('pdftotext',['-v'],{stdio:'ignore'}).status === 0) {
   const dir=mkdtempSync(join(tmpdir(),'paperloom-cmap13-'));
   try { const path=join(dir,'source.pdf');writeFileSync(path,saved);expect(execFileSync('pdftotext',[path,'-'],{encoding:'utf8'})).toContain('PRIVATE_NOTE'); }
   finally {rmSync(dir,{recursive:true,force:true});}
 }
 doc=await parsePDF(saved);redactionEngine.markRegion(doc,0,{x:0,y:0,width:200,height:200});
 const before=await serializeDocument(doc);
 expect(()=>prepareWholePageRedaction(doc)).toThrow(/retained/i);
 expect(await serializeDocument(doc)).toEqual(before);
});

it('rejects retained strings containing wrapped fragments of removed note text', async () => {
 const pdf=await PDFDocument.create();pdf.addPage([200,200]);pdf.addPage([200,200]);
 const doc=await parsePDF(await pdf.save({useObjectStreams:false})); const ref=new PDFRef(900,0), page=doc.pages[0];
 doc.objects.set(ref.toKey(),new PDFDict([['Subtype',new PDFName('Text')],['Rect',new PDFArray([10,10,20,20].map(n=>new PDFNumber(n)))],['Contents',new PDFString('PRIVATE_NOTE')]]));
 page.dict.set('Annots',new PDFArray([ref]));const info=doc.objects.get(doc.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;
 info.set('Title',new PDFString('prefix PRIVATE_ suffix'));info.set('Subject',new PDFString('prefix NOTE suffix'));
 redactionEngine.markRegion(doc,0,{x:0,y:0,width:200,height:200});const before=await serializeDocument(doc);
 expect(()=>prepareWholePageRedaction(doc)).toThrow(/retained/i);expect(await serializeDocument(doc)).toEqual(before);
});

it('rejects sensitive fragments inside nonstructural PDF dictionary keys', async () => {
 const pdf=await PDFDocument.create();pdf.addPage([200,200]);pdf.addPage([200,200]);
 const doc=await parsePDF(await pdf.save({useObjectStreams:false})); const ref=new PDFRef(900,0), page=doc.pages[0];
 doc.objects.set(ref.toKey(),new PDFDict([['Subtype',new PDFName('Text')],['Rect',new PDFArray([10,10,20,20].map(n=>new PDFNumber(n)))],['Contents',new PDFString('PRIVATE_NOTE')]]));
 page.dict.set('Annots',new PDFArray([ref]));const info=doc.objects.get(doc.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;
 for(const key of [...info.keys()]) info.delete(key);
 doc.catalog.set('prefix_PRIVATE_suffix',new PDFBoolean(false));doc.catalog.set('prefix_NOTE_suffix',new PDFBoolean(false));
 redactionEngine.markRegion(doc,0,{x:0,y:0,width:200,height:200});const before=await serializeDocument(doc);
 expect(()=>prepareWholePageRedaction(doc)).toThrow(/retained/i);expect(await serializeDocument(doc)).toEqual(before);
});
