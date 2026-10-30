import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { parsePDF } from '../parser/parser';
import { updatePageContent } from '../editor/stream-compiler';
import { sanitizationEngine } from '../security/sanitization/sanitization-engine';
import { serializeDocument } from '../writer/serializer';
import { saveQuick } from '../writer/save-pipeline';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFString } from '../types';

const options = { metadata: false, javascript: false, embeddedFiles: false, comments: false,
  annotations: false, unusedObjects: false, hiddenLayers: true, alternativeImages: false };
const secret = 'PRIVATE-TREE-932';
const hiddenText = `BT /F1 12 Tf 1 0 0 1 20 160 Tm (FIRST-VISIBLE) Tj ET\n` +
  `/OC /Hidden BDC q BT /F1 12 Tf 1 0 0 1 20 100 Tm (${secret}) Tj ET Q EMC\n` +
  'BT /F1 12 Tf 1 0 0 1 20 40 Tm (SECOND-VISIBLE) Tj ET';
const visibleText = 'BT /F1 12 Tf 1 0 0 1 20 80 Tm (OTHER-VISIBLE) Tj ET';

async function fixture() {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 3; i++) pdf.addPage([220, 220]);
  const doc = await parsePDF(await pdf.save({ useObjectStreams: false }));
  const info = doc.objects.get(doc.xref.trailerDict.getRef('Info')!.toKey()) as PDFDict;
  for (const key of [...info.keys()]) info.delete(key);
  const group = new PDFRef(900, 0), font = new PDFRef(901, 0);
  doc.objects.set(group.toKey(), new PDFDict([['Type', new PDFName('OCG')], ['Name', new PDFString('Hidden layer')]]));
  doc.objects.set(font.toKey(), new PDFDict([['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')], ['BaseFont', new PDFName('Helvetica')]]));
  doc.catalog.set('OCProperties', new PDFDict([['OCGs', new PDFArray([group])], ['D', new PDFDict([['OFF', new PDFArray([group])]])]]));
  for (let i = 0; i < doc.pages.length; i++) {
    const page = doc.pages[i];
    page.resources.set('Font', new PDFDict([['F1', font]]));
    page.resources.set('Properties', new PDFDict([['Hidden', group]]));
    page.dict.set('Resources', page.resources);
    await updatePageContent(page.contentRefs, new TextEncoder().encode(i === 0 ? hiddenText : visibleText), doc.objects, false);
  }

  const rootRef = doc.catalog.getRef('Pages')!, root = doc.objects.get(rootRef.toKey()) as PDFDict;
  const leftRef = new PDFRef(910, 0), rightRef = new PDFRef(911, 0);
  const rootResourcesRef = new PDFRef(912, 0), rightResourcesRef = new PDFRef(913, 0);
  const innerRef = new PDFRef(914, 0);
  const firstResources = doc.pages[0].resources, secondResources = doc.pages[2].resources;
  doc.objects.set(rootResourcesRef.toKey(), firstResources);
  doc.objects.set(rightResourcesRef.toKey(), secondResources);
  const left = new PDFDict([['Type', new PDFName('Pages')], ['Parent', rootRef],
    ['Kids', new PDFArray([innerRef])], ['Count', new PDFNumber(2)]]);
  const inner = new PDFDict([['Type', new PDFName('Pages')], ['Parent', leftRef],
    ['Kids', new PDFArray([doc.pages[0].ref, doc.pages[1].ref])], ['Count', new PDFNumber(2)]]);
  const right = new PDFDict([['Type', new PDFName('Pages')], ['Parent', rootRef],
    ['Kids', new PDFArray([doc.pages[2].ref])], ['Count', new PDFNumber(1)], ['Resources', rightResourcesRef]]);
  doc.objects.set(leftRef.toKey(), left); doc.objects.set(rightRef.toKey(), right); doc.objects.set(innerRef.toKey(), inner);
  root.set('Kids', new PDFArray([leftRef, rightRef])); root.set('Count', new PDFNumber(3));
  root.set('Resources', rootResourcesRef);
  for (let i = 0; i < doc.pages.length; i++) {
    doc.pages[i].dict.set('Parent', i < 2 ? innerRef : rightRef);
    doc.pages[i].dict.delete('Resources');
  }
  return parsePDF(await serializeDocument(doc));
}

