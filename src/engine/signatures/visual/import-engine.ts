/**
 * Signature import engine — PNG / JPG / SVG → transparent-friendly data URL.
 * Browser-only; no backend.
 */

export type ImportMime = 'image/png' | 'image/jpeg' | 'image/jpg' | 'image/svg+xml';

export interface ImportedSignature {
  imageDataUrl: string;
  width: number;
  height: number;
  mimeType: string;
  /** True when alpha channel is preserved (PNG/SVG). */
  hasTransparency: boolean;
}

const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml']);

export function isAllowedSignatureFile(file: File): boolean {
  if (ALLOWED.has(file.type)) return true;
  const name = file.name.toLowerCase();
  return (
    name.endsWith('.png') ||
    name.endsWith('.jpg') ||
    name.endsWith('.jpeg') ||
    name.endsWith('.svg')
  );
}

function mimeFromFile(file: File): string {
  if (file.type) return file.type === 'image/jpg' ? 'image/jpeg' : file.type;
  const name = file.name.toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.svg')) return 'image/svg+xml';
  return 'image/jpeg';
}

/**
 * Load a File into an ImportedSignature.
 * PNG and SVG keep transparency; JPEG is kept as JPEG (no forced white flatten).
 */
export async function importSignatureFile(file: File): Promise<ImportedSignature> {
  if (!isAllowedSignatureFile(file)) {
    throw new Error('Unsupported format. Use PNG, JPG, or SVG.');
  }
  const mime = mimeFromFile(file);

  if (mime === 'image/svg+xml') {
    const text = await file.text();
    return importSvgString(text);
  }

  const dataUrl = await readAsDataURL(file);
  const dims = await loadImageDims(dataUrl);
  return {
    imageDataUrl: dataUrl,
    width: dims.width,
    height: dims.height,
    mimeType: mime,
    hasTransparency: mime === 'image/png',
  };
}

export async function importSvgString(svgText: string): Promise<ImportedSignature> {
  const cleaned = svgText.trim();
  const { width, height } = parseSvgSize(cleaned);
  const encoded = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cleaned)}`;
  return {
    imageDataUrl: encoded,
    width,
    height,
    mimeType: 'image/svg+xml',
    hasTransparency: true,
  };
}

export async function importDataURL(dataUrl: string): Promise<ImportedSignature> {
  const dims = await loadImageDims(dataUrl);
  const mime = dataUrl.startsWith('data:image/svg')
    ? 'image/svg+xml'
    : dataUrl.startsWith('data:image/png')
      ? 'image/png'
      : 'image/jpeg';
  return {
    imageDataUrl: dataUrl,
    width: dims.width,
    height: dims.height,
    mimeType: mime,
    hasTransparency: mime === 'image/png' || mime === 'image/svg+xml',
  };
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function loadImageDims(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () =>
      resolve({
        width: img.naturalWidth || img.width || 200,
        height: img.naturalHeight || img.height || 80,
      });
    img.onerror = () => reject(new Error('Failed to decode image'));
    img.src = src;
  });
}

function parseSvgSize(svg: string): { width: number; height: number } {
  const vb = svg.match(/viewBox\s*=\s*["']?\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/i);
  if (vb) {
    return { width: Math.abs(parseFloat(vb[3])) || 200, height: Math.abs(parseFloat(vb[4])) || 80 };
  }
  const w = svg.match(/\bwidth\s*=\s*["']?([\d.]+)/i);
  const h = svg.match(/\bheight\s*=\s*["']?([\d.]+)/i);
  return {
    width: w ? parseFloat(w[1]) : 200,
    height: h ? parseFloat(h[1]) : 80,
  };
}
