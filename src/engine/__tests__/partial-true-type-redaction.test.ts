import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName as LibName } from 'pdf-lib';
import { parseTTF } from '../fonts/truetype-parser';
import { parsePDF } from '../parser/parser';
import { PDFDict } from '../types';
import { serializeDocument } from '../writer/serializer';
import { redactionEngine } from '../security/redaction/redaction-engine';
import { prepareIsolatedTextRedaction } from '../security/redaction/isolated-text-redaction';
import { dehydrateDocument, sameDocumentSnapshot } from '../worker/codec';

const fontBytes = new Uint8Array(readFileSync(new URL('../../../public/fonts/NotoSans-Regular.ttf', import.meta.url)));

async function fixture(showing: string, size: number) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([360, 200]);
  const font = parseTTF(fontBytes);
  const widths = Array.from({ length: 95 }, (_, i) => {
    const gid = font.cmapEntries.get(i + 32) ?? 0;
    return Math.round(font.advanceWidths[gid] * 1000 / font.unitsPerEm);
  });
  const file = pdf.context.register(pdf.context.flateStream(fontBytes, { Length1: fontBytes.length }));
  const descriptor = pdf.context.register(pdf.context.obj({
    Type: 'FontDescriptor', FontName: 'NotoSans', Flags: 32, FontBBox: [-1000, -1000, 2000, 2000],
    ItalicAngle: 0, Ascent: 1069, Descent: -293, CapHeight: 714, StemV: 80, FontFile2: file,
  }));
  const fontRef = pdf.context.register(pdf.context.obj({
    Type: 'Font', Subtype: 'TrueType', BaseFont: 'NotoSans', Encoding: 'WinAnsiEncoding',
    FirstChar: 32, LastChar: 126, Widths: widths, FontDescriptor: descriptor,
  }));
  page.node.setFontDictionary(LibName.of('F1'), fontRef);
  page.node.set(LibName.of('Contents'), pdf.context.register(pdf.context.stream(
    `q BT 0 g /F1 ${size} Tf 1 0 0 1 20 80 Tm ${showing} ET Q\n`,
  )));
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  doc.xref.trailerDict.delete('Info');
  const resources = new PDFDict([['Font', doc.pages[0].resources.get('Font')!]]);
  doc.pages[0].resources = resources;
  doc.pages[0].dict.set('Resources', resources);
  return parsePDF(await serializeDocument(doc));
}

describe('partial embedded TrueType redaction', () => {
  it.each([[4, '(A|SECRET|Z) Tj'], [8, '[(A|) (SECRET) (|Z)] TJ']])(
    'rejects embedded TrueType partial redaction at %i points without mutation', async (size, showing) => {
      const doc = await fixture(showing, size);
      redactionEngine.markRegion(doc, 0, { x: 20 + size * 1.2, y: 79, width: size * 3.5, height: size * 1.5 });
      const before = dehydrateDocument(doc);
      expect(() => prepareIsolatedTextRedaction(doc)).toThrow(/unsupported/i);
      expect(sameDocumentSnapshot(before, dehydrateDocument(doc))).toBe(true);
      expect(doc.requiresFullRewrite).toBeUndefined();
    },
  );
});
