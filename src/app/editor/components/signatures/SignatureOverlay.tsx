'use client';

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Minimize2, Move, PenLine, Lock, SlidersHorizontal, Trash2, RotateCw, X } from 'lucide-react';
import type { VisualSignature } from '@/engine/browser-core';
import { resizeRotatedBox, type ResizeHandle } from '../resizeGeometry';
import type { SignatureResizeStep } from '../../signature-touch-steps';
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
  onStepResize: (id: string, step: SignatureResizeStep) => void;
  onStepRotate: (id: string, degrees: number) => void;
  onDelete: (id: string) => void;
  onDeselect: () => void;
}

type DragMode = 'move' | `resize-${ResizeHandle}` | 'rotate' | 'rotate-touch' | null;

function subscribeCoarsePointer(notify: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const query = window.matchMedia('(pointer: coarse)');
  if (query.addEventListener) {
    query.addEventListener('change', notify);
    return () => query.removeEventListener('change', notify);
  }
  query.addListener(notify);
  return () => query.removeListener(notify);
}

function coarsePointerSnapshot(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
}

const serverCoarsePointerSnapshot = () => false;

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
    onStepResize,
    onStepRotate,
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
  const [touchControlsOpen, setTouchControlsOpen] = useState(false);
  const [touchGestureActive, setTouchGestureActive] = useState(false);
  const coarsePointer = useSyncExternalStore(subscribeCoarsePointer, coarsePointerSnapshot, serverCoarsePointerSnapshot);
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
  const panelGesture = useRef(false);
  const cleanupGesture = useRef<() => void>(() => {});
  const suppressedPanelPointer = useRef<number | null>(null);
  const blockedPanelPointers = useRef(new Set<number>());
  const releasedBlockedPointers = useRef(new Set<number>());
  const suppressionTimer = useRef<number | null>(null);
  useEffect(() => {
    const markReleased = (event: PointerEvent) => {
      if (blockedPanelPointers.current.has(event.pointerId)) releasedBlockedPointers.current.add(event.pointerId);
    };
    window.addEventListener('pointerup', markReleased, true);
    window.addEventListener('pointercancel', markReleased, true);
    return () => {
      cleanupGesture.current();
      if (suppressionTimer.current !== null) window.clearTimeout(suppressionTimer.current);
      window.removeEventListener('pointerup', markReleased, true);
      window.removeEventListener('pointercancel', markReleased, true);
    };
  }, []);
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
    cx: 0,
    cy: 0,
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
      } else if (mode === 'rotate' || mode === 'rotate-touch') {
        const currentAngle = Math.atan2(e.clientY - origin.current.cy, e.clientX - origin.current.cx);
        const angle = mode === 'rotate-touch'
          ? origin.current.rotation - dxCss
          : pageRotation - (currentAngle * 180 / Math.PI + 90);
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
    panelGesture.current = false;
    setTouchGestureActive(false);
    cleanupGesture.current();
    if (e.type === 'pointercancel') suppressedPanelPointer.current = null;
    else if (suppressedPanelPointer.current !== null) {
      const pointer = suppressedPanelPointer.current;
      suppressionTimer.current = window.setTimeout(() => {
        if (suppressedPanelPointer.current === pointer) suppressedPanelPointer.current = null;
        suppressionTimer.current = null;
      }, 500);
    }
    if (!mode) return;

    if (sig.locked || !interactiveRef.current || !gestureAllowedRef.current) {
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
    } else if (mode === 'rotate' || mode === 'rotate-touch') {
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
      const touchPanelGesture = !!target.closest('.signature-touch-panel');
      panelGesture.current = touchPanelGesture;
      if (touchPanelGesture) {
        suppressedPanelPointer.current = e.pointerId;
        setTouchGestureActive(true);
      }
      target.setPointerCapture(e.pointerId);
      const rect = overlayRef.current?.getBoundingClientRect();
      const cx = (rect?.left ?? 0) + (rect?.width ?? 0) / 2;
      const cy = (rect?.top ?? 0) + (rect?.height ?? 0) / 2;
      origin.current = {
        clientX: e.clientX,
        clientY: e.clientY,
        x: liveRef.current.x,
        y: liveRef.current.y,
        width: liveRef.current.width,
        height: liveRef.current.height,
        rotation: liveRef.current.rotation,
        cx,
        cy,
      };
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', endDrag);
      const cancel = (event: PointerEvent) => {
        if (event.pointerId !== pointerId.current) return;
        gestureAllowedRef.current = false;
        endDrag(event);
      };
      window.addEventListener('pointercancel', cancel);
      const cancelOnBlur = () => {
        if (pointerId.current !== null) cancel(new PointerEvent('pointercancel', { pointerId: pointerId.current }));
      };
      const cancelOnLostCapture = (event: Event) => cancel(event as PointerEvent);
      target.addEventListener('lostpointercapture', cancelOnLostCapture);
      window.addEventListener('blur', cancelOnBlur);
      const blockKeys = (event: KeyboardEvent) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      if (touchPanelGesture) window.addEventListener('keydown', blockKeys, true);
      cleanupGesture.current = () => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', endDrag);
        window.removeEventListener('pointercancel', cancel);
        target.removeEventListener('lostpointercapture', cancelOnLostCapture);
        window.removeEventListener('blur', cancelOnBlur);
        if (touchPanelGesture) window.removeEventListener('keydown', blockKeys, true);
        if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId);
      };
    },
    [endDrag, onPointerMove, onSelect, sig.id, sig.locked],
  );

  useLayoutEffect(() => {
    if (pointerId.current === null) return;
    if (!interactive || sig.locked || (panelGesture.current && (!selected || !coarsePointer))) {
      gestureAllowedRef.current = false;
      endDrag(new PointerEvent('pointercancel', { pointerId: pointerId.current }));
    }
  }, [interactive, sig.locked, selected, coarsePointer, endDrag]);

  const stepTouchControl = useCallback((mode: 'move' | `resize-${ResizeHandle}` | 'rotate-touch', sx: number, sy: number, free = false) => {
    if (!interactive || sig.locked) return;
    if (mode === 'rotate-touch') {
      if (sx) onStepRotate(sig.id, -sx);
      return;
    }
    const x = sx / scale, y = sy / scale;
    const dx = pageRotation === 90 ? y : pageRotation === 180 ? -x : pageRotation === 270 ? -y : x;
    const dy = pageRotation === 90 ? x : pageRotation === 180 ? y : pageRotation === 270 ? -x : -y;
    if (mode === 'move') {
      onCommitMove(sig.id, dx, dy);
    } else {
      const handle = mode.slice('resize-'.length) as ResizeHandle;
      onStepResize(sig.id, { handle, dx, dy, free });
    }
  }, [interactive, onCommitMove, onStepResize, onStepRotate, pageRotation, scale, sig.id, sig.locked]);

  const handleTouchKey = useCallback((mode: 'move' | `resize-${ResizeHandle}` | 'rotate-touch', event: React.KeyboardEvent<HTMLButtonElement>) => {
    const directions: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 10 : 1;
    stepTouchControl(mode, direction[0] * step, direction[1] * step, event.shiftKey);
  }, [stepTouchControl]);

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
          <div className="signature-fine-controls absolute -top-8 left-0 flex items-center gap-1 whitespace-nowrap pointer-events-auto">
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
                  className={`signature-fine-controls absolute w-2.5 h-2.5 bg-accent border border-white rounded-sm pointer-events-auto ${cursor}`}
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
                className="signature-fine-controls absolute w-2.5 h-2.5 bg-emerald-500 border border-white rounded-full cursor-grab pointer-events-auto"
                style={{ zIndex: Z_LAYERS.canvasHandle, left: '50%', top: -18, transform: 'translateX(-50%)' }}
                onPointerDown={(e) => begin('rotate', e)}
                title="Drag to rotate"
              />
            </>
          )}
        </>
      )}
      {coarsePointer && selected && interactive && typeof document !== 'undefined' && createPortal(
        <div className={`signature-touch-panel${touchControlsOpen ? '' : ' is-collapsed'}`} style={{ zIndex: Z_LAYERS.dropdown }} role="group"
          aria-label="Signature touch controls" aria-busy={touchGestureActive}
          onPointerDownCapture={(event) => {
            if (dragMode.current && event.pointerId !== pointerId.current) {
              if (blockedPanelPointers.current.size >= 16) {
                const oldest = blockedPanelPointers.current.values().next().value!;
                blockedPanelPointers.current.delete(oldest);
                releasedBlockedPointers.current.delete(oldest);
              }
              blockedPanelPointers.current.add(event.pointerId);
              releasedBlockedPointers.current.delete(event.pointerId);
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            for (const released of releasedBlockedPointers.current) blockedPanelPointers.current.delete(released);
            releasedBlockedPointers.current.clear();
            blockedPanelPointers.current.delete(event.pointerId);
            suppressedPanelPointer.current = null;
            if (suppressionTimer.current !== null) window.clearTimeout(suppressionTimer.current);
            suppressionTimer.current = null;
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onClickCapture={(event) => {
            const pointerId = (event.nativeEvent as PointerEvent).pointerId;
            const blocked = blockedPanelPointers.current.has(pointerId) ||
              (typeof pointerId !== 'number' && event.detail > 0 && blockedPanelPointers.current.size > 0);
            const suppressed = suppressedPanelPointer.current !== null &&
              (pointerId === suppressedPanelPointer.current || (typeof pointerId !== 'number' && event.detail > 0));
            if (dragMode.current || blocked || suppressed) {
              event.preventDefault();
              event.stopPropagation();
              if (blocked) {
                const id = typeof pointerId === 'number' ? pointerId : blockedPanelPointers.current.values().next().value!;
                blockedPanelPointers.current.delete(id);
                releasedBlockedPointers.current.delete(id);
              }
              else if (suppressed && !dragMode.current) suppressedPanelPointer.current = null;
            }
          }}
          onKeyDownCapture={(event) => {
            if (dragMode.current) { event.preventDefault(); event.stopPropagation(); }
          }}
          onKeyDown={(event) => { if (event.code === 'Space') event.stopPropagation(); }}
          onKeyUp={(event) => { if (event.code === 'Space') event.stopPropagation(); }}>
          {touchControlsOpen ? <>
            <div className="signature-touch-heading">
              <span aria-live="polite">{touchGestureActive ? 'Adjusting signature' : 'Drag arrows to resize'}</span>
              <button type="button" aria-label="Hide signature controls" title="Hide signature controls"
                onClick={() => setTouchControlsOpen(false)}><Minimize2 size={18} /></button>
            </div>
            <div className="signature-touch-body">
              <div className="signature-touch-actions">
                <button type="button" aria-label="Move signature; drag or use arrow keys" title="Drag or use arrow keys to move" disabled={sig.locked}
                  onPointerDown={(event) => begin('move', event)} onKeyDown={(event) => handleTouchKey('move', event)}
                  onClick={(event) => { if (event.detail === 0) stepTouchControl('move', 1, 0); }}><Move size={18} /></button>
                <button type="button" aria-label="Rotate signature 15 degrees" title="Rotate 15°" disabled={sig.locked}
                  onClick={() => onStepRotate(sig.id, 15)}><RotateCw size={18} /></button>
                <button type="button" aria-label="Delete signature" title="Delete" disabled={sig.locked} onClick={() => onDelete(sig.id)}><Trash2 size={18} /></button>
                <button type="button" aria-label="Deselect signature" title="Deselect" onClick={onDeselect}><X size={18} /></button>
              </div>
              {!sig.locked && <div className="signature-touch-grid">
                {([
                  ['nw', '↖', 'top left', -1, -1], ['n', '↑', 'top', 0, -1], ['ne', '↗', 'top right', 1, -1],
                  ['w', '←', 'left', -1, 0], ['rotate', '⟳', 'rotate', 0, 0], ['e', '→', 'right', 1, 0],
                  ['sw', '↙', 'bottom left', -1, 1], ['s', '↓', 'bottom', 0, 1], ['se', '↘', 'bottom right', 1, 1],
                ] as const).map(([handle, label, name, outwardX, outwardY]) => (
                  <button key={handle} type="button" data-touch-handle={handle}
                    aria-label={handle === 'rotate' ? 'Rotate signature; drag left or right or use arrow keys' : `Resize signature ${name}; drag or use arrow keys`}
                    title={handle === 'rotate' ? 'Drag left or right or use arrow keys to rotate' : `Drag or use arrow keys to resize ${name}`}
                    onPointerDown={(event) => begin(handle === 'rotate' ? 'rotate-touch' : `resize-${handle}`, event)}
                    onKeyDown={(event) => handleTouchKey(handle === 'rotate' ? 'rotate-touch' : `resize-${handle}`, event)}
                    onClick={(event) => {
                      if (event.detail !== 0) return;
                      if (handle === 'rotate') { stepTouchControl('rotate-touch', -15, 0); return; }
                      onStepResize(sig.id, { handle, dx: outwardX / scale, dy: -outwardY / scale, free: false, local: true });
                    }}>
                    <span style={handle === 'rotate' ? undefined : { transform: `rotate(${pageRotation - live.rotation}deg)` }}>{label}</span>
                  </button>
                ))}
              </div>}
            </div>
          </> : <button type="button" className="signature-touch-expand" aria-label="Show signature resize and rotation controls" title="Show signature controls"
            onClick={() => setTouchControlsOpen(true)}><SlidersHorizontal size={16} /><span>Resize / rotate</span></button>}
        </div>, document.body,
      )}
    </div>
  );
}