describe('nested page tree hidden text cleanup', () => {
  it('removes hidden text while preserving inherited and overridden sibling resources and pixels', async () => {
    const initial = await fixture(), original = await serializeDocument(initial);
    const result = await sanitizationEngine.sanitize(initial, options);
    expect(result.detail.layersRemoved).toBe(1);
    const output = await saveQuick(initial);
    expect(new TextDecoder().decode(output)).not.toContain(secret);
    expect(new TextDecoder().decode(output)).not.toContain('Hidden layer');
    const external = await PDFDocument.load(output, { updateMetadata: false });
    expect(external.getPageCount()).toBe(3);
    const reopened = await parsePDF(output);
    expect(reopened.catalog.has('OCProperties')).toBe(false);
    for (const page of reopened.pages) {
      expect(page.resources.has('Properties')).toBe(false);
      expect(page.resources.has('Font')).toBe(true);
    }
    if (spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).error || spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).error) return;
    const dir = mkdtempSync(join(tmpdir(), 'paperloom-hidden-nested-'));
    try {
      const before = join(dir, 'before.pdf'), after = join(dir, 'after.pdf');
      writeFileSync(before, original); writeFileSync(after, output);
      if (!spawnSync('qpdf', ['--version'], { stdio: 'ignore' }).error) {
        execFileSync('qpdf', ['--check', before], { stdio: 'ignore' });
        execFileSync('qpdf', ['--check', after], { stdio: 'ignore' });
      }
      const text = execFileSync('pdftotext', [after, '-'], { encoding: 'utf8' });
      expect(text).toContain('FIRST-VISIBLE'); expect(text).toContain('OTHER-VISIBLE');
      expect(text).not.toContain(secret);
      for (const dpi of [36, 72, 150, 300]) {
        execFileSync('pdftoppm', ['-r', String(dpi), before, join(dir, 'before')], { stdio: 'ignore' });
        execFileSync('pdftoppm', ['-r', String(dpi), after, join(dir, 'after')], { stdio: 'ignore' });
        for (let i = 1; i <= 3; i++) {
          expect(readFileSync(join(dir, `before-${i}.ppm`)).equals(readFileSync(join(dir, `after-${i}.ppm`)))).toBe(true);
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it('retains inspected ancestor font resources even when every descendant overrides them', async () => {
    const doc = await fixture();
    const root = doc.objects.get(doc.catalog.getRef('Pages')!.toKey()) as PDFDict;
    const child = doc.objects.get(((root.get('Kids') as PDFArray).items[0] as PDFRef).toKey()) as PDFDict;
    child.set('Resources', root.get('Resources')!);
    const font = new PDFRef(920, 0);
    doc.objects.set(font.toKey(), new PDFDict([['Type', new PDFName('Font')], ['Subtype', new PDFName('Type1')], ['BaseFont', new PDFName('Courier')]]));
    root.set('Resources', new PDFDict([['Font', new PDFDict([['F2', font]])]]));
    const parsed = await parsePDF(await serializeDocument(doc));
    await sanitizationEngine.sanitize(parsed, options);
    const reopened = await parsePDF(await saveQuick(parsed));
    const savedRoot = reopened.objects.get(reopened.catalog.getRef('Pages')!.toKey()) as PDFDict;
    const resources = savedRoot.get('Resources') as PDFDict;
    expect((resources.get('Font') as PDFDict).has('F2')).toBe(true);
    expect(resources.has('Properties')).toBe(false);
    expect(reopened.pages.every(page => page.resources.has('Font'))).toBe(true);
  });

  it('removes inherited hidden resources from a blank page while preserving its blank content', async () => {
    const doc = await fixture();
    doc.pages[2].dict.delete('Contents');
    doc.pages[2].contentRefs = [];
    const parsed = await parsePDF(await serializeDocument(doc));
    await sanitizationEngine.sanitize(parsed, options);
    const reopened = await parsePDF(await saveQuick(parsed));
    expect(reopened.pages[2].contentRefs).toHaveLength(0);
    expect(reopened.pages[2].resources.has('Font')).toBe(true);
    expect(reopened.pages[2].resources.has('Properties')).toBe(false);
  });

  it('rejects a hidden value split between visible text on other tree branches', async () => {
    const doc = await fixture();
    for (const [index, value] of [[1, 'PRIVATE-TREE-'], [2, '932']] as const) {
      const content = `BT /F1 12 Tf 1 0 0 1 20 80 Tm (${value}) Tj ET`;
      await updatePageContent(doc.pages[index].contentRefs, new TextEncoder().encode(content), doc.objects, false);
    }
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, options)).rejects.toThrow(/hidden layer|optional content/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it('rejects a hidden content stream shared across different branches', async () => {
    const doc = await fixture();
    doc.pages[2].dict.set('Contents', doc.pages[0].contentRefs[0]);
    doc.pages[2].contentRefs = [...doc.pages[0].contentRefs];
    const before = await serializeDocument(doc);
    await expect(sanitizationEngine.sanitize(doc, options)).rejects.toThrow(/hidden layer|optional content/i);
    expect(await serializeDocument(doc)).toEqual(before);
    expect(doc.requiresFullRewrite).toBeUndefined();
  });

  it.each(['count', 'parent', 'external-resources', 'external-stream', 'stale-cache', 'unsupported-inherited-resources'] as const)(
    'rejects %s before mutating the document', async condition => {
      const doc = await fixture();
      const root = doc.objects.get(doc.catalog.getRef('Pages')!.toKey()) as PDFDict;
      const children = root.get('Kids') as PDFArray;
      const left = doc.objects.get((children.items[0] as PDFRef).toKey()) as PDFDict;
      if (condition === 'count') left.set('Count', new PDFNumber(1));
      if (condition === 'parent') doc.pages[0].dict.set('Parent', doc.catalog.getRef('Pages')!);
      if (condition === 'external-resources') root.set('MediaBox', doc.pages[0].resources);
      if (condition === 'external-stream') root.set('MediaBox', doc.pages[0].contentRefs[0]);
      if (condition === 'stale-cache') doc.pages[0].resources = new PDFDict();
      if (condition === 'unsupported-inherited-resources') doc.pages[0].resources.set('Pattern', new PDFDict());
      const before = await serializeDocument(doc);
      await expect(sanitizationEngine.sanitize(doc, options)).rejects.toThrow(/hidden layer|optional content|page tree/i);
      expect(await serializeDocument(doc)).toEqual(before);
      expect(doc.requiresFullRewrite).toBeUndefined();
    },
  );
});
