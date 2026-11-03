/**
 * Builds a plain-text diagnostic report the user can paste into an issue.
 * It describes the browser, the build and the PDF's structure only: no file
 * name, title, author or page content, so it is safe to share.
 */
import type { PDFDocumentData } from '@/engine/browser-core';

const MAX_RECENT_ERRORS = 5;
const recentErrors: string[] = [];
let listening = false;

function remember(message: string) {
  recentErrors.push(message.slice(0, 500));
  if (recentErrors.length > MAX_RECENT_ERRORS) recentErrors.shift();
}

/** Records uncaught errors so the report can include the latest ones. */
export function listenForUncaughtErrors(win: Window = window) {
  if (listening) return;
  listening = true;
  win.addEventListener('error', event => remember(event.error?.stack ?? event.message));
  win.addEventListener('unhandledrejection', event => {
    const reason = event.reason;
    remember(reason instanceof Error ? reason.stack ?? reason.message : String(reason));
  });
}

export interface DiagnosticInput {
  error?: string | null;
  doc?: PDFDocumentData | null;
  pageIndex?: number;
  userAgent: string;
  now: Date;
}

export function buildDiagnosticReport({ error, doc, pageIndex, userAgent, now }: DiagnosticInput): string {
  const lines = [
    'Paperloom diagnostic report',
    `Time: ${now.toISOString()}`,
    `Build: ${process.env.NEXT_PUBLIC_BUILD_SHA?.slice(0, 7) ?? 'local'}`,
    `Browser: ${userAgent}`,
  ];
  if (error) lines.push(`Error: ${error}`);
  if (doc) {
    lines.push(
      `PDF version: ${doc.version}`,
      `Pages: ${doc.pages.length}`,
      `Size: ${doc.rawBytes.length} bytes`,
      `Objects: ${doc.objects.size}`,
      `Encrypted: ${doc.decryptedFromEncrypted ? doc.encryptionAlgorithm ?? 'yes' : 'no'}`,
      `Producer: ${doc.info.producer ?? 'unknown'}`,
      `Creator: ${doc.info.creator ?? 'unknown'}`,
    );
    const page = pageIndex === undefined ? undefined : doc.pages[pageIndex];
    if (page) {
      lines.push(`Current page: ${pageIndex! + 1}, ${Math.round(page.mediaBox.width)} x ${Math.round(page.mediaBox.height)} pt, rotate ${page.rotate}`);
    }
  }
  if (recentErrors.length > 0) {
    lines.push('Recent uncaught errors:', ...recentErrors.map(message => `- ${message}`));
  }
  return lines.join('\n');
}
