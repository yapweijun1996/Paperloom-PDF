import { PDFRef, PDFStream, type PDFDocumentData } from '@/engine/types';

export type PdfConformance =
  | { status: 'none' }
  | { status: 'unknown' }
  | { status: 'claimed'; formats: Array<'PDF/A' | 'PDF/UA'> };

const NS = {
  'http://www.aiim.org/pdfa/ns/id/': 'PDF/A',
  'http://www.aiim.org/pdfua/ns/id/': 'PDF/UA',
} as const;
const MAX_XMP_BYTES = 2 * 1024 * 1024;

/** Detect declarations, not compliance. Unreadable metadata remains unknown. */
export function detectPdfConformance(doc: PDFDocumentData): PdfConformance {
  let value = doc.catalog.get('Metadata');
  if (!value) return { status: 'none' };
  const seen = new Set<string>();
  while (value instanceof PDFRef) {
    const key = value.toKey();
    if (seen.has(key) || seen.size >= 1000) return { status: 'unknown' };
    seen.add(key);
    value = doc.objects.get(key);
    if (!value) return { status: 'unknown' };
  }
  if (!(value instanceof PDFStream)) return { status: 'unknown' };
  // A filtered stream without successful decoding cannot be treated as XML.
  if (value.dict.has('Filter') && (!value.decodedBytes || value.decodedBytes === value.rawBytes)) {
    return { status: 'unknown' };
  }
  const bytes = value.getBytes();
  if (bytes.length > MAX_XMP_BYTES || !bytes.length) return { status: 'unknown' };
  try {
    let encoding = 'utf-8';
    if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    // Do not resolve DTDs or external entities from an untrusted document.
    if (/<!DOCTYPE/i.test(text) || typeof DOMParser === 'undefined') return { status: 'unknown' };
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    if (xml.getElementsByTagName('parsererror').length || !xml.documentElement) return { status: 'unknown' };
    const formats = new Set<'PDF/A' | 'PDF/UA'>();
    for (const element of Array.from(xml.getElementsByTagName('*'))) {
      const add = (namespace: string | null, local: string) => {
        const key = namespace as keyof typeof NS | null;
        if (key && Object.prototype.hasOwnProperty.call(NS, key) && (local === 'part' || local === 'conformance')) formats.add(NS[key]);
      };
      add(element.namespaceURI, element.localName);
      for (const attr of Array.from(element.attributes)) {
        let namespace = attr.namespaceURI;
        let local = attr.localName;
        // Some DOM implementations omit an attribute's namespace; resolve
        // its prefix from the nearest declaration instead of guessing it.
        if (!namespace && attr.name.includes(':')) {
          const [prefix, name] = attr.name.split(':', 2);
          local = name;
          for (let ancestor: Element | null = element; ancestor && !namespace; ancestor = ancestor.parentElement) {
            namespace = ancestor.getAttribute(`xmlns:${prefix}`);
          }
        }
        add(namespace, local);
      }
    }
    return formats.size ? { status: 'claimed', formats: [...formats] } : { status: 'none' };
  } catch {
    return { status: 'unknown' };
  }
}
