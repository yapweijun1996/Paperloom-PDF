import { describe, expect, it } from 'vitest';
import { interpretPage } from '../content/interpreter';
import { captureHistoryEntry, restoreDocumentStructure } from '../editing/editor-history';
import { addLinkFromLineSelection, listPageLinks, removePageLink, updatePageLinkUrl } from '../editor/link';
import { updatePageContent } from '../editor/stream-compiler';
import { applyLineTextEdit, buildDocumentFlow } from '../flow';
import { getPageContentBytes, parsePDF } from '../parser/parser';
import { SessionDocumentEditor } from '../session/document-edit';
import { SessionEditorHistory } from '../session/editor-history';
import { serializeDocument } from '../writer/serializer';
import { rawPDF } from './audit-p1-fixtures';

async function setup() {
  const content = 'BT /F1 14 Tf 20 100 Td (Synthetic link text) Tj ET';
  const doc = await parsePDF(rawPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 240] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Annot /Subtype /Link /Rect [20 95 95 115] /A << /S /URI /URI (https://old.example.test) >> >>',
  ]));
  const capture = (label: string) => captureHistoryEntry(doc, 0, getPageContentBytes(doc.pages[0], doc.objects),
    { drawnPaths: [], floatingTexts: [], floatingImages: [], signatures: [] }, label);
  const history = new SessionEditorHistory();
  history.seed(capture('initial'));
  const move = (direction: 'undo' | 'redo') => history.moveAtomic(doc, direction, {
    isCurrent: () => true,
    applyLegacy: (draft, entry) => restoreDocumentStructure(draft, entry, updatePageContent),
  });
  const urls = () => listPageLinks(doc, 0).map(link => link.url).sort();
  return { doc, capture, history, move, urls };
}

describe('link edit history', () => {
  it('stages adding, changing, and removing links with undo and redo', async () => {
    const { doc, capture, history, move, urls } = await setup();
    const content = getPageContentBytes(doc.pages[0], doc.objects);
    const line = buildDocumentFlow(interpretPage(content, doc.pages[0], doc.objects).textRuns).lines[0];
    expect(line?.text).toBe('Synthetic link text');
    const addition = new SessionDocumentEditor();
    await addition.edit(doc, 'add-link', async staged => {
      expect(addLinkFromLineSelection(staged, 0, line, 0, line.text.length, 'new.example.test')).not.toBeNull();
    });
    history.push(capture('add-link'), addition);
    const added = urls();
    expect(added).toEqual(['https://new.example.test', 'https://old.example.test']);
    const edit = new SessionDocumentEditor();
    await edit.edit(doc, 'edit-link', async staged => {
      const link = listPageLinks(staged, 0).find(item => item.url === 'https://old.example.test')!;
      updatePageLinkUrl(staged, 0, link, 'changed.example.test');
    });
    history.push(capture('edit-link'), edit);
    const changed = urls();
    expect(changed).toEqual(['https://changed.example.test', 'https://new.example.test']);
    const removal = new SessionDocumentEditor();
    await removal.edit(doc, 'remove-link', async staged => {
      const link = listPageLinks(staged, 0).find(item => item.url === 'https://new.example.test')!;
      removePageLink(staged, 0, link.ref);
    });
    history.push(capture('remove-link'), removal);
    expect(urls()).toEqual(['https://changed.example.test']);
    expect(listPageLinks(await parsePDF(await serializeDocument(doc)), 0)).toHaveLength(1);
    await move('undo'); expect(urls()).toEqual(changed);
    await move('undo'); expect(urls()).toEqual(added);
    await move('undo'); expect(urls()).toEqual(['https://old.example.test']);
    await move('redo'); expect(urls()).toEqual(added);
    await move('redo'); expect(urls()).toEqual(changed);
    await move('redo'); expect(urls()).toEqual(['https://changed.example.test']);
  });

  it('does not publish a partially changed link when staging fails', async () => {
    const { doc, history, urls } = await setup();
    const before = await serializeDocument(doc);
    const editor = new SessionDocumentEditor();
    await expect(editor.edit(doc, 'edit-link', async staged => {
      updatePageLinkUrl(staged, 0, listPageLinks(staged, 0)[0], 'changed.example.test');
      throw new Error('link edit failed');
    })).rejects.toThrow('link edit failed');
    expect(await serializeDocument(doc)).toEqual(before);
    expect(urls()).toEqual(['https://old.example.test']);
    expect(history.canUndo()).toBe(false);
  });

  it('restores a link URL and its edited display text as one history step', async () => {
    const { doc, capture, history, move, urls } = await setup();
    const page = doc.pages[0];
    const bytes = getPageContentBytes(page, doc.objects);
    const flow = buildDocumentFlow(interpretPage(bytes, page, doc.objects).textRuns);
    const line = flow.lines[0];
    const editor = new SessionDocumentEditor();
    await editor.edit(doc, 'edit-link', async staged => {
      const stagedPage = staged.pages[0];
      const original = getPageContentBytes(stagedPage, staged.objects);
      const result = applyLineTextEdit(original, stagedPage, staged.objects, line, 'Changed link text', flow);
      await updatePageContent(stagedPage.contentRefs, result.newContentBytes, staged.objects);
      updatePageLinkUrl(staged, 0, listPageLinks(staged, 0)[0], 'changed.example.test');
    });
    history.push(capture('edit-link'), editor);
    const text = () => interpretPage(getPageContentBytes(doc.pages[0], doc.objects), doc.pages[0], doc.objects).textRuns.map(run => run.text).join('');
    expect(text()).toBe('Changed link text');
    expect(urls()).toEqual(['https://changed.example.test']);
    await move('undo');
    expect(text()).toBe('Synthetic link text');
    expect(urls()).toEqual(['https://old.example.test']);
    await move('redo');
    expect(text()).toBe('Changed link text');
    expect(urls()).toEqual(['https://changed.example.test']);
  });
});
