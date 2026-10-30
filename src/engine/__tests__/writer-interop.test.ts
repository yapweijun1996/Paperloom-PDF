import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePDF } from '../parser/parser';
import { PDFLexer } from '../parser/lexer';
import { PDFDict, PDFRef, PDFString } from '../types';
import { metadataEngine } from '../security/metadata/metadata-engine';
import { securityEngine } from '../security';
import { saveIncremental } from '../writer/incremental-writer';
import { serializeDocument } from '../writer/serializer';
import { saveOptimized } from '../writer/save-pipeline';
import { formatXrefEntry } from '../writer/xref-entry';
import { serializeToString } from '../editor/stream-compiler';

async function fixture() {
  const source = await PDFDocument.create();
  source.addPage([200, 200]);
  return parsePDF(await source.save({ useObjectStreams: false }));
}

function assertXrefWidths(bytes: Uint8Array) {
  const data = Buffer.from(bytes).toString('latin1');
  const positions = [...data.matchAll(/startxref\s+(\d+)\s+%%EOF/g)];
  const start = Number(positions.at(-1)?.[1]);
  expect(data.slice(start, start + 5)).toBe('xref\n');
  let pos = start + 5;
  while (!data.startsWith('trailer', pos)) {
    const end = data.indexOf('\n', pos);
    const header = /^(\d+) (\d+)$/.exec(data.slice(pos, end));
    expect(header).not.toBeNull();
    pos = end + 1;
    for (let i = 0; i < Number(header![2]); i++) {
      const entry = data.slice(pos, pos + 20);
      expect(entry).toMatch(/^\d{10} \d{5} [nf]\r\n$/);
      if (entry[17] === 'n') {
        const offset = Number(entry.slice(0, 10));
        const generation = Number(entry.slice(11, 16));
        expect(data.slice(offset).startsWith(`${Number(header![1]) + i} ${generation} obj`)).toBe(true);
      }
      pos += 20;
    }
  }
}

describe('PDF writer interoperability', () => {
  it('emits exactly 20 bytes per full and incremental xref entry', async () => {
    const doc = await fixture();
    const full = await serializeDocument(doc);
    assertXrefWidths(full);
    const reopened = await parsePDF(full);
    const incremental = saveIncremental(reopened, new Set([reopened.pages[0].ref.toKey()]));
    assertXrefWidths(incremental);
    expect((await PDFDocument.load(incremental)).getPageCount()).toBe(1);
    for (const bytes of [full, incremental]) {
      const reader = spawnSync('pdfinfo', ['-'], { input: bytes, encoding: 'utf8' });
      if (!reader.error) { expect(reader.status).toBe(0); expect(reader.stderr).not.toMatch(/xref|syntax error/i); }
    }
    expect(() => formatXrefEntry(10_000_000_000, 0, 'n')).toThrow(/field widths/);
    expect(() => formatXrefEntry(0, 65_536, 'n')).toThrow(/field widths/);
  });

  it('preserves byte-oriented strings while serializing Unicode as UTF-16BE', () => {
    const raw = String.fromCharCode(...Array.from({ length: 256 }, (_, i) => i));
    const encoded = serializeToString(new PDFString(raw));
    const token = new PDFLexer(new TextEncoder().encode(encoded)).nextToken();
    expect(new PDFString(token!.value as string).toBytes()).toEqual(new PDFString(raw).toBytes());
    expect(new PDFString('合同😀').toBytes()).toEqual(Uint8Array.of(0xfe, 0xff, 0x54, 0x08, 0x54, 0x0c, 0xd8, 0x3d, 0xde, 0x00));
  });

  it('writes Latin text with PDFDocEncoding-ambiguous characters without altering binary strings', async () => {
    const doc = await fixture();
    const title = 'Café\u00a0draft';
    metadataEngine.editInfo(doc, { Title: title });
    const output = await serializeDocument(doc);
    expect((await parsePDF(output)).info.title).toBe(title);
    expect((await PDFDocument.load(output)).getTitle()).toBe(title);
  });

  it('decodes existing PDFDocEncoding text without changing the original bytes', async () => {
    const doc = await fixture();
    doc.xref.trailerDict.set('Info', new PDFDict([['Title', new PDFString('\x80\xa0')]]));
    const output = await serializeDocument(doc);
    expect((await parsePDF(output)).info.title).toBe('•€');
    expect((await PDFDocument.load(output)).getTitle()).toBe('•€');
  });

  it('treats a cyclic Info reference as unavailable rather than recursing indefinitely', async () => {
    const doc = await fixture();
    const first = new PDFRef(900, 0), second = new PDFRef(901, 0);
    doc.objects.set(first.toKey(), second);
    doc.objects.set(second.toKey(), first);
    doc.xref.trailerDict.set('Info', first);
    expect(metadataEngine.readInfo(doc)).toEqual({});
  });

  it('writes Unicode in a direct trailer Info dictionary', async () => {
    const doc = await fixture();
    doc.xref.trailerDict.set('Info', new PDFDict([['Title', new PDFString('合同😀')]]));
    const output = await serializeDocument(doc);
    const reopened = await parsePDF(output);
    expect(reopened.info.title).toBe('合同😀');
    expect((await PDFDocument.load(output)).getTitle()).toBe('合同😀');
  });

  it('preserves Unicode metadata when an encrypted PDF is rewritten and reopened', async () => {
    const input = new Uint8Array(readFileSync(join(__dirname, 'fixtures/encrypted/aes-128-r4.pdf')));
    const opened = await securityEngine.open(await parsePDF(input), 'userpass');
    const title = '合同 机密 😀';
    metadataEngine.editInfo(opened.doc, { Title: title });
    const output = await saveOptimized(opened.doc);
    const reopened = await securityEngine.open(await parsePDF(output), 'userpass');
    expect(metadataEngine.readInfo(reopened.doc).Title).toBe(title);
    expect(reopened.doc.info.title).toBe(title);
    const reader = spawnSync('pdfinfo', ['-upw', 'userpass', '-'], { input: output, encoding: 'utf8' });
    if (!reader.error) {
      expect(reader.status).toBe(0);
      expect(reader.stdout).toContain(title);
    }
  });

  it('round-trips non-Latin text strings through both Paperloom and independent readers', async () => {
    const doc = await fixture();
    const title = '合同 合约 😀 (draft) \\';
    metadataEngine.editInfo(doc, { Title: title });
    const output = await serializeDocument(doc);
    const reopened = await parsePDF(output);
    expect(metadataEngine.readInfo(reopened).Title).toBe(title);
    expect((await PDFDocument.load(output)).getTitle()).toBe(title);
    const reader = spawnSync('pdfinfo', ['-'], { input: output, encoding: 'utf8' });
    if (!reader.error) {
      expect(reader.status).toBe(0);
      expect(reader.stdout).toContain(title);
    }
  });
});
