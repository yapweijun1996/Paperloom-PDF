import { describe, expect, it, vi } from 'vitest';
import type { PDFDocumentData } from '@/engine/browser-core';
import { EXPORT_FORMATS, exportDocument, type ExportFormat, type ExportOptions } from './export-formats';

const doc = { pages: Array.from({ length: 3 }, () => ({ mediaBox: { width: 200, height: 300 } })) } as unknown as PDFDocumentData;
const renderPage = vi.fn(async () => ({ pageWidth: 200, pageHeight: 300, canvas: {
  toDataURL: () => 'data:image/png;base64,UE5H',
  toBlob: (callback: (blob: Blob) => void, type: string) => callback(new Blob(['image'], { type })),
} }));
const extractPagePlainText = vi.fn((_doc: PDFDocumentData, page: number) => `page ${page + 1}`);
const engine = { renderPage, extractPagePlainText } as unknown as typeof import('@/engine/browser-core');
const options = (format: ExportFormat, pages: number[] | null): ExportOptions => ({ format, pages, dpi: 150, quality: 0.9, title: 'test' });

describe('export page selection', () => {
  it.each(['png', 'jpeg', 'svg', 'txt'] as const)('rejects empty and invalid pages for %s', async format => {
    for (const pages of [[], [-1], [3], [1.5], [Number.NaN]]) {
      await expect(exportDocument(doc, engine, options(format, pages))).rejects.toThrow(/valid page/i);
    }
  });

  it.each(['png', 'jpeg', 'svg', 'txt'] as const)('exports the requested single and multiple pages for %s', async format => {
    const single = await exportDocument(doc, engine, options(format, [1]));
    const multiple = await exportDocument(doc, engine, options(format, [0, 2]));
    expect(single.blob.size).toBeGreaterThan(0);
    expect(multiple.blob.size).toBeGreaterThan(0);
    expect(multiple.filename).toMatch(format === 'txt' ? /\.txt$/ : /\.zip$/);
    if (format === 'txt') expect(await multiple.blob.text()).toBe('page 1\n\n--- Page Break ---\n\npage 3');
  });

  it('describes SVG output as an embedded raster image', async () => {
    expect(EXPORT_FORMATS.find(item => item.id === 'svg')?.description).toMatch(/raster PNG/i);
    const result = await exportDocument(doc, engine, options('svg', [0]));
    expect(await result.blob.text()).toContain('<image');
    expect(await result.blob.text()).toContain('data:image/png;base64,UE5H');
    expect(await result.blob.text()).toContain('viewBox="0 0 200 300"');
  });

  it.each(['png', 'jpeg'] as const)('renders %s with a DPI scale independent of display density', async format => {
    renderPage.mockClear();
    await exportDocument(doc, engine, options(format, [0]));
    expect(renderPage).toHaveBeenCalledWith(doc, 0, { scale: 150 / 72, devicePixelRatio: 1, renderWidgets: 'form' });
  });
});
