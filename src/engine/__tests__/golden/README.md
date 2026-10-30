# Synthetic rendering corpus

`golden-smoke.test.ts` constructs a one-page PDF using pdf-lib and checks
rendered dimensions, text extraction, a black rectangle and the white page
background. Tests use the explicitly declared `@napi-rs/canvas` development
dependency, not Fabric's optional `canvas` dependency.

`corpus.test.ts` generates small text/graphics, raster-image, form and synthetic
scan-with-invisible-text PDFs at
test time using pdf-lib and a native Canvas-generated image; it contains no
external or user documents. Each named case opens the fixture, replaces text,
rotates the page, saves and reopens it. The form case additionally changes a
field, which pdf-lib independently reopens. Poppler `pdftotext` checks the
updated text and `pdftoppm` independently renders the result. The test checks
dimensions and compares samples of solid white, red and blue away from
antialiasing, rather than asserting exact font pixels across platforms. This
limited check is not a full-page visual equivalence or accessibility test.

Run with `npx vitest run src/engine/__tests__/golden`. The cross-reader cases
are skipped if `pdftoppm` or `pdftotext` is unavailable; install Poppler to
exercise them. The scan fixture checks that an invisible OCR text layer remains
extractable without being painted. A synthetic signed case edits and rotates a
PDF, signs with a temporary self-signed certificate, saves and reopens it, and
uses `pdfsig` and the engine to verify the signature. That check does not prove
certificate trust. Other tests separately cover encrypted fixtures. More complex
independently sourced PDFs, additional scans and broader rendering tolerances
remain to be covered.

`nara-scan.test.ts` wraps a downsampled public-domain historical scan in a
generated PDF, edits a synthetic text layer, rotates and reopens the document,
and compares Paperloom rendering and retained image bytes with Poppler. Its
[fixture notes](fixtures/README.md) record provenance and hashes. This is a real
scan inside a generated PDF, not an independently sourced PDF structure or an
ground-truth OCR sample.

`irs-w9.test.ts` adds an independently sourced, unmodified IRS PDF with XFA
and a real UR3 usage-rights signature. It verifies byte-identical no-edit save,
refusal to rewrite the signed document, and detached CMS integrity using
OpenSSL, including a tampered-byte negative control. It is a protection test,
not a successful editable-form workflow; see [fixture notes](fixtures/README.md).

`cc0-form.test.ts` uses an independently maintained, CC0-licensed synthetic
AcroForm in blank and prefilled variants. It checks widget enumeration and
edits text, multiline, checkbox, radio and dropdown values; pdf-lib and Poppler
independently read the saved output. The fixture was generated with pdf-lib,
not taken from a real business workflow; see [fixture notes](fixtures/README.md).

A separate one-time check on 2026-10-30 used the blank
[U.S. Courts AO 440](https://www.uscourts.gov/sites/default/files/ao440.pdf)
(25,380 bytes, SHA-256
`2df4ff1d30d123b8a3591d158816940712e0da0189b47ca0abf780579895fbae`).
With Node 20.20.2, Paperloom parsed its two pages, detected the `Plaintiff`
field, set it to `SYNTHETIC EXAMPLE`, and quick-saved; pdf-lib 1.17.1 reopened
the value and Poppler 25.04.0 extracted it. The blank source includes PDF
JavaScript, which was not executed. The embedded WP-IconicSymbolsA font
subset's redistribution terms have not been verified, so neither the PDF nor
the temporary test was retained. This is a one-time observation rather than an
automated regression; the source URL can change and must be checked against the
hash before attempting to reproduce it.
