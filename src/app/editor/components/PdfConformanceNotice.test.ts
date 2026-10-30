// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PDFDict, PDFStream, type PDFDocumentData } from '@/engine/types';
import { PdfConformanceNotice } from './PdfConformanceNotice';

let element: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); element = document.createElement('div'); document.body.append(element); root = createRoot(element); });
afterEach(() => { act(() => root.unmount()); element.remove(); vi.unstubAllGlobals(); });

it('warns when a document with a PDF/A claim is edited and does not warn while unchanged', () => {
  const xml = '<xmp xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="2"/>';
  const catalog = new PDFDict([['Metadata', new PDFStream(new PDFDict(), new TextEncoder().encode(xml))]]);
  const doc = { catalog, objects: new Map() } as unknown as PDFDocumentData;
  act(() => root.render(createElement(PdfConformanceNotice, { doc, isDirty: false })));
  expect(element.querySelector('[role="status"]')).toBeNull();
  act(() => root.render(createElement(PdfConformanceNotice, { doc, isDirty: true })));
  expect(element.querySelector('[role="status"]')?.textContent).toMatch(/PDF\/A.*may invalidate/i);
  act(() => root.render(createElement(PdfConformanceNotice, { doc, isDirty: true, announce: false })));
  expect(element.querySelector('[role="status"]')).toBeNull();
  expect(element.textContent).toMatch(/PDF\/A.*may invalidate/i);
});

it('warns that the claim is unknown when metadata cannot be parsed', () => {
  const catalog = new PDFDict([['Metadata', new PDFStream(new PDFDict(), new TextEncoder().encode('<xmp>'))]]);
  const doc = { catalog, objects: new Map() } as unknown as PDFDocumentData;
  act(() => root.render(createElement(PdfConformanceNotice, { doc, isDirty: true })));
  expect(element.querySelector('[role="status"]')?.textContent).toMatch(/could not be checked/i);
});
