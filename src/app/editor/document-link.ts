/** The browser actions used when a link embedded in a document is opened. */
interface DocumentLinkBrowser {
  open(url: string, target: string, features: string): unknown;
  confirm(message: string): boolean;
}

type DocumentLinkResult = 'requested' | 'cancelled' | 'blocked';
const DIRECT_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const BLOCKED_SCHEMES = new Set(['javascript:', 'vbscript:', 'data:', 'file:', 'blob:', 'about:']);

/**
 * PDF links are untrusted. Open common schemes directly, ask before launching
 * another application, and never execute active or local document URLs.
 */
export function openDocumentLink(
  input: string,
  browser: DocumentLinkBrowser = window,
): DocumentLinkResult {
  // URL parsers ignore some controls, which can hide a scheme from the user.
  if (/[\u0000-\u001f\u007f]/.test(input)) return 'blocked';
  const text = input.trim();
  if (!text || text.length > 4096) return 'blocked';

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'blocked';
  }
  if (BLOCKED_SCHEMES.has(url.protocol)) return 'blocked';
  if ((url.protocol === 'mailto:' || url.protocol === 'tel:') && !url.pathname) return 'blocked';

  const destination = url.href;
  if (!DIRECT_SCHEMES.has(url.protocol) &&
      !browser.confirm(`This link may open another application:\n\n${destination}\n\nOpen this link?`)) {
    return 'cancelled';
  }
  browser.open(destination, '_blank', 'noopener,noreferrer');
  return 'requested';
}
