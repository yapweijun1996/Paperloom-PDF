/**
 * Unit tests — visual signature Phases 1–3.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createVisualSignature,
  hitTestSignature,
  moveSignature,
  resizeSignature,
  rotateSignature,
  deleteSignature,
  updateSignature,
  setSignatureLocked,
  setSignatureOpacity,
  resetSignatureIdCounter,
  SignatureHistory,
  SignatureDrawEngine,
  strokeToPathD,
  resetSignatureLibraryForTests,
  buildSignatureAppearance,
  setAppearanceComponentVisible,
  updateAppearanceLayout,
  listAppearanceTemplates,
  getAppearanceTemplate,
  buildAppearanceSVG,
  renderSignatureAppearance,
  typedSignatureToSVG,
  importSvgString,
  DEFAULT_SIGNATURE_SIZE,
} from '../../signatures';

describe('Phase 1 — signature model', () => {
  beforeEach(() => resetSignatureIdCounter());

  it('creates a signature with required fields', () => {
    const sig = createVisualSignature({
      pageIndex: 0,
      x: 100,
      y: 200,
      appearanceId: 'lib-1',
      appearanceType: 'drawn',
    });
    expect(sig.id).toBeTruthy();
    expect(sig.pageIndex).toBe(0);
    expect(sig.width).toBe(DEFAULT_SIGNATURE_SIZE.width);
    expect(sig.height).toBe(DEFAULT_SIGNATURE_SIZE.height);
    expect(sig.rotation).toBe(0);
    expect(sig.opacity).toBe(1);
    expect(sig.locked).toBe(false);
    expect(sig.appearanceType).toBe('drawn');
    expect(sig.appearanceId).toBe('lib-1');
    // centered on click point
    expect(sig.x).toBeCloseTo(100 - DEFAULT_SIGNATURE_SIZE.width / 2);
    expect(sig.y).toBeCloseTo(200 - DEFAULT_SIGNATURE_SIZE.height / 2);
  });

  it('hit-tests and ignores other pages', () => {
    const a = createVisualSignature({
      pageIndex: 0,
      x: 50,
      y: 50,
      appearanceId: 'a',
      appearanceType: 'uploaded',
      width: 40,
      height: 20,
    });
    const b = createVisualSignature({
      pageIndex: 1,
      x: 50,
      y: 50,
      appearanceId: 'b',
      appearanceType: 'typed',
      width: 40,
      height: 20,
    });
    const hit = hitTestSignature([a, b], 0, a.x + 5, a.y + 5);
    expect(hit?.id).toBe(a.id);
    expect(hitTestSignature([a, b], 0, 999, 999)).toBeNull();
  });

  it('supports move, resize, rotate, opacity, lock, delete', () => {
    let sig = createVisualSignature({
      pageIndex: 0,
      x: 0,
      y: 0,
      appearanceId: 'x',
      appearanceType: 'drawn',
      width: 100,
      height: 40,
    });
    sig = moveSignature(sig, 10, -5);
    expect(sig.x).toBeCloseTo(-50 + 10);
    expect(sig.y).toBeCloseTo(-20 - 5);

    sig = resizeSignature(sig, 120, 50);
    expect(sig.width).toBe(120);
    expect(sig.height).toBe(50);

    sig = rotateSignature(sig, 45);
    expect(sig.rotation).toBe(45);

    sig = setSignatureOpacity(sig, 0.5);
    expect(sig.opacity).toBe(0.5);

    sig = setSignatureLocked(sig, true);
    expect(moveSignature(sig, 100, 100)).toEqual(sig);

    const list = deleteSignature([sig], sig.id);
    expect(list).toHaveLength(0);
  });

  it('updateSignature maps by id', () => {
    const a = createVisualSignature({
      pageIndex: 0,
      x: 0,
      y: 0,
      appearanceId: 'a',
      appearanceType: 'drawn',
    });
    const b = createVisualSignature({
      pageIndex: 0,
      x: 10,
      y: 10,
      appearanceId: 'b',
      appearanceType: 'drawn',
    });
    const next = updateSignature([a, b], a.id, (s) => rotateSignature(s, 90));
    expect(next.find((s) => s.id === a.id)?.rotation).toBe(90);
    expect(next.find((s) => s.id === b.id)?.rotation).toBe(0);
  });

  it('SignatureHistory undo/redo', () => {
    const hist = new SignatureHistory();
    const s1 = createVisualSignature({
      pageIndex: 0,
      x: 0,
      y: 0,
      appearanceId: '1',
      appearanceType: 'drawn',
    });
    hist.seed([], 'init');
    hist.push([s1], 'add');
    expect(hist.canUndo()).toBe(true);
    const undone = hist.undo();
    expect(undone).toEqual([]);
    const redone = hist.redo();
    expect(redone).toHaveLength(1);
    expect(redone![0].id).toBe(s1.id);
  });
});

describe('Phase 2 — draw / library / typed / import', () => {
  it('draw engine records strokes and exports SVG paths', () => {
    const eng = new SignatureDrawEngine({ color: '#000', width: 2 });
    eng.beginStroke({ x: 0, y: 0 });
    eng.addPoint({ x: 10, y: 5 });
    eng.addPoint({ x: 20, y: 0 });
    eng.endStroke();
    expect(eng.isEmpty()).toBe(false);
    expect(eng.getStrokes()).toHaveLength(1);
    const d = strokeToPathD(eng.getStrokes()[0].points);
    expect(d.startsWith('M ')).toBe(true);
    const svg = eng.toSVG(100, 50);
    expect(svg).toContain('<path');
    eng.clear();
    expect(eng.isEmpty()).toBe(true);
  });

  it('library rename / delete / duplicate / favorites', () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => {
        mem.set(k, v);
      },
      removeItem: (k: string) => {
        mem.delete(k);
      },
      clear: () => mem.clear(),
      key: () => null,
      length: 0,
    } as Storage;

    const lib = resetSignatureLibraryForTests(storage);
    const entry = lib.add({
      name: 'Mine',
      source: 'draw',
      imageDataUrl: 'data:image/png;base64,abc',
      width: 100,
      height: 40,
    });
    expect(lib.list()).toHaveLength(1);

    lib.rename(entry.id, 'Renamed');
    expect(lib.get(entry.id)?.name).toBe('Renamed');

    lib.setFavorite(entry.id, true);
    expect(lib.favorites()).toHaveLength(1);

    const dup = lib.duplicate(entry.id);
    expect(dup?.name).toBe('Renamed copy');
    expect(lib.list()).toHaveLength(2);

    lib.delete(entry.id);
    expect(lib.get(entry.id)).toBeNull();
    expect(lib.list()).toHaveLength(1);
  });

  it('typed signature produces SVG', () => {
    const svg = typedSignatureToSVG({
      text: 'Jane Doe',
      fontSize: 36,
      color: '#112233',
    });
    expect(svg).toContain('Jane Doe');
    expect(svg).toContain('#112233');
  });

  it('imports SVG with transparency flag', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><circle cx="10" cy="10" r="5" fill="black"/></svg>';
    const imported = await importSvgString(svg);
    expect(imported.hasTransparency).toBe(true);
    expect(imported.mimeType).toBe('image/svg+xml');
    expect(imported.width).toBe(120);
    expect(imported.height).toBe(40);
    expect(imported.imageDataUrl.startsWith('data:image/svg+xml')).toBe(true);
  });
});

describe('Phase 3 — appearance builder / renderer / templates', () => {
  it('lists templates and builds from template', () => {
    const templates = listAppearanceTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(3);
    expect(getAppearanceTemplate('standard')).not.toBeNull();

    const ap = buildSignatureAppearance({
      templateId: 'name-date-reason',
      typedName: 'Alex Rivera',
      date: '2026-07-15',
      reason: 'Approved',
      signatureImageDataUrl: 'data:image/png;base64,xx',
    });
    expect(ap.typedName.visible).toBe(true);
    expect(ap.typedName.text).toBe('Alex Rivera');
    expect(ap.date.text).toBe('2026-07-15');
    expect(ap.reason.visible).toBe(true);
    expect(ap.signatureImage.imageDataUrl).toBeTruthy();
  });

  it('toggles components and updates layout', () => {
    let ap = buildSignatureAppearance({
      templateId: 'standard',
      typedName: 'Test',
      date: 'today',
    });
    ap = setAppearanceComponentVisible(ap, 'date', false);
    expect(ap.date.visible).toBe(false);
    ap = updateAppearanceLayout(ap, { alignment: 'center', padding: 16 });
    expect(ap.layout.alignment).toBe('center');
    expect(ap.layout.padding).toBe(16);
  });

  it('renders vector SVG appearance', () => {
    const ap = buildSignatureAppearance({
      templateId: 'standard',
      typedName: 'Sam',
      date: 'Jul 15, 2026',
      signatureImageDataUrl: 'data:image/png;base64,abc',
      visibility: { background: true, border: true },
    });
    const svg = buildAppearanceSVG(ap, 240, 100);
    expect(svg).toContain('<svg');
    expect(svg).toContain('Sam');
    expect(svg).toContain('Date: Jul 15, 2026');

    const result = renderSignatureAppearance(ap, { width: 240, height: 100, preferVector: true });
    expect(result.svg).toBeTruthy();
    expect(result.imageDataUrl.startsWith('data:image/svg+xml')).toBe(true);
  });

  it('respects show/hide for every component', () => {
    const ap = buildSignatureAppearance({
      typedName: 'A',
      date: 'B',
      reason: 'C',
      location: 'D',
      contactInfo: 'E',
      visibility: {
        typedName: false,
        date: false,
        reason: false,
        location: false,
        contactInfo: false,
        background: false,
        border: false,
        signatureImage: false,
        logo: false,
      },
    });
    const svg = buildAppearanceSVG(ap, 100, 50);
    expect(svg).not.toContain('>A<');
    expect(svg).not.toContain('Reason');
  });
});
