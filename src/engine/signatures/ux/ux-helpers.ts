/**
 * Phase 14 — Signature UX helpers (recent list, shortcuts, lock-after-sign).
 */

import type { SignatureLibraryEntry } from '../visual/visual-types';
import type { VisualSignature } from '../visual/visual-types';
import { setSignatureLocked } from '../visual/signature-model';

const RECENT_KEY = 'bloom-pdf-recent-signatures-v1';
const MAX_RECENT = 8;

export const SIGNATURE_SHORTCUTS = {
  tool: 's',
  create: 'Shift+S',
  validate: 'Shift+V',
  nextField: ']',
  prevField: '[',
  lock: 'l',
} as const;

/** Persist recently used library signature ids. */
export function pushRecentSignatureId(id: string, storage?: Storage | null): string[] {
  const store =
    storage === undefined
      ? typeof localStorage !== 'undefined'
        ? localStorage
        : null
      : storage;
  if (!store) return [id];
  try {
    const raw = store.getItem(RECENT_KEY);
    const prev: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    const next = [id, ...prev.filter((x) => x !== id)].slice(0, MAX_RECENT);
    store.setItem(RECENT_KEY, JSON.stringify(next));
    return next;
  } catch {
    return [id];
  }
}

export function listRecentSignatureIds(storage?: Storage | null): string[] {
  const store =
    storage === undefined
      ? typeof localStorage !== 'undefined'
        ? localStorage
        : null
      : storage;
  if (!store) return [];
  try {
    const raw = store.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function orderLibraryByRecent(
  entries: SignatureLibraryEntry[],
  recentIds?: string[],
): SignatureLibraryEntry[] {
  const recent = recentIds ?? listRecentSignatureIds();
  const rank = new Map(recent.map((id, i) => [id, i]));
  return [...entries].sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id)! : 999;
    const rb = rank.has(b.id) ? rank.get(b.id)! : 999;
    if (ra !== rb) return ra - rb;
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}

/** Lock all visual overlays on a page after digital sign (Acrobat-like). */
export function lockSignaturesAfterSigning(
  signatures: VisualSignature[],
  pageIndex?: number,
): VisualSignature[] {
  return signatures.map((s) => {
    if (pageIndex != null && s.pageIndex !== pageIndex) return s;
    return setSignatureLocked(s, true);
  });
}

/** Alignment guide snap helper — returns snapped x/y when near guide. */
export function snapToAlignmentGuides(
  x: number,
  y: number,
  guides: { x?: number[]; y?: number[] },
  threshold = 6,
): { x: number; y: number; snappedX: boolean; snappedY: boolean } {
  let sx = x;
  let sy = y;
  let snappedX = false;
  let snappedY = false;
  for (const gx of guides.x ?? []) {
    if (Math.abs(x - gx) <= threshold) {
      sx = gx;
      snappedX = true;
      break;
    }
  }
  for (const gy of guides.y ?? []) {
    if (Math.abs(y - gy) <= threshold) {
      sy = gy;
      snappedY = true;
      break;
    }
  }
  return { x: sx, y: sy, snappedX, snappedY };
}

/** Page center / margin guides in PDF user space. */
export function defaultPageGuides(pageWidth: number, pageHeight: number): {
  x: number[];
  y: number[];
} {
  return {
    x: [36, pageWidth / 2, pageWidth - 36],
    y: [36, pageHeight / 2, pageHeight - 36],
  };
}
