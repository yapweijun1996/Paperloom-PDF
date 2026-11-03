/**
 * Prints PDF bytes through the browser's own PDF viewer, so text and shapes
 * stay vector. A hidden iframe opens the print dialog in place; when the
 * browser cannot print the frame (no built-in viewer, blocked access), the
 * PDF opens in a new tab where the user prints it.
 */

const IFRAME_CLEANUP_MS = 60_000;

export function printPdfBytes(bytes: Uint8Array, doc: Document = document): Promise<void> {
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const frame = doc.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.dataset.printFrame = '';
  // Off-screen rather than display:none: some viewers do not load hidden frames.
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none';

  const cleanup = () => {
    frame.remove();
    URL.revokeObjectURL(url);
  };

  return new Promise(resolve => {
    frame.addEventListener('load', () => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
      } catch {
        doc.defaultView?.open(url, '_blank', 'noopener');
      }
      // The dialog does not report when it closes; keep the frame long enough to print.
      setTimeout(cleanup, IFRAME_CLEANUP_MS);
      resolve();
    }, { once: true });
    frame.src = url;
    doc.body.appendChild(frame);
  });
}
