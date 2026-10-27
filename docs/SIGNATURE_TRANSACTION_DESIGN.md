# Signature transaction design (partially implemented)

The graph-and-byte transaction and a single signing history step are implemented.
A document identity owner now serializes native edit work and invalidates stale
leases when the document is replaced. The broader document ownership and atomic
publication guarantees below remain unfinished. This document does not certify signature validation or encryption
compatibility; signing an encrypted document is currently rejected.

## Required behavior

- Creating a field, signing it, and locking its visual signature form one history
  step. Undo restores the complete pre-signing document and redo restores the
  complete signed revision, including the original signed bytes.
- A failed, cancelled, or conflicting signing operation publishes no partial field,
  signature dictionary, byte revision, visual lock, or history entry.
- A later signing operation starts from the actual preceding signed revision.
  Existing signatures remain independently verifiable after subsequent signing and
  after each undo and redo.
- Work queued for one document generation must not silently edit a different
  document or a document that has been replaced while it was waiting.

## Observed constraints

The editor currently holds its mutable `PDFDocumentData` graph in React state.
The underlying `signDocumentCryptographic` mutates its input before it has
finished. The editor now runs it on a detached session draft in the native edit
queue, and creates the field and signing revision in that same transaction.
Before signing, pending text, image, drawing, and non-native signature overlays
must be committed through the download workflow; otherwise signing is rejected.
The editor checks that condition again before publishing the signed revision.
The signed-document save policy rejects further edits, so pending edits on an
already signed document must be undone before another signature can be added.

`SessionDocumentEditor` stages object-graph edits and checks a serialized
baseline before publication, while retaining the live objects-map identity. A
new opt-in signing transaction also checks raw bytes and security provenance and
restores the signed byte revision on undo and redo. Ordinary session transactions
retain their existing behavior. A detached
codec copy is also insufficient as a drop-in replacement: incremental-save
metadata in `stream-compiler.ts` is associated with the original objects map.

Four targeted local experiments confirmed that a failed signing call can leave a
signature reference and added objects; codec cloning loses the map-associated
incremental-save metadata; a successful staged signing edit does not publish its
signed bytes; and a concurrent raw-byte-only change is not detected by the
existing session baseline check. These experiments establish current behavior,
not the correctness of the proposed solution.

## Remaining ownership and commit boundary

The editor has a document identity and native-queue owner, but React state still
holds the same mutable graph and legacy writes still use direct references. React
needs immutable render snapshots or versioned notifications, with all document
writes going through the owner. Audit the existing readers and writers before
switching the state model: changing only the signing call would leave other code
with mutable aliases or stale document references.

The owner serializes native edits and associates each with its document
generation; queued work rejects after a replacement, including shallow copies
sharing an object map. Autosave checks its lease again after serialization and
after IndexedDB opens. The staged text, annotation, image-replacement, watermark,
and markup-clear paths also check their leases before publishing; link creation,
editing, and removal use the native queue. Undo and redo now enter the queue and
stage session and legacy graph restoration together;
document or history changes abort the stage without consuming history cursors.
Other non-queued editing paths still need the same owner boundary. A busy
indicator alone is not an ownership guarantee.

Signing now stages field creation and signing together. Before publishing, it checks
the document generation, graph revision, signed raw bytes, and security
provenance against the captured baseline and preserves the authoritative
objects-map identity. The visual lock and history entry are applied immediately
after the document transaction, but are not yet part of an atomic owner-level
publication. On failure or conflict before publication, the stage is discarded.
Do not log keys or document contents.

The signing history boundary now stores the graph and byte revision before and
after signing. Encrypted signing is rejected because the current incremental
writer cannot safely append plaintext objects to an encrypted prefix. Timestamp
fallback remains distinguishable from complete signing failure.

## Acceptance checks before implementation is considered complete

- Existing and newly created signature fields; failures during field creation,
  cryptographic signing, and publication; and no partial changes or history on
  failure.
- Undo and redo of the complete signature step, with byte-identical signed
  revisions on redo and preserved overlays and field state.
- A second signature, undo and redo across both signatures, and independent CMS
  verification of each applicable signed byte range using OpenSSL.
- A queued edit, document replacement, a graph edit, and a raw-byte-only change
  during signing; no lost edits and no mutation of an obsolete document.
- Existing incremental-save provenance, encrypted inputs and their security
  metadata, document reopening, download, and browser-level signing flows.
- Focused session and signature regressions, the full test suite, build, and lint.
  Do not suppress the React ownership rule to make the check pass.
