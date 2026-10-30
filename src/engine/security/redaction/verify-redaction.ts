import { parseContentStream } from '../../content/operator-lexer';
import { getPageContentBytes } from '../../parser/parser';
import { PDFArray, PDFDict, PDFHexString, PDFRef, PDFStream, PDFString, type PDFDocumentData, type PDFObject } from '../../types';
import type { RedactionVerification } from '../types';

/** A diagnostic scan, not a proof that a PDF contains no recoverable data. */
export function verifyRedaction(doc: PDFDocumentData, forbidden: string[]): RedactionVerification {
  const found = new Set<string>();
  const needles = forbidden.filter(value => typeof value === 'string' && value.length > 0);
  const inspect = (value: string) => {
    for (const needle of needles) if (value.includes(needle)) found.add(needle);
  };
  const inspectBytes = (bytes: Uint8Array) => {
    inspect(new TextDecoder('latin1').decode(bytes));
    inspect(new TextDecoder('utf-8').decode(bytes));
    // PDF strings can contain UTF-16BE with or without a byte-order mark.
    if (bytes.length >= 2) {
      inspect(new TextDecoder('utf-16be').decode(bytes));
      inspect(new TextDecoder('utf-16le').decode(bytes));
    }
  };

  const visited = new Set<PDFObject>();
  const inspectObject = (object: PDFObject | undefined): void => {
    if (!object) return;
    type Task = { object: PDFObject } | { bytes: Uint8Array };
    const pending: Task[] = [{ object }];
    while (pending.length) {
      const task = pending.pop()!;
      if ('bytes' in task) { inspectBytes(task.bytes); continue; }
      const value = task.object;
      if (visited.has(value)) continue;
      visited.add(value);
      if (value instanceof PDFRef) {
        const target = doc.objects.get(value.toKey());
        if (target) pending.push({ object: target });
      } else if (value instanceof PDFString) {
        inspect(value.value);
        inspectBytes(value.toBytes());
      } else if (value instanceof PDFHexString) {
        inspectBytes(value.toBytes());
      } else if (value instanceof PDFArray) {
        for (let i = value.items.length - 1; i >= 0; i--) pending.push({ object: value.items[i] });
      } else if (value instanceof PDFDict) {
        const children = [...value.values()];
        for (let i = children.length - 1; i >= 0; i--) pending.push({ object: children[i] });
      } else if (value instanceof PDFStream) {
        if (value.decodedBytes) pending.push({ bytes: value.decodedBytes });
        pending.push({ bytes: value.rawBytes }, { object: value.dict });
      }
    }
  };
  // Include detached objects too: some writers may serialize them even when
  // they are not reachable through the current page tree.
  for (const object of doc.objects.values()) inspectObject(object);
  inspectObject(doc.xref.trailerDict);
  for (const value of Object.values(doc.info)) if (typeof value === 'string') inspect(value);

  const inspectInstructions = (bytes: Uint8Array) => {
    try {
      for (const instruction of parseContentStream(bytes)) {
        for (const operand of instruction.operands) inspectObject(operand);
        // A TJ array can split a word across multiple encoded strings.
        const textParts: string[] = [];
        type TextTask = { value: PDFObject } | { leave: PDFArray };
        const pending: TextTask[] = instruction.operands.slice().reverse().map(value => ({ value }));
        const active = new Set<PDFArray>();
        while (pending.length) {
          const task = pending.pop()!;
          if ('leave' in task) { active.delete(task.leave); continue; }
          const operand = task.value;
          if (operand instanceof PDFString) textParts.push(operand.value);
          else if (operand instanceof PDFHexString) textParts.push(operand.toText());
          else if (operand instanceof PDFArray && !active.has(operand)) {
            active.add(operand);
            pending.push({ leave: operand });
            for (let i = operand.items.length - 1; i >= 0; i--) pending.push({ value: operand.items[i] });
          }
        }
        inspect(textParts.join(''));
      }
    } catch {
      // A malformed content stream does not make the scan conclusive.
    }
  };
  for (const page of doc.pages) {
    try { inspectInstructions(getPageContentBytes(page, doc.objects)); } catch { /* inconclusive */ }
  }
  for (const object of doc.objects.values()) {
    if (object instanceof PDFStream && object.dict.getName('Subtype') === 'Form') {
      inspectInstructions(object.getBytes());
    }
  }
  return {
    ok: false,
    found: [...found],
    complete: false,
    limitations: ['This scan cannot prove absence from all font encodings, images, embedded files, or unsupported stream filters.'],
  };
}
