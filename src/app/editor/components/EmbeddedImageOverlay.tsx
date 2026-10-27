'use client';

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Replace, X } from 'lucide-react';
import type { ImageItem } from '@/engine/browser-core';
import type { PDFObject, PDFPageInfo } from '@/engine/types';
import { renderImagePreviewLayers, type ImagePreviewLayers } from '@/engine/render/renderer';
import type { ImageBox } from './imageBoxEdit';
import { Z_LAYERS } from '../zLayers';
import { resizeBox, type ResizeHandle } from './resizeGeometry';
import {
  computeImageToolbarPlacement,
  IMAGE_TOOLBAR_GAP,
  IMAGE_TOOLBAR_MARGIN,
  type ToolbarPlacement,
} from './imageToolbarPlacement';

interface EmbeddedImageOverlayProps {
  item: ImageItem;
  previewBox?: ImageBox | null;
  page: PDFPageInfo;
  objects: Map<string, PDFObject>;
  /** Convert PDF → CSS for the live bbox */
  toCss: (pdf: { x: number; y: number; width: number; height: number }) => {
    left: number; top: number; width: number; height: number;
  };
  scale: number;
  /** Commit move (PDF units). */
  onCommitMove: (pdfDx: number, pdfDy: number) => Promise<void>;
  /** Commit the new PDF bbox, keeping the opposite edge or corner fixed. */
  onCommitResize: (box: { x: number; y: number; width: number; height: number }) => Promise<void>;
  onReplace: () => void;
  onDeselect: () => void;
}

/** Canvas-local layers, contained by the isolated workspace. */
export const EMBEDDED_IMAGE_OVERLAY_LAYERS = {
  overlay: Z_LAYERS.canvasOverlay,
  handle: Z_LAYERS.canvasHandle,
} as const;

/**
 * Interactive frame over a selected embedded PDF image — drag + eight-handle resize.
 * Visual feedback is local; PDF mutation commits on pointer-up.
 */
