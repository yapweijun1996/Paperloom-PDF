import type { PDFDocumentData, XRefTable } from '../../types';
import { bindXrefProvenanceWithRawDigest, trailerWithXrefRevision } from '../../parser/xref-provenance';

/** Publish the xref and the trailer fields that describe these exact bytes. */
export function publishSignatureXref(doc: PDFDocumentData, parsed: XRefTable): void {
  const proof = parsed.provenance;
  if (!proof?.rawDigest) throw new Error('Unable to verify the signing revision cross-reference.');
  const trailer = trailerWithXrefRevision(doc.xref.trailerDict, parsed.trailerDict);
  const keys = ['Size', 'Prev', 'XRefStm'];
  const next = { ...doc.xref, entries: parsed.entries, trailerDict: trailer };
  bindXrefProvenanceWithRawDigest(next, proof.source, proof.rawDigest);
  for (const key of keys) {
    const value = trailer.get(key);
    if (value === undefined) doc.xref.trailerDict.delete(key);
    else doc.xref.trailerDict.set(key, value);
  }
  doc.xref.entries = parsed.entries;
  doc.xref.provenance = next.provenance;
}
