# End-to-end test checklist

How we make sure every editor tool works. There are three layers:

1. **Automated specs** in `tests/e2e/` run on every push to `main` in CI, using
   generated PDFs (see [tests/e2e/README.md](../tests/e2e/README.md)).
2. **Tool sweep** (`scripts/tool-sweep.mjs`) runs every tool against a real
   portfolio PDF and reports PASS / WARN / FAIL per step plus console errors.
3. **Manual checklist** below covers what neither of the above can judge (looks,
   feel, real devices).

Tool descriptions are in [TOOLS.md](TOOLS.md).

## Running

```sh
NEXT_PUBLIC_BASE_PATH=/Paperloom-PDF npm run build
NEXT_PUBLIC_BASE_PATH=/Paperloom-PDF npm run test:e2e

# Tool sweep against a real PDF (keep personal PDFs out of the repository)
NEXT_PUBLIC_BASE_PATH=/Paperloom-PDF node scripts/serve-static-e2e.mjs &
node scripts/tool-sweep.mjs ~/Downloads/portfolio.pdf
```

On macOS without Playwright's Chromium, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`.

The sweep's click positions are tuned for the A4 AI Preschool parent-portfolio
layout. Screenshots and the downloaded PDF land in `test-results/tool-sweep/`.

## Coverage by tool

✅ automated spec · 🔁 tool sweep · ✋ manual only

| Area | Control | Coverage |
|---|---|---|
| Select | Select an image, Replace Image | ✅ `svg-transparency` 🔁 |
| Select | Select and delete a drawing (stacked copies, scaled `cm`), undo | ✅ `drawing-delete` 🔁 |
| Select | Click empty page / background band selects nothing | ✅ `drawing-delete` 🔁 |
| Select | Duplicate a drawing (button, Ctrl/Cmd+D) and an image, undo | ✅ `drawing-delete` 🔁 |
| Edit Text | Duplicate text box | ✅ `drawing-delete` |
| Edit Text | Edit a line, Enter to commit, undo / redo | ✅ `mobile-line-edit` 🔁 |
| Edit Text | Add Text Box | ✅ `secure-redaction` 🔁 |
| Edit Text | Font, Size, Bold / Italic / Underline, Color, Alignment | ✋ |
| Edit Text | Scan for links | ✅ `mobile-line-edit` |
| Edit Text | Add link to selection, link popover (Edit, Remove, Open Link) | ✋ |
| Edit Text | Duplicate Line Below, Add Row Below, Add Column Right | ✋ |
| Highlight | Click a line, freehand drag | 🔁 |
| Draw | Freehand, Line, Arrow, Rectangle, Ellipse | 🔁 |
| Erase | Drag over drawings | 🔁 |
| Watermark | Add watermark | 🔁 |
| Watermark | Scan for Watermarks | ✅ `mobile-options-sheet` 🔁 |
| Watermark | Remove Selected, Image and Shape tabs | ✋ |
| Sign | Create (Type tab), save, place, move, rotate, lock, delete | ✅ `signature-placement`, `signature-touch-targets`, `signature-locked-page` 🔁 |
| Sign | Place into a PDF signature field | ✅ `signature-placement` |
| Sign | Certificates, Digitally sign document | ✅ `push-button-field`, `static-export`, `signature-widget-appearance` |
| Sign | Draw / Upload tabs, Validate, LTV, TSA, Import PEM | ✋ |
| Security | Region, page and mark redaction | ✅ `secure-redaction`, `redaction-recovery` |
| Security | Sanitize document | ✅ `security-clean` |
| Security | Open Inspect / Protect / Clean / Policy, Rescan | 🔁 |
| Security | Encrypt PDF, Remove encryption, Apply policy, other Clean buttons | ✋ |
| Forms | Text, checkbox, radio, choice fields, Flatten All | ✅ `form-*`, `text-widget-appearance`, `push-button-field`, `indirect-widget-*`, `mobile-form-reveal` |
| Header | Undo / Redo | ✅ several 🔁 |
| Header | Previous / Next page, Zoom in / out | ✅ `render-failure` 🔁 |
| Header | Theme toggle | ✅ `theme-system` 🔁 |
| Header | Focus mode | ✅ `mobile-form-reveal` 🔁 |
| Header | Pages panel toggle, Clear | ✋ |
| Header | Close file (unsaved dialog: Discard changes) | ✅ `mobile-line-edit` |
| Find & Replace | Search, Replace | ✅ `rotated-cross-run-search`, `multistream-edit-safety` 🔁 |
| Find & Replace | Replace All, Match case | ✋ |
| OCR | Recognize text (OCR) | ✅ `offline-ocr` |
| Export | PNG / JPEG / SVG / text | ✅ `form-widget-appearance`, `tiling-pattern-background` 🔁 |
| Export | Page range, DPI | ✋ |
| Download | Download, reopen the result | ✅ most specs 🔁 |
| Download | Download options: Compression | ✅ `touch-and-tooltip-ux` |
| Download | Download options: Save Mode, Resolution | ✋ |
| Pages | Rotate page, delete page (confirm) | ✅ `touch-and-tooltip-ux`, `signature-locked-page` 🔁 |
| Pages | Insert blank page, move page later, Remove current page, Download current page | 🔁 |
| Pages | Merge PDF, Insert PDF, Download each page, drag to reorder, Expand sidebar | ✋ |
| Mobile | Tool strip, options sheet, thumbnails drawer, text edit bar, touch handles | ✅ `touch-and-tooltip-ux`, `mobile-*`, `signature-touch-targets` |
| Rendering | Patterns, transparency, render failure and retry | ✅ `tiling-pattern-background`, `svg-transparency`, `render-failure` |

