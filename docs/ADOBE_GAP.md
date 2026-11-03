# Paperloom PDF vs Adobe Acrobat Pro

Where Paperloom stands against Adobe Acrobat Pro, and what it takes to reach
Acrobat production level. Status is taken from the code and e2e suite as of
2026-11-03 (`main` at bc38808); percentages are judgement, not measurement.

Legend: ✅ comparable · 🟡 partial · ❌ missing · ⚙️ engine exists, no UI

## Summary

| Measure | Level |
|---|---|
| Everyday editing (edit text, images, pages, fill, sign, protect) | about 70% of Acrobat |
| Full Acrobat Pro feature breadth | about 40% |
| Production robustness (real-world PDFs, browsers, scale) | beta |
| Where Paperloom is ahead | local-only privacy, offline PWA, free, no install, PAdES signing in the browser |

## Feature comparison

### Edit content

| Acrobat Pro | Paperloom | Notes |
|---|---|---|
| Edit text in place | ✅ | Line editing with font, size, style, colour, alignment; CJK fixes. Shaped `/ActualText` text (browser-printed CJK) is not editable yet |
| Paragraph reflow across lines | 🟡 | Flow engine exists; editing is line-by-line |
| Add / replace / move / resize images | ✅ | |
| Crop, flip, rotate an image | ❌ | |
| Select and delete vector drawings | ✅ | Fixed for browser-printed PDFs on 2026-11-03 |
| Move / resize drawings | 🟡 | Engine transform exists; no handles in UI |
| Duplicate objects | ✅ | Images, drawings, text boxes, text lines (Ctrl/Cmd+D) |
| Find and replace | ✅ | Match case, Replace All |
| Spell check | ❌ | |
| Links (add, edit, remove) | ✅ | |
| Bookmarks (view, add, edit) | ❌ | No outline support |

### Organize pages

| Acrobat Pro | Paperloom | Notes |
|---|---|---|
| Insert, delete, rotate, reorder | ✅ | |
| Merge / insert from another PDF | ✅ | |
| Extract / split pages | ✅ | Current page or every page |
| Crop pages | ❌ | |
| Headers, footers, page numbers | ❌ | |
| Bates numbering | ❌ | |
| Page labels | ❌ | |
| Watermark and background | ✅ | Text, image, shape, over or under; detect and remove |

### Create and convert

| Acrobat Pro | Paperloom | Notes |
|---|---|---|
| Export to PNG / JPEG / SVG / text | ✅ | |
| Export to Word / Excel / PowerPoint | ❌ | Needs a layout-to-DOCX converter |
| Create PDF from Office, web pages, images | ❌ | |
| Scan and OCR | 🟡 | Offline OCR adds searchable text; not editable text |
| Compress / optimize | ✅ | Compression and resolution presets |
| PDF/A conversion and validation | 🟡 | Detects conformance claims only |
| Print production (preflight, output preview, PDF/X) | ❌ | |

### Review and comment

| Acrobat Pro | Paperloom | Notes |
|---|---|---|
| Highlight, freehand, shapes | ✅ | |
| Underline / strikeout text markup | ❌ | |
| Sticky notes, comment list, replies | ⚙️ | Annotation engine exists; no comment UI |
| Stamps | 🟡 | Signature appearances only; no stamp library |
| Compare two versions | ⚙️ | `engine/ai/compare.ts`; no UI |
| Shared review in the cloud | ❌ | Out of scope for a local-only app |
| Measure (distance, area) | ❌ | |

### Forms

| Acrobat Pro | Paperloom | Notes |
|---|---|---|
| Fill text, checkbox, radio, choice fields | ✅ | |
| Flatten fields | ✅ | |
| Create and edit form fields | ❌ | |
| Auto-detect fields on a flat PDF | ❌ | |
| Field calculations and JavaScript | ❌ | Intentionally not executed (security) |

### Sign and protect

| Acrobat Pro | Paperloom | Notes |
|---|---|---|
| Visual signatures (draw, type, upload) | ✅ | Library, lock, rotate, opacity |
| Certificate signing (PAdES), timestamp, LTV | ✅ | Strong; matches Acrobat's core |
| Validate signatures and revisions | ✅ | |
| Request signatures from others (Acrobat Sign) | ❌ | Needs a server workflow |
| Password encryption and permissions | ✅ | AES-256, AES-128, RC4 |
| Certificate (public-key) encryption | ⚙️ | Engine module; no UI |
| Redact region, page, marks | ✅ | Removes content from the file |
| Search-and-redact by pattern (phone, email) | ❌ | |
| Sanitize, remove JavaScript / attachments / metadata | ✅ | |

