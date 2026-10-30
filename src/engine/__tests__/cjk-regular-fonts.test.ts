import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { SCRIPT_FONTS, type ScriptFontId } from '../fonts/script-fonts';
import { parseTTF } from '../fonts/truetype-parser';
import { prepareTextForExport, insertTextRun } from '../editor/text-editor';
import { updatePageContent } from '../editor/stream-compiler';
import { saveQuick } from '../writer/save-pipeline';
import { unicodeDocument } from './unicode-font-fixtures';

const hasPoppler = spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status === 0;
function load(id: ScriptFontId) {
  return new Uint8Array(readFileSync(new URL(`../../../public/fonts/${basename(SCRIPT_FONTS[id].assetPath)}`, import.meta.url)));
}

function postscriptNames(bytes: Uint8Array) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let names = 0;
  for (let i = 0; i < data.getUint16(4); i++) {
    const entry = 12 + 16 * i;
    if (String.fromCharCode(...bytes.subarray(entry, entry + 4)) === 'name') names = data.getUint32(entry + 8);
  }
  if (!names) throw new Error('Font has no name table');
  const count = data.getUint16(names + 2), strings = names + data.getUint16(names + 4);
  const result = new Set<string>();
  for (let i = 0; i < count; i++) {
    const entry = names + 6 + 12 * i;
    if (data.getUint16(entry + 6) !== 6 || data.getUint16(entry) !== 3) continue;
    const length = data.getUint16(entry + 8), offset = strings + data.getUint16(entry + 10);
    result.add(new TextDecoder('utf-16be').decode(bytes.subarray(offset, offset + length)));
  }
  return result;
}

const fixtures = [
  { id: 'jp', text: '日本語ひらがな', name: 'NotoSansJP-Regular' },
  { id: 'kr', text: '한국어', name: 'NotoSansKR-Regular' },
  { id: 'tc', text: '電腦科學', name: 'NotoSansTC-Regular' },
] as const;

describe('CJK regular font assets', () => {
  it.each(fixtures)('$id embeds the intended regular face and supports representative text', ({ id, text, name }) => {
    const bytes = load(id);
    expect(postscriptNames(bytes)).toContain(name);
    const font = parseTTF(bytes);
    for (const character of text) expect(font.cmapEntries.has(character.codePointAt(0)!)).toBe(true);
  });

  it.skipIf(!hasPoppler).each(fixtures)('$id exports text readable by Poppler', async ({ id, text }) => {
    const doc = unicodeDocument(), page = doc.pages[0];
    const loaders = Object.fromEntries(['sc', 'tc', 'jp', 'kr', 'latin'].map(key => [key, async () => load(key as ScriptFontId)]));
    await prepareTextForExport(doc.objects, [{ text }], loaders, { preferredHanFont: id });
    const content = insertTextRun(new Uint8Array(), page, doc.objects, text, 40, 650, 16, [0, 0, 0]);
    await updatePageContent(page.contentRefs, content, doc.objects);
    const directory = mkdtempSync(join(tmpdir(), 'paperloom-font-'));
    try {
      const path = join(directory, `${id}.pdf`);
      writeFileSync(path, await saveQuick(doc));
      expect(execFileSync('pdftotext', [path, '-'], { encoding: 'utf8' })).toContain(text);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
