'use client';

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button, Dialog, DialogFooter, Field, Notice, Select, TextInput } from '../../ui';
import { X, PenLine, Upload, Type, Eraser, Check } from 'lucide-react';
import {
  SignatureDrawEngine,
  importSignatureFile,
  isAllowedSignatureFile,
  renderTypedSignature,
  listTypedSignatureFonts,
  buildSignatureAppearance,
  renderSignatureAppearance,
  listAppearanceTemplates,
  type SignatureSourceKind,
  type SignatureLibraryEntry,
} from '@/engine/browser-core';

export interface SignatureCreateResult {
  entry: Omit<SignatureLibraryEntry, 'id' | 'createdAt' | 'updatedAt' | 'favorite'>;
  storage: 'session' | 'device';
  appearanceId?: string;
  appearanceImageDataUrl?: string;
}

interface SignatureCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (result: SignatureCreateResult) => void;
}

type Tab = 'draw' | 'upload' | 'typed';

export function SignatureCreateDialog({ open, onOpenChange, onSave }: SignatureCreateDialogProps) {
  const [tab, setTab] = useState<Tab>('draw');
  const [storage, setStorage] = useState<'session' | 'device'>('session');
  const [name, setName] = useState('My signature');
  const [drawColor, setDrawColor] = useState('#1a1a2e');
  const [drawWidth, setDrawWidth] = useState(2.5);
  const [typedText, setTypedText] = useState('');
  const [typedFont, setTypedFont] = useState(listTypedSignatureFonts()[0]);
  const [typedSize, setTypedSize] = useState(48);
  const [typedColor, setTypedColor] = useState('#1a1a2e');
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  const [uploadDims, setUploadDims] = useState<{ w: number; h: number } | null>(null);
  const [templateId, setTemplateId] = useState('minimal');
  const [error, setError] = useState<string | null>(null);
  const idPrefix = useId();
  // A new session clears transient upload and error state but retains style choices.
  const [previousOpen, setPreviousOpen] = useState(false);
  if (previousOpen !== open) {
    setPreviousOpen(open);
    if (open) {
      setUploadPreview(null);
      setUploadDims(null);
      setError(null);
      setStorage('session');
    }
  }

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef(new SignatureDrawEngine());
  const drawingRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // subtle guide line
    ctx.strokeStyle = '#e4e4e7';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(24, canvas.height * 0.72);
    ctx.lineTo(canvas.width - 24, canvas.height * 0.72);
    ctx.stroke();
    engineRef.current.paint(ctx);
  }, []);

  useEffect(() => {
    if (!open) return;
    engineRef.current = new SignatureDrawEngine({ color: drawColor, width: drawWidth });
    requestAnimationFrame(redraw);
  }, [open, redraw]);

  useEffect(() => {
    engineRef.current.setStyle({ color: drawColor, width: drawWidth });
  }, [drawColor, drawWidth]);

  const canvasPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * sx,
      y: (e.clientY - rect.top) * sy,
      pressure: e.pressure || undefined,
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    engineRef.current.beginStroke(canvasPoint(e));
    redraw();
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    engineRef.current.addPoint(canvasPoint(e));
    redraw();
  };
  const onPointerUp = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    engineRef.current.endStroke();
    redraw();
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      if (!isAllowedSignatureFile(file)) throw new Error('Use PNG, JPG, or SVG');
      const imported = await importSignatureFile(file);
      setUploadPreview(imported.imageDataUrl);
      setUploadDims({ w: imported.width, h: imported.height });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const buildEntry = async (): Promise<SignatureCreateResult | null> => {
    setError(null);
    let imageDataUrl = '';
    let width = 160;
    let height = 60;
    let source: SignatureSourceKind = 'draw';
    let typedMeta: Partial<SignatureLibraryEntry> = {};

    if (tab === 'draw') {
      const canvas = canvasRef.current;
      if (!canvas || engineRef.current.isEmpty()) {
        setError('Draw a signature first');
        return null;
      }
      const url = engineRef.current.toDataURL(canvas.width, canvas.height);
      if (!url) {
        setError('Could not export drawing');
        return null;
      }
      imageDataUrl = url;
      source = 'draw';
      // rough dims from canvas crop
      width = 200;
      height = 80;
    } else if (tab === 'upload') {
      if (!uploadPreview || !uploadDims) {
        setError('Upload a PNG, JPG, or SVG');
        return null;
      }
      imageDataUrl = uploadPreview;
      width = uploadDims.w;
      height = uploadDims.h;
      source = 'upload';
    } else {
      if (!typedText.trim()) {
        setError('Enter a name to type');
        return null;
      }
      const rendered = renderTypedSignature({
        text: typedText,
        fontFamily: typedFont,
        fontSize: typedSize,
        color: typedColor,
      });
      imageDataUrl = rendered.imageDataUrl;
      width = rendered.width;
      height = rendered.height;
      source = 'typed';
      typedMeta = {
        typedText: rendered.text,
        typedFont: rendered.fontFamily,
        typedColor: rendered.color,
        typedFontSize: rendered.fontSize,
      };
    }

    // Wrap with appearance template (Phase 3)
    const appearance = buildSignatureAppearance({
      templateId,
      name,
      signatureImageDataUrl: imageDataUrl,
      typedName: tab === 'typed' ? typedText : name,
      date: new Date().toLocaleDateString(),
    });
    const renderedAp = renderSignatureAppearance(appearance, {
      width: Math.max(220, width),
      height: Math.max(90, height + 40),
      preferVector: true,
    });

    return {
      storage,
      entry: {
        name,
        source,
        imageDataUrl: templateId === 'minimal' ? imageDataUrl : renderedAp.imageDataUrl,
        width: templateId === 'minimal' ? width : renderedAp.width,
        height: templateId === 'minimal' ? height : renderedAp.height,
        ...typedMeta,
      },
      appearanceId: appearance.id,
      appearanceImageDataUrl: renderedAp.imageDataUrl,
    };
  };

  const handleSave = async () => {
    const result = await buildEntry();
    if (!result) return;
    onSave(result);
    onOpenChange(false);
  };

  const fonts = listTypedSignatureFonts();
  const templates = listAppearanceTemplates();

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Create signature"
      description="Create a reusable signature and choose how to store it."
    >
      <Button variant="ghost" size="sm" aria-label="Close signature dialog" className="absolute right-3 top-3 w-8 px-0" onClick={() => onOpenChange(false)}>
        <X size={16} aria-hidden="true" />
      </Button>

      <div className="mt-4 flex border-b border-app">
        {(
          [
            ['draw', PenLine, 'Draw'],
            ['upload', Upload, 'Upload'],
            ['typed', Type, 'Type'],
          ] as const
        ).map(([id, Icon, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
            className={`-mb-px flex flex-1 items-center justify-center gap-2 border-b-2 py-2.5 text-xs font-medium transition-colors pointer-coarse:min-h-11 ${
              tab === id
                ? 'border-accent text-accent'
                : 'border-transparent text-app-muted hover:text-app'
            }`}
          >
            <Icon size={14} aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>

      <div className="mt-4 space-y-4">
        <Field label="Name">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        {tab === 'draw' && (
          <div className="space-y-3">
            <div className="flex items-center gap-3 text-xs text-app-muted">
              <label htmlFor={`${idPrefix}-ink`}>Ink</label>
              <input
                id={`${idPrefix}-ink`}
                type="color"
                value={drawColor}
                onChange={(e) => setDrawColor(e.target.value)}
                className="h-7 w-7 cursor-pointer rounded"
              />
              <label htmlFor={`${idPrefix}-width`} className="ml-2">Width</label>
              <input
                id={`${idPrefix}-width`}
                type="range"
                min={1}
                max={8}
                step={0.5}
                value={drawWidth}
                onChange={(e) => setDrawWidth(Number(e.target.value))}
                className="flex-1 accent-accent"
              />
              <Button
                size="sm"
                onClick={() => {
                  engineRef.current.clear();
                  redraw();
                }}
              >
                <Eraser size={12} aria-hidden="true" /> Clear
              </Button>
            </div>
            {/* The pad stays white: it previews ink on paper, not theme chrome. */}
            <canvas
              ref={canvasRef}
              width={520}
              height={180}
              className="w-full touch-none cursor-crosshair rounded-lg border border-app bg-white"
              style={{ touchAction: 'none' }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
            />
            <p className="text-[11px] text-app-muted">
              Draw with mouse, touch, or pen. Transparency is preserved on export.
            </p>
          </div>
        )}

        {tab === 'upload' && (
          <div className="space-y-3">
            <input
              ref={fileRef}
              type="file"
              accept=".png,.jpg,.jpeg,.svg,image/png,image/jpeg,image/svg+xml"
              className="hidden"
              onChange={handleUpload}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="w-full rounded-xl border border-dashed border-border-strong py-8 text-xs text-app-muted transition-colors hover:border-accent hover:text-accent"
            >
              Click to upload PNG, JPG, or SVG
            </button>
            {uploadPreview && (
              <div className="flex justify-center rounded-lg border border-app bg-white p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={uploadPreview}
                  alt="Upload preview"
                  className="max-h-32 object-contain"
                />
              </div>
            )}
          </div>
        )}

        {tab === 'typed' && (
          <div className="space-y-3">
            <TextInput
              value={typedText}
              onChange={(e) => setTypedText(e.target.value)}
              placeholder="Type your name"
              aria-label="Typed name"
            />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Font">
                <Select value={typedFont} onChange={(e) => setTypedFont(e.target.value)}>
                  {fonts.map((f) => (
                    <option key={f} value={f}>
                      {f.split(',')[0]}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="flex flex-col gap-1">
                <label htmlFor={`${idPrefix}-size`} className="text-xs font-medium text-app-muted">Size</label>
                <input
                  id={`${idPrefix}-size`}
                  type="range"
                  min={24}
                  max={72}
                  value={typedSize}
                  onChange={(e) => setTypedSize(Number(e.target.value))}
                  className="h-9 w-full accent-accent"
                />
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-app-muted">
              <label htmlFor={`${idPrefix}-color`}>Color</label>
              <input
                id={`${idPrefix}-color`}
                type="color"
                value={typedColor}
                onChange={(e) => setTypedColor(e.target.value)}
                className="h-7 w-7 cursor-pointer rounded"
              />
            </div>
            <div
              className="rounded-lg border border-app bg-white px-4 py-6 text-center"
              style={{
                fontFamily: typedFont,
                fontSize: typedSize * 0.55,
                color: typedColor,
              }}
            >
              {typedText.trim() || 'Your name'}
            </div>
          </div>
        )}

        <Field label="Appearance template">
          <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} — {t.description}
              </option>
            ))}
          </Select>
        </Field>

        <fieldset className="space-y-2 text-xs text-app">
          <legend className="mb-1 font-medium">Keep in signature library</legend>
          <label className="flex items-start gap-2">
            <input type="radio" name="signature-storage" className="accent-accent" checked={storage === 'session'} onChange={() => setStorage('session')} />
            <span>This session only (removed from the library on reload)</span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" name="signature-storage" className="accent-accent" checked={storage === 'device'} onChange={() => setStorage('device')} />
            <span>Save on this device (not encrypted)</span>
          </label>
          <p className="text-[11px] text-app-muted">Signatures placed in a PDF may also be kept in the document or its recovery data.</p>
        </fieldset>

        {error && <Notice tone="danger" className="text-xs">{error}</Notice>}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="primary" onClick={() => void handleSave()}>
          <Check size={14} aria-hidden="true" /> Save to library
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
