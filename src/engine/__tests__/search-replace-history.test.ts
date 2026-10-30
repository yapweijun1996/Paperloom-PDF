import { describe, expect, it } from 'vitest';
import { interpretPage } from '../content/interpreter';
import { captureHistoryEntry, restoreDocumentStructure } from '../editing/editor-history';
import { findAndReplace, findTextOccurrences } from '../editor/text-editor';
import { updatePageContent } from '../editor/stream-compiler';
import { getPageContentBytes, parsePDF } from '../parser/parser';
import { SessionDocumentEditor } from '../session/document-edit';
import { SessionEditorHistory } from '../session/editor-history';
import { serializeDocument } from '../writer/serializer';
import { rawPDF } from './audit-p1-fixtures';

async function setup() {
  const first = 'BT /F1 14 Tf 20 180 Td (sample sample) Tj ET BT /F1 14 Tf 20 130 Td (sample) Tj ET';
  const second = 'BT /F1 14 Tf 20 180 Td (sample sample) Tj ET';
  const doc = await parsePDF(rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 240] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 240] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${first.length} >>\nstream\n${first}\nendstream`,
    `<< /Length ${second.length} >>\nstream\n${second}\nendstream`,
  ]));
  const capture = (label: string) => captureHistoryEntry(doc, 0, getPageContentBytes(doc.pages[0], doc.objects),
    { drawnPaths: [], floatingTexts: [], floatingImages: [], signatures: [] }, label);
  const history = new SessionEditorHistory();
  history.seed(capture('initial'));
  const move = (direction: 'undo' | 'redo') => history.moveAtomic(doc, direction, {
    isCurrent: () => true,
    applyLegacy: (draft, entry) => restoreDocumentStructure(draft, entry, updatePageContent),
  });
  const text = () => doc.pages.map(page => interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects).textRuns.map(run => run.text));
  const replace = async (label: string, target?: { runIndex: number; start: number; end: number; runText: string }) => {
    const editor = new SessionDocumentEditor();
    await editor.edit(doc, label, async staged => {
      for (const [index, page] of staged.pages.entries()) {
        if (target && index !== 0) continue;
        const bytes = getPageContentBytes(page, staged.objects);
        const result = findAndReplace(bytes, page, staged.objects, 'sample', 'result', false, target);
        if (result.replacedCount) await updatePageContent(page.contentRefs, result.newContentBytes, staged.objects);
      }
    });
    history.push(capture(label), editor);
  };
  return { doc, history, move, text, replace };
}

describe('document search and replace', () => {
  it('replaces just the selected occurrence, preserving other runs and pages', async () => {
    const { doc, text, replace } = await setup();
    const run = text()[0][0];
    const matches = findTextOccurrences(run, 'sample');
    expect(matches).toHaveLength(2);
    await replace('replace-current', { runIndex: 0, ...matches[1], runText: run });
    expect(text()).toEqual([['sample result', 'sample'], ['sample sample']]);
    const reopened = await parsePDF(await serializeDocument(doc));
    expect(interpretPage(getPageContentBytes(reopened.pages[0], reopened.objects), reopened.pages[0], reopened.objects).textRuns.map(r => r.text))
      .toEqual(['sample result', 'sample']);
  });

  it('undoes and redoes a single occurrence and a multi-page replacement independently', async () => {
    const { history, move, text, replace } = await setup();
    const initial = text();
    const run = initial[0][0];
    await replace('replace-current', { runIndex: 0, ...findTextOccurrences(run, 'sample')[1], runText: run });
    const single = text();
    await replace('replace-all');
    const all = text();
    expect(all).toEqual([['result result', 'result'], ['result result']]);
    expect(history.canUndo()).toBe(true);
    await move('undo'); expect(text()).toEqual(single);
    await move('undo'); expect(text()).toEqual(initial);
    await move('redo'); expect(text()).toEqual(single);
    await move('redo'); expect(text()).toEqual(all);
  });

  it('treats search and replacement as literal text, including regexp and dollar characters', async () => {
    const { doc } = await setup();
    const page = doc.pages[0], bytes = getPageContentBytes(page, doc.objects);
    const literal = findAndReplace(bytes, page, doc.objects, 'SAMPLE', '$&$$', false);
    expect(literal.replacedCount).toBe(3);
    expect(interpretPage(literal.newContentBytes, page, doc.objects).textRuns.map(r => r.text))
      .toEqual(['$&$$ $&$$', '$&$$']);
    expect(findTextOccurrences('a.b aXb a.b', 'a.b')).toEqual([{ start: 0, end: 3 }, { start: 8, end: 11 }]);
    expect(findTextOccurrences('sample', '')).toEqual([]);
  });

  it('rejects a stale selected match instead of replacing another occurrence', async () => {
    const { doc } = await setup();
    const page = doc.pages[0], bytes = getPageContentBytes(page, doc.objects);
    expect(() => findAndReplace(bytes, page, doc.objects, 'sample', 'result', false,
      { runIndex: 0, start: 7, end: 13, runText: 'stale text' })).toThrow(/selected search match changed/i);
  });
});
