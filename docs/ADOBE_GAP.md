# Paperloom PDF vs Adobe Acrobat Pro

Where Paperloom stands against Adobe Acrobat Pro, and what it takes to reach
Acrobat production level. Status is taken from the code and e2e suite as of
2026-11-03 (`main` at 463d35a); percentages are judgement, not measurement.

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
| Edit text in place | ✅ | Line editing with font, size, style, colour, alignment; CJK fixes |
| Paragraph reflow across lines | 🟡 | Flow engine exists; editing is line-by-line |
| Add / replace / move / resize images | ✅ | |
| Crop, flip, rotate an image | ❌ | |
| Select and delete vector drawings | ✅ | Fixed for browser-printed PDFs on 2026-11-03 |
| Move / resize drawings | 🟡 | Engine transform exists; no handles in UI |
| Duplicate objects | 🟡 | Text lines only; images and drawings in progress |
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
1. Duplicate, move and resize for every object; crop images (S–M).
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
