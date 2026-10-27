/**
 * Appearance renderer — SVG (vector) + optional PNG rasterization.
 * Independent of page placement; consumes SignatureAppearance only.
 */

import type {
  SignatureAppearance,
  AppearanceRenderOptions,
  AppearanceRenderResult,
  AppearanceTextComponent,
} from './visual-types';

/**
 * Render an appearance to SVG (preferred) and optionally a PNG data URL.
 */
export function renderSignatureAppearance(
  appearance: SignatureAppearance,
  options: AppearanceRenderOptions,
): AppearanceRenderResult {
  const width = Math.max(40, options.width);
  const height = Math.max(24, options.height);
  const svg = buildAppearanceSVG(appearance, width, height);

  if (options.preferVector !== false) {
    const imageDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    return { imageDataUrl, svg, width, height };
  }

  const imageDataUrl = rasterizeSvgToPng(svg, width, height);
  return { imageDataUrl, svg, width, height };
}

/** Pure SVG generation — no DOM required. */
export function buildAppearanceSVG(
  appearance: SignatureAppearance,
  width: number,
  height: number,
): string {
  const { padding, alignment, gap } = appearance.layout;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  );

  if (appearance.background.visible) {
    const op = appearance.background.opacity;
    parts.push(
      `<rect x="0" y="0" width="${width}" height="${height}" fill="${esc(appearance.background.color)}" fill-opacity="${op}"/>`,
    );
  }

  if (appearance.border.visible && appearance.border.width > 0) {
    const bw = appearance.border.width;
    const dash =
      appearance.border.style === 'dashed' ? ` stroke-dasharray="${bw * 3} ${bw * 2}"` : '';
    parts.push(
      `<rect x="${bw / 2}" y="${bw / 2}" width="${width - bw}" height="${height - bw}" fill="none" stroke="${esc(appearance.border.color)}" stroke-width="${bw}"${dash}/>`,
    );
  }

  let y = padding;
  const contentW = width - padding * 2;
  const alignX = (w: number) => {
    if (alignment === 'center') return padding + (contentW - w) / 2;
    if (alignment === 'right') return padding + contentW - w;
    return padding;
  };

  // Logo + title row
  if (appearance.logo.visible && appearance.logo.imageDataUrl) {
    const lw = appearance.logo.width ?? 32;
    const lh = appearance.logo.height ?? 32;
    parts.push(
      `<image href="${esc(appearance.logo.imageDataUrl)}" x="${alignX(lw)}" y="${y}" width="${lw}" height="${lh}" preserveAspectRatio="xMidYMid meet"/>`,
    );
    y += lh + gap;
  }

  // Signature image — take remaining vertical budget preferentially
  const metaLines = collectMetaLines(appearance);
  const metaBlockH = metaLines.reduce((h, l) => h + l.size + gap * 0.5, 0);
  const sigMaxH = Math.max(
    20,
    height - y - padding - (appearance.signatureImage.visible ? metaBlockH : 0),
  );

  if (appearance.signatureImage.visible && appearance.signatureImage.imageDataUrl) {
    const sigH = Math.min(sigMaxH, height * 0.45);
    const sigW = contentW;
    parts.push(
      `<image href="${esc(appearance.signatureImage.imageDataUrl)}" x="${alignX(sigW)}" y="${y}" width="${sigW}" height="${sigH}" preserveAspectRatio="xMidYMid meet"/>`,
    );
    y += sigH + gap;
  }

  for (const line of metaLines) {
    const x =
      alignment === 'center'
        ? width / 2
        : alignment === 'right'
          ? width - padding
          : padding;
    const anchor =
      alignment === 'center' ? 'middle' : alignment === 'right' ? 'end' : 'start';
    const label = line.label ? `${line.label}: ${line.text}` : line.text;
    parts.push(
      `<text x="${x}" y="${y + line.size * 0.85}" text-anchor="${anchor}" font-family="${esc(line.font)}" font-size="${line.size}" fill="${esc(line.color)}">${esc(label)}</text>`,
    );
    y += line.size + gap * 0.5;
  }

  parts.push('</svg>');
  return parts.join('');
}

interface MetaLine {
  label?: string;
  text: string;
  font: string;
  size: number;
  color: string;
}

function collectMetaLines(appearance: SignatureAppearance): MetaLine[] {
  const lines: MetaLine[] = [];
  const push = (c: AppearanceTextComponent, label?: string) => {
    if (!c.visible || !c.text.trim()) return;
    lines.push({
      label,
      text: c.text.trim(),
      font: c.font,
      size: c.size,
      color: c.color,
    });
  };
  push(appearance.typedName);
  push(appearance.date, 'Date');
  push(appearance.reason, 'Reason');
  push(appearance.location, 'Location');
  push(appearance.contactInfo, 'Contact');
  return lines;
}

function rasterizeSvgToPng(svg: string, width: number, height: number): string {
  if (typeof document === 'undefined') {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
  // Synchronous fallback: return SVG data URL (async Image load would be needed for true PNG).
  // Callers that need PNG can use rasterizeAppearanceAsync.
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Async PNG rasterization via Image + canvas (preserves transparency). */
export function rasterizeAppearanceAsync(
  appearance: SignatureAppearance,
  options: AppearanceRenderOptions,
): Promise<AppearanceRenderResult> {
  const width = Math.max(40, options.width);
  const height = Math.max(24, options.height);
  const svg = buildAppearanceSVG(appearance, width, height);
  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve({ imageDataUrl: svgUrl, svg, width, height });
        return;
      }
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      resolve({
        imageDataUrl: canvas.toDataURL('image/png'),
        svg,
        width,
        height,
      });
    };
    img.onerror = () => reject(new Error('Failed to rasterize appearance'));
    img.src = svgUrl;
  });
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