### Accessibility and productivity

| Acrobat Pro | Paperloom | Notes |
|---|---|---|
| Accessibility checker, auto-tag, reading order, alt text | ⚙️ | Structure walker only |
| Read aloud | ❌ | |
| Action wizard / batch processing | ❌ | |
| AI assistant (summarize, ask) | ❌ | |
| Print dialog | ❌ | Download and print from the browser |
| Interface languages | ❌ | English only |
| Desktop, web, mobile apps | 🟡 | Web PWA with a phone layout; works offline |

## Production-quality gaps

Features are only half the gap. Acrobat's main advantage is that it opens and
edits almost any PDF correctly.

| Gap | Today | Production level |
|---|---|---|
| Real-world PDF corpus | 27 e2e specs on generated PDFs; the 2026-11-03 drawing bug only showed on a real file | Hundreds of real PDFs (Word, browsers, InDesign, scans, CJK, forms) opened, edited, saved and pixel-compared on every release |
| Browser coverage | Chromium only in CI | Chrome, Safari (desktop and iOS), Firefox, Edge |
| Large documents | Not benchmarked | Smooth on 500+ pages and 100 MB files |
| Code structure | `src/app/editor/page.tsx` is 7,631 lines | Split into feature modules so changes stay safe |
| Crash reporting | None | Opt-in, privacy-preserving error reports |
| Manual-only checks | Listed in [E2E.md](E2E.md) | Automated |
| App accessibility (WCAG 2.2 AA) | Partial | Audited and fixed |
| Help and onboarding | [TOOLS.md](TOOLS.md) only | In-app help and first-run tips |

## Roadmap to Acrobat production level

Size: S = days, M = 1–3 weeks, L = a month or more.

**Phase 1: robustness (do first).**
1. Real-PDF corpus with open, edit, save and render-diff checks in CI (M).
2. Safari and Firefox in the e2e matrix (M).
3. Large-document performance budget and fixes (M).
4. Split `page.tsx` by feature (L, incremental).
5. Automate the manual checklist in E2E.md (M).

**Phase 2: everyday features users expect.**
1. Move and resize handles for drawings; crop images (S–M).
2. Comments: sticky notes, underline, strikeout, comment list (M).
3. Bookmarks panel: view, add, rename, reorder (M).
4. Crop pages, headers and footers, page numbers, Bates (M).
5. Search-and-redact patterns (S).
6. Print button and interface translations, starting with Chinese (S–M).

**Phase 3: Pro features.**
1. Form field authoring and auto-detection (L).
2. Compare two PDFs, using the existing engine (M).
3. PDF/A conversion and validation (L).
4. Accessibility checker and tagging (L).
5. Export to Word / Excel (L; consider WebAssembly or an optional service).
6. Certificate encryption UI, stamps library, measure tools (M).

**Out of scope while Paperloom stays local-only:** Acrobat Sign request
workflows and cloud shared review.

After Phase 1 Paperloom is production-grade for everyday editing. After
Phase 2 it covers about 85% of what most users do in Acrobat. Phase 3 is
needed only to compete on Pro-level breadth.

## Options to close each gap

Each gap lists the realistic options; **★** marks the recommendation. Options
that send documents to a server conflict with the local-only promise and are
listed only for completeness.

### Phase 1: robustness

| Gap | Options | Recommendation |
|---|---|---|
| Real-world PDF corpus | A. Generate PDFs from many producers in CI: Chrome print (Playwright `page.pdf`), LibreOffice headless, pdf-lib, scans. B. Public test corpora (pdf.js, PDFBox, veraPDF), run nightly; licences checked per file. C. Owner's own PDFs locally with `scripts/tool-sweep.mjs`, never committed. | ★ A in CI plus C before each release; add B nightly later |
| Render correctness | A. Pixel-diff our canvas against `pdftoppm` (already used in e2e) with a tolerance. B. Snapshot our own renders only. | ★ A, because B cannot catch a wrong baseline |
| Browser coverage | A. Add Playwright WebKit and Firefox projects. B. Paid real-device cloud for iOS Safari. | ★ A now; B only if iOS bugs are reported |
| Large documents | A. Benchmark script on a generated 500-page / 100 MB PDF with budgets for open, page switch, search and save (extends the existing `docs/PERFORMANCE_*.md`). B. Ad-hoc profiling. | ★ A |
| `page.tsx` size | A. Extract one feature at a time into hooks (selection, pages, signatures, security), behaviour unchanged, e2e green after each step. B. Rewrite as a state machine. | ★ A; B is too risky |
| Crash reporting | A. "Copy diagnostic report" button that the user pastes into an issue. B. Opt-in hosted error reporting with PII scrubbing. | ★ A keeps everything local |
| Manual-only checks | Turn each unticked row of [E2E.md](E2E.md) into a spec, starting with the ✋ rows users touch most (Encrypt PDF, Merge PDF, Replace All) | ★ |

