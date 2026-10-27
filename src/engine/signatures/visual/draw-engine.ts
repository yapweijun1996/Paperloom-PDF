/**
 * Signature drawing engine — mouse / touch / pen with smooth quadratic beziers.
 * Browser-only; no external libraries.
 */

import type { DrawEngineOptions, Stroke, StrokePoint } from './visual-types';

const DEFAULT_COLOR = '#1a1a2e';
const DEFAULT_WIDTH = 2.5;
const DEFAULT_MIN_DIST = 1.5;

export class SignatureDrawEngine {
  private strokes: Stroke[] = [];
  private current: Stroke | null = null;
  private color: string;
  private width: number;
  private minDistance: number;

  constructor(opts: DrawEngineOptions = {}) {
    this.color = opts.color ?? DEFAULT_COLOR;
    this.width = opts.width ?? DEFAULT_WIDTH;
    this.minDistance = opts.minDistance ?? DEFAULT_MIN_DIST;
  }

  setStyle(opts: { color?: string; width?: number }): void {
    if (opts.color != null) this.color = opts.color;
    if (opts.width != null) this.width = opts.width;
  }

  beginStroke(point: StrokePoint): void {
    this.current = {
      points: [{ ...point, t: point.t ?? Date.now() }],
      color: this.color,
      width: this.width,
    };
  }

  addPoint(point: StrokePoint): void {
    if (!this.current) return;
    const last = this.current.points[this.current.points.length - 1];
    const dx = point.x - last.x;
    const dy = point.y - last.y;
    if (Math.hypot(dx, dy) < this.minDistance) return;
    this.current.points.push({ ...point, t: point.t ?? Date.now() });
  }

  endStroke(): void {
    if (!this.current) return;
    if (this.current.points.length > 0) {
      this.strokes.push(this.current);
    }
    this.current = null;
  }

  clear(): void {
    this.strokes = [];
    this.current = null;
  }

  undoStroke(): void {
    if (this.current) {
      this.current = null;
      return;
    }
    this.strokes.pop();
  }

  getStrokes(): Stroke[] {
    const all = [...this.strokes];
    if (this.current) all.push(this.current);
    return all;
  }

  isEmpty(): boolean {
    return this.strokes.length === 0 && !this.current;
  }

  /**
   * Paint strokes onto a 2D context using midpoint quadratic curves.
   */
  paint(ctx: CanvasRenderingContext2D): void {
    for (const stroke of this.getStrokes()) {
      paintStroke(ctx, stroke);
    }
  }

  /**
   * Export as PNG data URL with transparent background.
   * Crops to ink bounds with padding.
   */
  toDataURL(
    canvasWidth: number,
    canvasHeight: number,
    opts?: { padding?: number; exportWidth?: number; exportHeight?: number },
  ): string | null {
    if (this.isEmpty()) return null;
    const padding = opts?.padding ?? 8;
    const bounds = strokeBounds(this.getStrokes());
    if (!bounds) return null;

    const srcX = Math.max(0, bounds.minX - padding);
    const srcY = Math.max(0, bounds.minY - padding);
    const srcW = Math.min(canvasWidth - srcX, bounds.maxX - bounds.minX + padding * 2);
    const srcH = Math.min(canvasHeight - srcY, bounds.maxY - bounds.minY + padding * 2);
    if (srcW <= 0 || srcH <= 0) return null;

    const off = document.createElement('canvas');
    const outW = opts?.exportWidth ?? Math.ceil(srcW);
    const outH = opts?.exportHeight ?? Math.ceil(srcH);
    off.width = outW;
    off.height = outH;
    const ctx = off.getContext('2d');
    if (!ctx) return null;

    ctx.clearRect(0, 0, outW, outH);
    ctx.save();
    ctx.scale(outW / srcW, outH / srcH);
    ctx.translate(-srcX, -srcY);
    this.paint(ctx);
    ctx.restore();

    return off.toDataURL('image/png');
  }

  /** SVG path markup for vector export (relative to canvas origin). */
  toSVG(width: number, height: number): string {
    const parts: string[] = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none">`,
    ];
    for (const stroke of this.getStrokes()) {
      const d = strokeToPathD(stroke.points);
      if (!d) continue;
      parts.push(
        `<path d="${d}" stroke="${escapeXml(stroke.color)}" stroke-width="${stroke.width}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
      );
    }
    parts.push('</svg>');
    return parts.join('');
  }
}

export function paintStroke(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
  const pts = stroke.points;
  if (pts.length === 0) return;
  ctx.save();
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  if (pts.length === 1) {
    ctx.arc(pts[0].x, pts[0].y, stroke.width / 2, 0, Math.PI * 2);
    ctx.fillStyle = stroke.color;
    ctx.fill();
  } else if (pts.length === 2) {
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(pts[1].x, pts[1].y);
    ctx.stroke();
  } else {
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const midX = (pts[i].x + pts[i + 1].x) / 2;
      const midY = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
    }
    const last = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    ctx.quadraticCurveTo(prev.x, prev.y, last.x, last.y);
    ctx.stroke();
  }
  ctx.restore();
}

export function strokeToPathD(points: StrokePoint[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    const p = points[0];
    return `M ${p.x} ${p.y} L ${p.x} ${p.y}`;
  }
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    d += ` Q ${points[i].x} ${points[i].y} ${midX} ${midY}`;
  }
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  d += ` Q ${prev.x} ${prev.y} ${last.x} ${last.y}`;
  return d;
}

function strokeBounds(strokes: Stroke[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const s of strokes) {
    for (const p of s.points) {
      any = true;
      const pad = s.width;
      minX = Math.min(minX, p.x - pad);
      minY = Math.min(minY, p.y - pad);
      maxX = Math.max(maxX, p.x + pad);
      maxY = Math.max(maxY, p.y + pad);
    }
  }
  if (!any) return null;
  return { minX, minY, maxX, maxY };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