## Manual checklist

Run on the live site (https://yapweijun1996.github.io/Paperloom-PDF/editor/)
with a real PDF, on desktop and on a phone. Tick each item; note the browser.

### Every tool

- [ ] Each rail tool shows its name and shortcut on hover, and its shortcut key works
- [ ] Clicking empty page space with Select selects nothing
- [ ] Select an image: the box fields change it; Replace Image keeps its size; Delete removes it; Undo brings it back
- [ ] Select a drawing (card, box, line): Delete makes it disappear; Undo brings it back
- [ ] Duplicate an image, a drawing, a text box and a floating image with the button and Ctrl/Cmd+D; the copy is selected and Undo removes it
- [ ] Edit Text: change font, size, bold, italic, underline, colour and alignment; the page shows the change
- [ ] Edit Text: Chinese / CJK text stays aligned after editing
- [ ] Add a link to selected text, hover it, edit it, remove it
- [ ] Duplicate Line Below; in a table, Add Row Below and Add Column Right
- [ ] Highlight a line and draw a freehand highlight in another colour
- [ ] Draw each shape in a non-default colour and brush size
- [ ] Erase removes drawings but not page text
- [ ] Watermark: text, image and shape watermarks; Remove Selected after a scan
- [ ] Sign: create with Draw, Upload and Type; place, resize, rotate, lock, delete
- [ ] Security: Encrypt PDF with a password; reopen the download, which asks for the password; Remove encryption
- [ ] Security: redact a region, check that the text cannot be found or copied in the download

### Header and pages

- [ ] Undo / Redo after each kind of edit
- [ ] Zoom with the buttons, Ctrl/Cmd +/−, and trackpad pinch
- [ ] Dark mode: every panel and dialog is readable
- [ ] Focus mode and the Pages panel toggle
- [ ] Merge PDF, Insert PDF, Insert blank page, drag a thumbnail to reorder
- [ ] Download each page (the browser may ask to allow several downloads)
- [ ] Export each format with a page range and each DPI
- [ ] Download options: each Save Mode, Resolution and Compression; the file opens in another PDF reader
- [ ] Close with unsaved edits: Keep editing, Discard changes, Download and close

### Phone

- [ ] Tool strip scrolls; options open as a sheet and close
- [ ] Edit text with the on-screen keyboard; Done and Cancel work
- [ ] Signature handles are large enough to drag with a finger
- [ ] Thumbnails drawer opens from the "{N}p" button

## Sweep log

| Date | Build | PDF | Result |
|---|---|---|---|
| 2026-11-03 | local static export | AI Preschool portfolio, 5 pages (browser-printed) | 30 PASS, 0 WARN, 0 FAIL, 0 console errors |
| 2026-11-03 | local static export, with Duplicate | same PDF | 32 PASS, 0 WARN, 0 FAIL, 0 console errors |

Found by the sweep on 2026-11-03 and fixed: deleting a drawing in a
browser-printed PDF failed with "The selected object changed or is ambiguous".
Such PDFs paint shapes several times and draw them under a scaling transform,
so the editor now locates drawings by their content-stream position. Full-width
background bands are no longer selectable.