export function EmbeddedImageOverlay(props: EmbeddedImageOverlayProps) {
  const {
    item, toCss, scale, previewBox, page, objects,
    onCommitMove, onCommitResize, onReplace, onDeselect,
  } = props;

  const [live, setLive] = useState({
    x: item.x, y: item.y, width: item.width, height: item.height,
  });
  const liveRef = useRef(live);
  liveRef.current = live;
  const [layers, setLayers] = useState<ImagePreviewLayers | null>(null);
  const cleanupDragRef = useRef<() => void>(() => {});
  const backgroundRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLive({ x: item.x, y: item.y, width: item.width, height: item.height });
    return () => cleanupDragRef.current();
  }, [item]);

  useEffect(() => {
    let cancelled = false;
    setLayers(null);
    void renderImagePreviewLayers(page, objects, item, scale).then(result => {
      if (!cancelled) setLayers(result);
    }).catch(error => console.error('[EmbeddedImageOverlay] preview failed', error));
    return () => { cancelled = true; };
  }, [page, objects, item, scale]);

  const dragMode = useRef<'move' | `resize-${ResizeHandle}` | null>(null);
  const origin = useRef({
    clientX: 0, clientY: 0,
    x: 0, y: 0, width: 0, height: 0,
  });

  const onPointerMove = useCallback((e: PointerEvent) => {
    const mode = dragMode.current;
    if (!mode) return;
    const dxCss = e.clientX - origin.current.clientX;
    const dyCss = e.clientY - origin.current.clientY;
    const dx = dxCss / scale;
    const dy = -dyCss / scale; // screen down → PDF down (y decreases)

    if (mode === 'move') {
      const next = {
        x: origin.current.x + dx,
        y: origin.current.y + dy,
        width: origin.current.width,
        height: origin.current.height,
      };
      liveRef.current = next;
      setLive(next);
    } else {
      const handle = mode.slice('resize-'.length) as ResizeHandle;
      const next = resizeBox(origin.current, handle, {
        dx, dy, minWidth: 8, minHeight: 8, free: e.shiftKey,
      });
      liveRef.current = next;
      setLive(next);
    }
  }, [scale]);

  const visibleBox = previewBox ?? live;
  const previewing = visibleBox.x !== item.x || visibleBox.y !== item.y ||
    visibleBox.width !== item.width || visibleBox.height !== item.height;
  useEffect(() => {
    if (!previewing || !layers) return;
    const background = backgroundRef.current;
    const image = imageRef.current;
    background?.replaceChildren(layers.background);
    image?.replaceChildren(layers.image);
    layers.image.style.width = '100%';
    layers.image.style.height = '100%';
    return () => {
      background?.replaceChildren();
      image?.replaceChildren();
    };
  }, [layers, previewing]);

  const endDragStable = useCallback(async () => {
    const mode = dragMode.current;
    cleanupDragRef.current();

    if (!mode) return;
    const cur = liveRef.current;
    const dx = cur.x - origin.current.x;
    const dy = cur.y - origin.current.y;
    try {
      if (mode === 'move') {
        if (Math.abs(dx) > 0.25 || Math.abs(dy) > 0.25) {
          await onCommitMove(dx, dy);
        }
      } else if (
        Math.abs(cur.width - origin.current.width) > 0.25 ||
        Math.abs(cur.height - origin.current.height) > 0.25
      ) {
        await onCommitResize({ x: cur.x, y: cur.y, width: cur.width, height: cur.height });
      }
    } catch (err) {
      console.error('[EmbeddedImageOverlay] commit failed', err);
      setLive({
        x: origin.current.x,
        y: origin.current.y,
        width: origin.current.width,
        height: origin.current.height,
      });
    }
  }, [onCommitMove, onCommitResize, onPointerMove]);

  const begin = useCallback((mode: 'move' | `resize-${ResizeHandle}`, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragMode.current = mode;
    e.currentTarget.setPointerCapture(e.pointerId);
    const target = e.currentTarget;
    const pointerId = e.pointerId;
    const cancel = () => {
      cleanupDragRef.current();
      setLive({ x: item.x, y: item.y, width: item.width, height: item.height });
    };
    cleanupDragRef.current = () => {
      dragMode.current = null;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', endDragStable);
      window.removeEventListener('pointercancel', cancel);
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
    };
    origin.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      x: liveRef.current.x,
      y: liveRef.current.y,
      width: liveRef.current.width,
      height: liveRef.current.height,
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDragStable);
    window.addEventListener('pointercancel', cancel);
  }, [onPointerMove, endDragStable, item]);

  const box = toCss(visibleBox);

  // Keep the quick-action toolbar outside the image and inside the visible canvas viewport.
  const frameRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarPlacement, setToolbarPlacement] = useState<ToolbarPlacement>({ side: 'above', offsetX: 0, offsetY: IMAGE_TOOLBAR_MARGIN });
  const updateToolbarPlacement = useCallback(() => {
    const frame = frameRef.current;
    const toolbar = toolbarRef.current;
    if (!frame || !toolbar) return;
    const viewportEl = frame.closest<HTMLElement>('[data-canvas-stack="true"]');
    const viewport = viewportEl
      ? viewportEl.getBoundingClientRect()
      : new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    const next = computeImageToolbarPlacement(
      frame.getBoundingClientRect(),
      viewport,
      { width: toolbar.offsetWidth, height: toolbar.offsetHeight },
    );
    setToolbarPlacement(prev => (prev.side === next.side && prev.offsetX === next.offsetX && prev.offsetY === next.offsetY ? prev : next));
  }, []);

  useLayoutEffect(() => {
    updateToolbarPlacement();
  }, [updateToolbarPlacement, box.left, box.top, box.width, box.height]);

  useEffect(() => {
    const viewportEl = frameRef.current?.closest<HTMLElement>('[data-canvas-stack="true"]');
    viewportEl?.addEventListener('scroll', updateToolbarPlacement, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateToolbarPlacement);
    if (viewportEl) observer?.observe(viewportEl);
    if (toolbarRef.current) observer?.observe(toolbarRef.current);
    window.addEventListener('resize', updateToolbarPlacement);
    return () => {
      viewportEl?.removeEventListener('scroll', updateToolbarPlacement);
      observer?.disconnect();
      window.removeEventListener('resize', updateToolbarPlacement);
    };
  }, [updateToolbarPlacement]);

  return (
    <>
    {previewing && layers && (
      <div
        ref={backgroundRef}
        className="absolute inset-0 pointer-events-none"
        style={{ zIndex: EMBEDDED_IMAGE_OVERLAY_LAYERS.overlay }}
      />
    )}
    {previewing && layers && (
      <div
        ref={imageRef}
        className="absolute pointer-events-none"
        style={{ zIndex: EMBEDDED_IMAGE_OVERLAY_LAYERS.overlay, left: box.left, top: box.top, width: box.width, height: box.height }}
      />
    )}
    <div
      ref={frameRef}
      className="absolute pointer-events-auto border-2 border-[#3b82f6] border-dashed bg-[#3b82f6]/10 cursor-move"
      style={{ zIndex: EMBEDDED_IMAGE_OVERLAY_LAYERS.overlay, left: box.left, top: box.top, width: box.width, height: box.height }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => begin('move', e)}
    >
      <div
        ref={toolbarRef}
        data-image-toolbar={toolbarPlacement.side}
        className="absolute flex items-center gap-1"
        style={{
          left: toolbarPlacement.offsetX,
          ...(toolbarPlacement.side === 'above' && { bottom: `calc(100% + ${IMAGE_TOOLBAR_GAP}px)` }),
          ...(toolbarPlacement.side === 'below' && { top: `calc(100% + ${IMAGE_TOOLBAR_GAP}px)` }),
          ...(toolbarPlacement.side === 'inside' && { top: toolbarPlacement.offsetY, marginLeft: IMAGE_TOOLBAR_MARGIN }),
        }}
      >
        <button
          type="button"
          title="Replace image (keep size)"
          className="flex items-center gap-1 px-2 py-1 bg-[#3b82f6] text-white text-[11px] font-medium rounded border border-[#2563eb] hover:bg-[#2563eb] shadow"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onReplace();
          }}
        >
          <Replace size={12} /> Replace
        </button>
        <button
          type="button"
          title="Deselect"
          aria-label="Deselect image"
          className="p-1 bg-white text-[#3b82f6] rounded border border-[#3b82f6]/60 hover:bg-[#eff6ff] shadow"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onDeselect();
          }}
        >
          <X size={12} />
        </button>
      </div>

      {([
        ['nw', 0, 0, 'cursor-nwse-resize'], ['ne', 1, 0, 'cursor-nesw-resize'],
        ['sw', 0, 1, 'cursor-nesw-resize'], ['se', 1, 1, 'cursor-nwse-resize'],
        ['n', 0.5, 0, 'cursor-ns-resize'], ['s', 0.5, 1, 'cursor-ns-resize'],
        ['e', 1, 0.5, 'cursor-ew-resize'], ['w', 0, 0.5, 'cursor-ew-resize'],
      ] as const).map(([handle, hx, hy, cursor]) => (
        <div
          key={handle}
          data-handle={handle}
          className={`absolute w-2.5 h-2.5 bg-[#3b82f6] border border-white rounded-sm pointer-events-auto ${cursor}`}
          style={{
            zIndex: EMBEDDED_IMAGE_OVERLAY_LAYERS.handle,
            left: hx === 0 ? -5 : hx === 0.5 ? '50%' : undefined,
            right: hx === 1 ? -5 : undefined,
            top: hy === 0 ? -5 : hy === 0.5 ? '50%' : undefined,
            bottom: hy === 1 ? -5 : undefined,
            transform: hx === 0.5 ? 'translateX(-50%)' : hy === 0.5 ? 'translateY(-50%)' : undefined,
          }}
          onPointerDown={(e) => begin(`resize-${handle}`, e)}
        />
      ))}
    </div>
    </>
  );
}