### Phase 2: everyday features

| Gap | Options | Recommendation |
|---|---|---|
| Headers, footers, page numbers, Bates | A. Reuse the watermark engine's text placement with tokens such as `{page}`, `{total}`, `{date}` and a Bates prefix. B. Separate engine. | ★ A; small, because placement, fonts and page ranges already exist |
| Crop pages | A. A crop rectangle tool (reuse the redaction region selector) that writes `/CropBox`, plus a "same for all pages" option. B. Numeric margins only. | ★ A with numeric fields in the panel |
| Bookmarks | A. Read `/Outlines` into a panel for navigation first, then add, rename, reorder and write them on save. B. Read-only. | ★ A in two steps |
| Comments | A. Build the UI on the existing annotation engine: sticky notes (`/Text`), underline and strikeout (same path as highlight), and a comment list panel. B. Overlay-only comments that are not saved as annotations. | ★ A, so comments open in Acrobat |
| Drawing move and resize | A. Reuse the image handles and the path branch of `applyObjectTransform`, located by `sourceInstructionIndex`. B. Delete and redraw. | ★ A |
| Image crop | A. Wrap the placement in a clip rectangle. B. Re-encode the cropped pixels. | ★ A (lossless, undoable) |
| Search-and-redact | A. Pattern presets (email, phone, NRIC, card numbers, custom regex) on the existing search index, producing redaction marks to review. B. Auto-apply. | ★ A; the user reviews before applying |
| Print | A. Open the saved PDF blob in a new tab and let the browser's PDF viewer print it. B. Print rendered canvases through an iframe. | ★ A (vector quality) |
| Interface languages | A. A small typed dictionary per language with a language switch, starting with Simplified Chinese. B. A full i18n framework. | ★ A; fits the static export |
| Spell check | A. Turn on the browser's built-in spellcheck in text boxes and line editing (currently `spellCheck={false}` in `EditableLineBox`). B. Bundle a dictionary. | ★ A; check first that it does not disturb the caret overlay |

### Phase 3: Pro features

| Gap | Options | Recommendation |
|---|---|---|
| Form authoring | A. Create widget annotations and AcroForm fields, reusing the existing appearance generators in `engine/forms`. B. Auto-detect boxes and lines on flat PDFs (the table detector can help) and propose fields. | ★ A first, then B |
| Compare two PDFs | A. Text diff from `engine/ai/compare.ts` in a side-by-side panel. B. Visual pixel diff per page. | ★ A, then B as an overlay |
| PDF/A | A. "Save as PDF/A-2b": embed fonts, add an sRGB OutputIntent and XMP identification; validate with veraPDF in CI only. B. Full PDF/A-1b, which also needs transparency flattening. | ★ A |
| Accessibility | A. Checker from the structure walker: title, language, tags present, image alt text, reading order. B. Auto-tagging from the flow and layout engine. | ★ A first; B is large |
| Export to Word / Excel | A. In the browser: build DOCX from the flow layout (text, fonts, images) with an MIT-licensed DOCX writer, and XLSX from detected tables. B. LibreOffice compiled to WebAssembly (very large download, slow). C. Server conversion. | ★ A, labelled "editable approximation"; C conflicts with local-only |
| OCR to editable text | A. Replace the invisible OCR text layer with real text runs in a matching font over a cleaned background. B. Keep searchable-only. | A is large; keep B until Phase 2 is done |
| Certificate encryption, stamps, measure | A. UI over the existing `security/public-key` module; a stamp library built on signature appearances; a measure tool with scale calibration. | ★ A, each medium-sized |

### Suggested order

1. **Quick wins (days):** Print, headers / footers / page numbers, search-and-redact
   presets, spell check, drawing move and resize, diagnostic report button.
2. **Robustness (weeks, in parallel):** producer corpus and render diff in CI,
   WebKit and Firefox projects, performance budgets, `page.tsx` extraction.
3. **User-visible features:** comments, bookmarks, crop pages, Chinese interface.
4. **Pro features:** form authoring, compare, PDF/A-2b, accessibility checker,
   Word / Excel export.
