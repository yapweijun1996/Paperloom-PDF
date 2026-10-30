'use client';

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PenLine, Lock, Trash2, RotateCw, X } from 'lucide-react';
import type { VisualSignature } from '@/engine/browser-core';
import { resizeRotatedBox, type ResizeHandle } from '../resizeGeometry';
import { Z_LAYERS } from '../../zLayers';

export interface SignatureOverlayProps {
  signature: VisualSignature;
  /** Resolved appearance image (PNG/SVG data URL). */
  imageDataUrl: string | null;
  pageRotation?: number;
  clipViewport?: { width: number; height: number };
  /** The image is an optional native field appearance, not a library fallback. */
  fieldPreview?: boolean;
  scale: number;
  selected: boolean;
  interactive?: boolean;
  toCss: (pdf: { x: number; y: number; width: number; height: number }) => {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  onSelect: (id: string) => void;
  onCommitMove: (id: string, dx: number, dy: number) => void;
  onCommitResize: (id: string, box: { x: number; y: number; width: number; height: number }) => void;
  onCommitRotate: (id: string, degrees: number) => void;
  onDelete: (id: string) => void;
  onDeselect: () => void;
}

type DragMode = 'move' | `resize-${ResizeHandle}` | 'rotate' | null;

/**
 * Interactive signature overlay — select, move, resize, rotate, delete.
 * Renders above page contents; mutations commit on pointer-up.
 */
export function SignatureOverlay(props: SignatureOverlayProps) {
  const {
    signature: sig,
    imageDataUrl,
    pageRotation = 0,
    clipViewport,
    fieldPreview = false,
    scale,
    selected,
    interactive = true,
    toCss,
    onSelect,
    onCommitMove,
    onCommitResize,
    onCommitRotate,
    onDelete,
    onDeselect,
  } = props;

  const [live, setLive] = useState({
    x: sig.x,
    y: sig.y,
    width: sig.width,
    height: sig.height,
    rotation: sig.rotation,
  });
  const overlayRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef(live);
  useLayoutEffect(() => { liveRef.current = live; }, [live]);

  useEffect(() => {
    // External undo/redo replaces the committed signature while a local preview may exist.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLive({
      x: sig.x,
      y: sig.y,
      width: sig.width,
      height: sig.height,
      rotation: sig.rotation,
    });
  }, [sig.x, sig.y, sig.width, sig.height, sig.rotation, sig.id]);

  const dragMode = useRef<DragMode>(null);
  const pointerId = useRef<number | null>(null);
  const cleanupGesture = useRef<() => void>(() => {});
  useEffect(() => () => cleanupGesture.current(), []);
  const interactiveRef = useRef(interactive);
  const gestureAllowedRef = useRef(interactive);
  useLayoutEffect(() => {
    interactiveRef.current = interactive;
    if (!interactive) gestureAllowedRef.current = false;
  }, [interactive]);
  const origin = useRef({
    clientX: 0,
    clientY: 0,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    rotation: 0,
  });

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const mode = dragMode.current;
      if (!mode || e.pointerId !== pointerId.current || sig.locked || !interactiveRef.current || !gestureAllowedRef.current) return;
      const dxCss = e.clientX - origin.current.clientX;
      const dyCss = e.clientY - origin.current.clientY;
      const sx = dxCss / scale;
      const sy = dyCss / scale;
      const dx = pageRotation === 90 ? sy : pageRotation === 180 ? -sx : pageRotation === 270 ? -sy : sx;
      const dy = pageRotation === 90 ? sx : pageRotation === 180 ? sy : pageRotation === 270 ? -sx : -sy;

      if (mode === 'move') {
        setLive({
          ...liveRef.current,
          x: origin.current.x + dx,
          y: origin.current.y + dy,
        });
      } else if (mode.startsWith('resize-')) {
        const handle = mode.slice('resize-'.length) as ResizeHandle;
        const edge = handle.length === 1;
        const resized = resizeRotatedBox(origin.current, handle, {
          dx, dy, minWidth: edge ? 8 : 24, minHeight: edge ? 8 : 16, free: e.shiftKey,
        }, origin.current.rotation);
        setLive({
          ...liveRef.current,
          ...resized,
        });
      } else if (mode === 'rotate') {
        const angle =
          pageRotation - ((Math.atan2(e.clientY - (origin.current as { cy?: number }).cy!, e.clientX - (origin.current as { cx?: number }).cx!) *
            180) / Math.PI + 90);
        setLive({
          ...liveRef.current,
          rotation: ((angle % 360) + 360) % 360,
        });
      }
    },
    [scale, sig.locked, pageRotation],
  );

  const endDrag = useCallback(function handlePointerUp(e: PointerEvent) {
    if (e.pointerId !== pointerId.current) return;
    const mode = dragMode.current;
    dragMode.current = null;
    pointerId.current = null;
    cleanupGesture.current();
    if (!mode || sig.locked) return;

    if (!interactiveRef.current || !gestureAllowedRef.current) {
      setLive({ x: sig.x, y: sig.y, width: sig.width, height: sig.height, rotation: sig.rotation });
      return;
    }

    const cur = liveRef.current;
    if (mode === 'move') {
      const dx = cur.x - origin.current.x;
      const dy = cur.y - origin.current.y;
      if (Math.abs(dx) > 0.25 || Math.abs(dy) > 0.25) {
        onCommitMove(sig.id, dx, dy);
      }
    } else if (mode.startsWith('resize-')) {
      if (
        Math.abs(cur.width - origin.current.width) > 0.25 ||
        Math.abs(cur.height - origin.current.height) > 0.25
      ) {
        onCommitResize(sig.id, { x: cur.x, y: cur.y, width: cur.width, height: cur.height });
      }
    } else if (mode === 'rotate') {
      if (Math.abs(cur.rotation - origin.current.rotation) > 0.5) {
        onCommitRotate(sig.id, cur.rotation);
      }
    }
  }, [onCommitMove, onCommitResize, onCommitRotate, sig.id, sig.locked, sig.x, sig.y, sig.width, sig.height, sig.rotation]);

  const begin = useCallback(
    (mode: DragMode, e: React.PointerEvent) => {
      if (!mode || !interactiveRef.current || dragMode.current) return;
      gestureAllowedRef.current = true;
      e.preventDefault();
      e.stopPropagation();
      onSelect(sig.id);
      if (sig.locked && mode !== null) return;
      dragMode.current = mode;
      pointerId.current = e.pointerId;
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      const rect = overlayRef.current?.getBoundingClientRect();
      origin.current = {
        clientX: e.clientX,
        clientY: e.clientY,
        x: liveRef.current.x,
        y: liveRef.current.y,
        width: liveRef.current.width,
        height: liveRef.current.height,
        rotation: liveRef.current.rotation,
        ...( {
          cx: (rect?.left ?? 0) + (rect?.width ?? 0) / 2,
          cy: (rect?.top ?? 0) + (rect?.height ?? 0) / 2,
        } as object),
      };
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', endDrag);
      const cancel = (event: PointerEvent) => {
        if (event.pointerId !== pointerId.current) return;
        gestureAllowedRef.current = false;
        endDrag(event);
      };
      window.addEventListener('pointercancel', cancel);
      cleanupGesture.current = () => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', endDrag);
        window.removeEventListener('pointercancel', cancel);
        if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId);
      };
    },
    [endDrag, onPointerMove, onSelect, sig.id, sig.locked],
  );

  const box = toCss(live);
  const angle = (pageRotation - live.rotation) * Math.PI / 180;
  const centerX = box.left + box.width / 2, centerY = box.top + box.height / 2;
  const clip = clipViewport ? [[0, 0], [clipViewport.width, 0], [clipViewport.width, clipViewport.height], [0, clipViewport.height]]
    .map(([x, y]) => {
      const dx = x - centerX, dy = y - centerY;
      return `${Math.cos(angle) * dx + Math.sin(angle) * dy + box.width / 2}px ${-Math.sin(angle) * dx + Math.cos(angle) * dy + box.height / 2}px`;
    }).join(', ') : null;

  return (
    <div
      ref={overlayRef}
      className="absolute pointer-events-none"
      style={{
        zIndex: Z_LAYERS.canvasOverlay,
        left: box.left + box.width / 2,
        top: box.top + box.height / 2,
        width: box.width,
        height: box.height,
        transform: `translate(-50%, -50%) rotate(${pageRotation - live.rotation}deg)`,
        opacity: sig.opacity,
        touchAction: interactive && !sig.locked ? 'none' : undefined,
      }}
      onPointerDown={(e) => {
        if (!interactiveRef.current) return;
        e.stopPropagation();
        onSelect(sig.id);
        if (!sig.locked) begin('move', e);
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {imageDataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageDataUrl}
          alt="Signature"
          draggable={false}
          className="w-full h-full object-contain select-none"
          style={{ pointerEvents: interactive ? 'auto' : 'none', ...(clip ? { clipPath: `polygon(${clip})` } : {}) }}
        />
      ) : fieldPreview ? (
        <div aria-label="Signature field preview unavailable" className="w-full h-full border border-dashed border-zinc-400" style={{ pointerEvents: interactive ? 'auto' : 'none', ...(clip ? { clipPath: `polygon(${clip})` } : {}) }} />
      ) : (
        <div className="w-full h-full border border-dashed border-zinc-400 bg-zinc-100/40 flex items-center justify-center" style={{ pointerEvents: interactive ? 'auto' : 'none', ...(clip ? { clipPath: `polygon(${clip})` } : {}) }}>
          <PenLine size={16} className="text-zinc-400" />
        </div>
      )}

      {selected && interactive && (
        <>
          <div
            className={`absolute inset-0 border-2 ${sig.locked ? 'border-amber-500' : 'border-accent'} border-dashed pointer-events-none`}
          />
          <div className="absolute -top-8 left-0 flex items-center gap-1 whitespace-nowrap pointer-events-auto">
            <span className="flex items-center gap-1 px-1.5 py-0.5 bg-bloom-500 text-white text-[10px] rounded shadow">
              <PenLine size={10} /> Signature
              {sig.locked && <Lock size={10} />}
            </span>
            <button
              type="button"
              title="Rotate 15°"
              className="p-0.5 bg-zinc-800 text-zinc-200 rounded border border-zinc-600 hover:bg-zinc-700 shadow"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                if (!sig.locked) onCommitRotate(sig.id, (sig.rotation + 15) % 360);
              }}
            >
              <RotateCw size={10} />
            </button>
            <button
              type="button"
              title="Delete"
              className="p-0.5 bg-red-600 text-white rounded border border-red-500 hover:bg-red-500 shadow"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(sig.id);
              }}
            >
              <Trash2 size={10} />
            </button>
            <button
              type="button"
              title="Deselect"
              className="p-0.5 bg-zinc-800 text-zinc-300 rounded border border-zinc-600 hover:bg-zinc-700 shadow"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onDeselect();
              }}
            >
              <X size={10} />
            </button>
          </div>

          {!sig.locked && (
            <>
              {([
                ['nw', 0, 0, 'cursor-nwse-resize'], ['ne', 1, 0, 'cursor-nesw-resize'],
                ['sw', 0, 1, 'cursor-nesw-resize'], ['se', 1, 1, 'cursor-nwse-resize'],
                ['n', 0.5, 0, 'cursor-ns-resize'], ['s', 0.5, 1, 'cursor-ns-resize'],
                ['e', 1, 0.5, 'cursor-ew-resize'], ['w', 0, 0.5, 'cursor-ew-resize'],
              ] as const).map(([handle, hx, hy, cursor]) => (
                <div
                  key={handle}
                  data-handle={handle}
                  className={`absolute w-2.5 h-2.5 bg-accent border border-white rounded-sm pointer-events-auto ${cursor}`}
                  style={{
                    zIndex: Z_LAYERS.canvasHandle,
                    left: hx === 0 ? -5 : hx === 0.5 ? '50%' : undefined,
                    right: hx === 1 ? -5 : undefined,
                    top: hy === 0 ? -5 : hy === 0.5 ? '50%' : undefined,
                    bottom: hy === 1 ? -5 : undefined,
                    transform: hx === 0.5 ? 'translateX(-50%)' : hy === 0.5 ? 'translateY(-50%)' : undefined,
                  }}
                  onPointerDown={(e) => begin(`resize-${handle}`, e)}
                />
              ))}
              <div
                className="absolute w-2.5 h-2.5 bg-emerald-500 border border-white rounded-full cursor-grab pointer-events-auto"
                style={{ zIndex: Z_LAYERS.canvasHandle, left: '50%', top: -18, transform: 'translateX(-50%)' }}
                onPointerDown={(e) => begin('rotate', e)}
                title="Drag to rotate"
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
