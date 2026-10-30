# Static persona code review — 2026-10-30

## Scope and evidence

A read-only source review of commit `d7a2f90` plus the uncommitted working-tree
changes present on 2026-10-30. Ten personas reviewed the code in five parallel
passes. Their 120 raw points were merged into the 100 below. Nothing was
installed, built, tested or run in a browser for this review, so runtime impact
is inferred from code unless an entry says otherwise.

This is a static code review. It is separate from the browser and end-to-end
audit in [UX_E2E_AUDIT.md](UX_E2E_AUDIT.md), whose personas are UX viewpoints.
It deliberately excludes the earlier leads in [README.md](README.md#review-findings-awaiting-verification)
and the defects already recorded as BUG-001 to BUG-016 in [BUG.md](../BUG.md),
except where a point adds new evidence.

- **Verified:** ✔ marks entries whose cited lines were re-read by the reviewer
  who merged the list. Other entries were source-read by one persona pass.
- **Line drift:** `src/app/editor/page.tsx` was being edited during the review.
  Its line references may be off by about 12 lines after line 2219.
- **Priority and effort:** P0 means a broken core flow, data loss or an
  exploitable issue. Effort is S, M or L. These are review labels; the
  register in BUG.md uses its own P1/P2 scale.
- **Tracking:** each point is tracked in [task.md](../task.md) and, for
  confirmed defects, in BUG.md. Items added from this review use the reserved
  ranges BUG-101 onward and TASK-101 onward, because the lower ranges were
  being extended concurrently by another review.

## Highest-impact points

1. #39 and #43 — malformed tokens stop the parser from advancing, and the
   worker has no timeout, so a damaged or crafted PDF can hang indefinitely.
2. #54 — streams with an indirect `/Length` are cut at the first `endstream`
   and lose trailing EOL bytes; a save may write the shortened data back.
3. #1 — Close and the logo discard unsaved work (BUG-002).
4. #12 and #4 — drawing tools and signature placement do not work on touch.
5. #9 — security policies and a blank owner password use built-in passwords.
6. #50 — every cross-reference entry is written as 21 bytes instead of 20.
7. #52 — literal strings above U+00FF become invalid octal escapes.
8. #63 — overlays have no page identity and may commit to the wrong page.
9. #21 and #23 — the page is canvas-only and many icon buttons have no name.
10. #91 and #92 — no end-to-end suite and no CI in this checkout.

## 1. Office end user

| # | Point | P · effort | Evidence | Tracked in |
| --- | --- | --- | --- | --- |
| 1 | Close (X) and the logo leave without a dirty check; Close clears autosave and the stored PDF. | P0 · S | [page.tsx:4768](../src/app/editor/page.tsx#L4768), [Toolbar.tsx:85](../src/app/editor/components/Toolbar.tsx#L85) | BUG-002, TASK-02 |
| 2 | Replace changes every match on the page; neither action records history; the case-insensitive path interprets `$&` and `$$` in the replacement. | P1 · M | [text-editor.ts:2159](../src/engine/editor/text-editor.ts#L2159) | BUG-006, BUG-007, TASK-04 |
| 3 | Each keystroke in a form value is one history entry plus a full re-render and thumbnail rebuild; choice fields are free text. | P1 · M | [page.tsx:2259](../src/app/editor/page.tsx#L2259), [PropertiesSidebar.tsx:946](../src/app/editor/components/PropertiesSidebar.tsx#L946) | TASK-106 |
| 4 | The Sign panel says "click the page to place", but placement is drag-and-drop only; keyboard and touch users cannot place. | P0 on touch/keyboard · M | [PropertiesSidebar.tsx:1357](../src/app/editor/components/PropertiesSidebar.tsx#L1357), [PropertiesSidebar.tsx:1624](../src/app/editor/components/PropertiesSidebar.tsx#L1624) | TASK-104 |
| 5 | Autosave failures reach only the console; there is no persistent saved/unsaved indicator; downloads reuse the original file name without confirmation. | P1 · S | [page.tsx:810](../src/app/editor/page.tsx#L810), [pdfStorage.ts:72](../src/lib/pdfStorage.ts#L72) | TASK-02 |
| 6 | A recovered session silently replaces the upload; there is no "start from original" and no "continue last document" on the home page. | P1 · M | [page.tsx:899](../src/app/editor/page.tsx#L899) | TASK-02 |
| 7 | One fixed IndexedDB key is shared by all tabs, so a second tab or upload can overwrite or swap the first tab's document. | P1 · M | [pdfStorage.ts:4](../src/lib/pdfStorage.ts#L4) | TASK-02 |
| 8 | Digitally signed PDFs give no warning on open; edits are refused only at autosave or download. | P1 · M | [save-pipeline.ts:96](../src/engine/writer/save-pipeline.ts#L96) | TASK-02 |
| 9 | ✔ The Confidential policy encrypts with `confidential`/`owner`; Encrypt falls back to owner password `owner`. | P1 · S | [policy-engine.ts:56](../src/engine/security/policy/policy-engine.ts#L56), [SecurityPanel.tsx:228](../src/app/editor/components/SecurityPanel.tsx#L228) | BUG-107, TASK-103 |
| 10 | Any `*.pdf` name passes the home check; parse errors show raw engine text; the error screen's Go Back deletes the stored copy. | P2 · S | [pdf-file-validation.ts:7](../src/app/pdf-file-validation.ts#L7), [page.tsx:5246](../src/app/editor/page.tsx#L5246) | TASK-02 |
| 11 | Enter commits the line during IME composition; Shift+Enter duplicates the line instead of inserting a break. | P1 · S | [page.tsx:4261](../src/app/editor/page.tsx#L4261) | TASK-106 |

## 2. Mobile and touch user

| # | Point | P · effort | Evidence | Tracked in |
| --- | --- | --- | --- | --- |
| 12 | ✔ Draw, highlight and erase use mouse events only, and mobile sets `touch-action: manipulation`, so a finger drag scrolls. | P0 · M | [page.tsx:5681](../src/app/editor/page.tsx#L5681), [page.tsx:5609](../src/app/editor/page.tsx#L5609) | BUG-108, TASK-104 |
| 13 | Text-edit focus happens outside the user gesture and is never scrolled above the keyboard; the hidden textarea keeps autocorrect and may be under 16px (iOS zoom). Inferred. | P1 · M | [page.tsx:1592](../src/app/editor/page.tsx#L1592), [EditableLineBox.tsx:540](../src/app/editor/components/EditableLineBox.tsx#L540) | TASK-104 |
| 14 | No on-screen Done/Cancel for line edits; dismissing the keyboard commits a half-typed line. | P1 · M | [page.tsx:4284](../src/app/editor/page.tsx#L4284) | TASK-104 |
| 15 | No pinch zoom or fit-to-width; pages open at 100%, wider than a phone. | P1 · M | [page.tsx:121](../src/app/editor/page.tsx#L121) | TASK-104 |
| 16 | Thumbnail reorder is HTML5 drag-and-drop; delete and rotate are visible on hover only. | P1 · M | [ThumbnailsSidebar.tsx:343](../src/app/editor/components/ThumbnailsSidebar.tsx#L343) | TASK-104, TASK-06 |
| 17 | Every tool tap opens a 65vh modal sheet over the page; tapping a form field on a phone shows nothing. | P1 · M | [ToolsSidebar.tsx:85](../src/app/editor/components/ToolsSidebar.tsx#L85), [usePanelLayout.ts:8](../src/app/editor/hooks/usePanelLayout.ts#L8) | TASK-104 |
| 18 | Touch targets are 10–26px and mobile tool labels 8px. | P2 · M | [Toolbar.tsx:111](../src/app/editor/components/Toolbar.tsx#L111), [ToolsSidebar.tsx:106](../src/app/editor/components/ToolsSidebar.tsx#L106) | TASK-104 |
| 19 | Layout switches on width only, so tablets get three desktop panels; no `dvh` or safe-area handling. | P1 · M | [useIsMobile.ts:9](../src/app/editor/hooks/useIsMobile.ts#L9) | TASK-104 |
| 20 | Downloads revoke the blob URL immediately after `click()`; no Web Share fallback. Inferred for mobile browsers. | P1 · S | [page.tsx:4674](../src/app/editor/page.tsx#L4674) | TASK-104 |

## 3. Accessibility auditor

| # | Point | P · effort | Evidence | Tracked in |
| --- | --- | --- | --- | --- |
| 21 | The page is a bare canvas with no text layer, focus stop or keyboard way to start editing. | P0 · L | [page.tsx:1214](../src/app/editor/page.tsx#L1214) | TASK-06 |
| 22 | Signature, image and text-box overlays cannot be focused, so existing keyboard nudge/delete actions never apply. | P1 · M | [SignatureOverlay.tsx:205](../src/app/editor/components/signatures/SignatureOverlay.tsx#L205), [keyboard-actions.ts:44](../src/app/editor/keyboard-actions.ts#L44) | TASK-06 |
| 23 | Many icon-only buttons have no accessible name, beyond the toolbar and tool rail already recorded. | P1 · S | [PropertiesSidebar.tsx:356](../src/app/editor/components/PropertiesSidebar.tsx#L356), [LinkPopover.tsx:146](../src/app/editor/components/LinkPopover.tsx#L146) | BUG-012, BUG-016, TASK-06 |
| 24 | Custom dialogs, drawers and menus lack dialog semantics, focus trapping and focus return; installed Radix primitives are mostly unused. | P1 · M | [PasswordDialog.tsx:36](../src/app/editor/components/PasswordDialog.tsx#L36), [DownloadDropdown.tsx:108](../src/app/editor/components/DownloadDropdown.tsx#L108) | TASK-06 |
| 25 | Panel controls have unassociated labels and no pressed state; AcroForm types show as `Tx/Btn/Ch`. | P1 · M | [PropertiesSidebar.tsx:326](../src/app/editor/components/PropertiesSidebar.tsx#L326), [PropertiesSidebar.tsx:936](../src/app/editor/components/PropertiesSidebar.tsx#L936) | TASK-06 |
| 26 | Single-key shortcuts cannot be disabled; Ctrl/Cmd +/- is taken from browser zoom; arrows flip pages even when zoomed. | P1 · M | [keyboard-actions.ts:37](../src/app/editor/keyboard-actions.ts#L37) | TASK-06 |
| 27 | `--text-faint` is 2.56:1, input borders about 1.2:1, and 183 text spans are under 12px. | P1 · S | [globals.css:22](../src/app/globals.css#L22) | TASK-06 |
| 28 | Errors, results and progress are not announced; three toasts share one position. | P2 · S | [page.tsx:6547](../src/app/editor/page.tsx#L6547) | TASK-06 |
| 29 | No `main` landmark or heading structure; the document title never includes the file name. | P2 · S | [layout.tsx:8](../src/app/layout.tsx#L8) | TASK-06 |
| 30 | No `prefers-reduced-motion` handling for sheets, drawers and spinners. | P2 · S | [globals.css:160](../src/app/globals.css#L160) | TASK-06 |

## 4. UX and visual designer

| # | Point | P · effort | Evidence | Tracked in |
| --- | --- | --- | --- | --- |
| 31 | Insert actions sit in the Text panel and show no active tool; the Sign panel mixes library, certificates, validation and LTV. | P2 · L | [types.ts:13](../src/app/editor/types.ts#L13), [StatusBar.tsx:29](../src/app/editor/components/StatusBar.tsx#L29) | TASK-108 |
| 32 | Merge, split and remove-page handlers are wired but have no visible entry point. | P2 · S | [ThumbnailsSidebar.tsx:88](../src/app/editor/components/ThumbnailsSidebar.tsx#L88) | TASK-108 |
| 33 | 177 hard-coded hex colours and 248 raw zinc/slate classes; the primary action colour changes per panel. | P2 · M | [globals.css:99](../src/app/globals.css#L99) | TASK-108 |
| 34 | Duplicated primitives: two icon systems, three swatch pickers, two switches; some animation classes have no plugin. | P3 · M | [PropertiesSidebar.tsx:445](../src/app/editor/components/PropertiesSidebar.tsx#L445) | TASK-108 |
| 35 | Dark mode ignores the OS preference, has no toggle on the home page and is applied unevenly to overlays. | P2 · M | [initialTheme.ts:3](../src/app/theme/initialTheme.ts#L3) | TASK-108 |
| 36 | Copy leaks PDF internals (`/AP`, `GC + dedup`, `Incremental`) and some labels are inaccurate. | P2 · S | [DownloadDropdown.tsx:161](../src/app/editor/components/DownloadDropdown.tsx#L161) | TASK-108, BUG-013 |
| 37 | No first-run guidance or shortcut reference; several behaviours (Shift+Enter, Space pan) are undiscoverable. | P2 · M | [page.tsx:141](../src/app/editor/page.tsx#L141) | TASK-108 |
| 38 | Bloom-era names remain, and README/CONTRIBUTING clone instructions point to the upstream repository. | P1 · S | [README.md:58](../README.md#L58), [CONTRIBUTING.md:8](../CONTRIBUTING.md#L8) | TASK-110 |

## 5. Security and cryptography engineer

| # | Point | P · effort | Evidence | Tracked in |
| --- | --- | --- | --- | --- |
| 39 | ✔ `)`, `{` and `}` are delimiters that `nextToken` does not consume, so dictionary and array loops can stop advancing. | P0 · S | [lexer.ts:425](../src/engine/parser/lexer.ts#L425), [parser.ts:302](../src/engine/parser/parser.ts#L302) | BUG-101, TASK-101 |
| 40 | ✔ The Form XObject cycle guard keys on an `ObjNum` entry that is never set; other walkers (page tree, `/Next`, composite glyphs, CMap ranges) lack visited sets or caps. | P1 · M | [renderer.ts:1466](../src/engine/render/renderer.ts#L1466) | BUG-105, TASK-101 |
| 41 | Decoders, image allocation and canvas size have no budgets (Flate/LZW output, Width×Height, page×zoom×DPR). | P1 · M | [filters.ts:109](../src/engine/parser/filters.ts#L109), [renderer.ts:158](../src/engine/render/renderer.ts#L158) | TASK-101 |
| 42 | ✔ DER lengths use signed shifts; a negative length makes a constructed node stop advancing. | P1 · S | [signature-verify.ts:47](../src/engine/signatures/crypto/signature-verify.ts#L47) | BUG-106, TASK-101 |
| 43 | Worker errors fall back to parsing the same bytes on the main thread; requests have no timeout; one failure disables the worker permanently. | P1 · M | [client.ts:28](../src/engine/worker/client.ts#L28) | TASK-101 |
| 44 | PDF `/URI` values reach `window.open` without a scheme allow-list. | P2 · S | [page.tsx:2671](../src/app/editor/page.tsx#L2671), [link.ts:135](../src/engine/editor/link.ts#L135) | TASK-103 |
| 45 | PKCS#12 import ignores the password and MAC, rejects encrypted bags, and advises exporting with `-nodes`. | P2 · L | [pkcs12.ts:218](../src/engine/signatures/certificates/pkcs12.ts#L218) | TASK-103 |
| 46 | No Content-Security-Policy; a static export can inject a hashed meta CSP at build time. | P2 · M | [layout.tsx:27](../src/app/layout.tsx#L27) | TASK-103 |
| 47 | RFC 3161 responses are accepted without checking messageImprint, nonce or the TSA signature. | P2 · M | [timestamp-client.ts:216](../src/engine/signatures/timestamp/timestamp-client.ts#L216) | TASK-103 |
| 48 | `randomBytes` and the file ID fall back to `Math.random`; there is no injectable RNG or clock for known-answer tests. | P2 · M | [bytes.ts:103](../src/engine/security/crypto/bytes.ts#L103) | TASK-103 |
| 49 | Signature images and certificate details are stored in plain localStorage on an origin that GitHub Pages shares per owner. | P3 · M | [library.ts:128](../src/engine/signatures/visual/library.ts#L128) | TASK-103 |

## 6. PDF specification and interoperability expert

| # | Point | P · effort | Evidence | Tracked in |
| --- | --- | --- | --- | --- |
| 50 | ✔ Cross-reference entries end in SP CR LF (21 bytes); incremental trailers drop `/ID`; `/Length` is not recomputed. | P1 · S | [serializer.ts:260](../src/engine/writer/serializer.ts#L260), [incremental-writer.ts:301](../src/engine/writer/incremental-writer.ts#L301) | BUG-103, TASK-102 |
| 51 | Encrypted files with object streams are extracted before decryption. | P1 · M | [parser.ts:164](../src/engine/parser/parser.ts#L164) | TASK-107 |
| 52 | ✔ Literal strings above U+00FF are written as multi-digit octal escapes. | P1 · S | [stream-compiler.ts:225](../src/engine/editor/stream-compiler.ts#L225) | BUG-104, TASK-102 |
| 53 | Xref reading does not rebuild truncated files, can prefer the oldest revision, ignores `/XRefStm` and can resurrect freed objects. | P1 · M | [xref.ts:291](../src/engine/parser/xref.ts#L291) | TASK-101 |
| 54 | ✔ Indirect `/Length` streams are cut at the first `endstream` and every trailing CR/LF is trimmed. Write-back is not reproduced. | P0 pending repro · M | [parser.ts:366](../src/engine/parser/parser.ts#L366), [parser.ts:415](../src/engine/parser/parser.ts#L415) | BUG-102, TASK-102 |
| 55 | Extraction follows destinations into unselected pages; the new catalog drops `/Lang`, `/StructTreeRoot`, `/OCProperties`, `/PageLabels` and similar entries. | P1 · M | [page-operations.ts:713](../src/engine/writer/page-operations.ts#L713) | TASK-107 (related BUG-009) |
| 56 | Saves never update ModDate, Producer or XMP, so edited PDF/A or PDF/UA files keep their claim. | P2 · M | [text-editor.ts:677](../src/engine/editor/text-editor.ts#L677) | TASK-102 |
| 57 | Optional content (layers) is ignored; default-off layers render and become editable. | P2 · M | [interpreter.ts:927](../src/engine/content/interpreter.ts#L927) | TASK-107 |
| 58 | Appearance `/Matrix`, annotation `/F` and `/AS`, unusual `/Rotate` values and `/UserUnit` deviate from the specification. | P2 · S | [renderer.ts:253](../src/engine/render/renderer.ts#L253) | TASK-107 |
| 59 | Checkbox and radio edits force `Yes`, write the widget instead of the field, skip siblings and replace the existing appearance. | P2 · M | [apply-field.ts:33](../src/engine/forms/apply-field.ts#L33) | TASK-106 |
| 60 | Embedded Type1 fonts, predefined CMaps/`usecmap`, vertical writing and RTL are not supported. | P2 · L | [font-parser.ts:426](../src/engine/fonts/font-parser.ts#L426) | TASK-107 |
| 61 | CCITT, JBIG2 and JPX images are passed through and drawn as raw samples. | P1 · L | [filters.ts:58](../src/engine/parser/filters.ts#L58) | TASK-107 |

## 7. Frontend architect

| # | Point | P · effort | Evidence | Tracked in |
| --- | --- | --- | --- | --- |
| 62 | The Zustand store, `usePdfDocument` and `useHistory` have no importers while `page.tsx` holds the same state. | P3 · S | [editorSession.ts](../src/app/editor/store/editorSession.ts) | TASK-10 |
| 63 | ✔ Floating text, floating images and drawn paths have no page field; the commit-before-leaving sequence is copied and several navigation paths skip it. | P1 · M | [types.ts:38](../src/app/editor/types.ts#L38), [page.tsx:3193](../src/app/editor/page.tsx#L3193) | BUG-109, TASK-105 |
| 64 | The mutable document graph needs five invalidation counters and a suppressed exhaustive-deps rule; the render effect mutates the document. | P2 · M | [page.tsx:1236](../src/app/editor/page.tsx#L1236) | TASK-10 |
| 65 | Legacy snapshot history and session history coexist through refs and a side map. | P2 · L | [page.tsx:308](../src/app/editor/page.tsx#L308) | TASK-10 |
| 66 | 22 deep imports bypass `browser-core`; the guard only rejects the root barrel. | P2 · S | [page.tsx:29](../src/app/editor/page.tsx#L29), [verify-browser-core.mjs:36](../scripts/verify-browser-core.mjs#L36) | TASK-10 |
| 67 | About 15 state/ref pairs and 700 lines of handlers manage one text-edit session. | P2 · L | [page.tsx:145](../src/app/editor/page.tsx#L145) | TASK-10 |
| 68 | Watermark (22 states) and signature/certificate (14 states) flows live in the page, with `as any` casts from a missing type export. | P3 · M | [page.tsx:265](../src/app/editor/page.tsx#L265) | TASK-10 |
| 69 | Parser, writer and worker depend on `editor/stream-compiler.ts`; three files exceed 1,600 lines. | P3 · M | [stream-compiler.ts](../src/engine/editor/stream-compiler.ts) | TASK-10 |
| 70 | The Quick save mode is never incremental in product code although the UI says it appends. | P2 · M | [save-pipeline.ts:113](../src/engine/writer/save-pipeline.ts#L113), [DownloadDropdown.tsx:153](../src/app/editor/components/DownloadDropdown.tsx#L153) | TASK-10 |
| 71 | Dead code and placeholders: `bloomBridge.ts`, `phase-stubs.ts`, `engine/ocr`, the `/debug` route, empty ROADMAP/COMPLIANCE files and the stale PWA baseline. | P3 · S | [bloomBridge.ts](../src/app/editor/bloomBridge.ts), [debug/page.tsx](../src/app/debug/page.tsx) | TASK-10 |
| 72 | 9 `any`, 17 `as unknown as`, and five copies of the blob-download block. | P3 · S | [page.tsx:4669](../src/app/editor/page.tsx#L4669) | TASK-10 |

## 8. Performance engineer

| # | Point | P · effort | Evidence | Tracked in |
| --- | --- | --- | --- | --- |
| 73 | Every edit re-renders and JPEG-encodes thumbnails for all pages. | P1 · M | [page.tsx:993](../src/app/editor/page.tsx#L993) | TASK-11 |
| 74 | Images are decoded again on every render, including RGBA read-back for JPEG. | P1 · M | [renderer.ts:1286](../src/engine/render/renderer.ts#L1286) | TASK-11 |
| 75 | One render interprets the content stream three times, re-parses fonts and registers FontFaces that are never removed. | P2 · M | [renderer.ts:1362](../src/engine/render/renderer.ts#L1362) | TASK-11 |
| 76 | Legacy history snapshots every page per entry; each session transaction serializes three times and clones all streams. | P1 · L | [editor-history.ts:314](../src/engine/editing/editor-history.ts#L314), [document-edit.ts:383](../src/engine/session/document-edit.ts#L383) | TASK-11 |
| 77 | Autosave rewrites the whole PDF after each idle window; every storage call opens a new IndexedDB connection. | P1 · M | [page.tsx:786](../src/app/editor/page.tsx#L786), [pdfStorage.ts:38](../src/lib/pdfStorage.ts#L38) | TASK-11 |
| 78 | Search interprets every page synchronously on each query, page change and edit. | P2 · M | [page.tsx:2308](../src/app/editor/page.tsx#L2308) | TASK-11 |
| 79 | Opening decodes every stream eagerly and copies each buffer three times across the worker boundary. | P2 · L | [parser.ts:136](../src/engine/parser/parser.ts#L136) | TASK-11 |
| 80 | Canvas backing stores have no pixel budget and renders cannot be aborted. | P2 · M | [renderer.ts:158](../src/engine/render/renderer.ts#L158) | TASK-11 |
| 81 | Each pointer or key event re-renders the whole editor component; no child is memoized. | P2 · L | [page.tsx:411](../src/app/editor/page.tsx#L411) | TASK-11 |
| 82 | Static imports defeat the dynamic engine import; pdf-lib, upng and all security engines load with the editor. | P2 · M | [page.tsx:24](../src/app/editor/page.tsx#L24) | TASK-11 |
| 83 | About 26 MB of CJK fonts have no persistent cache, and one missing glyph can fetch several of them. | P2 · M | [unicode-font-embed.ts:300](../src/engine/fonts/unicode-font-embed.ts#L300) | TASK-11, TASK-110 |

## 9. QA and test engineer

| # | Point | P · effort | Evidence | Tracked in |
| --- | --- | --- | --- | --- |
| 84 | No coverage provider or thresholds; about 85 of 237 modules are never named by a test. | P1 · S | [vitest.config.ts](../vitest.config.ts) | TASK-109 |
| 85 | The editor page, most panels, hooks and the OCR adapter have no tests. | P1 · L | [page.tsx](../src/app/editor/page.tsx) | TASK-109 |
| 86 | Tests needing openssl, qpdf or pdfsig either crash or pass silently; temporary directories leak test key material. | P1 · S | [phases-10-14.test.ts:47](../src/engine/__tests__/signatures/phases-10-14.test.ts#L47) | TASK-109 |
| 87 | Only `*.test.ts` files are collected; environments are set per file; tests are named by phase rather than module. | P2 · M | [vitest.config.ts:7](../vitest.config.ts#L7) | TASK-109 |
| 88 | The golden-render plan is unimplemented and fixtures are synthetic only. | P2 · M | [golden/README.md](../src/engine/__tests__/golden/README.md) | TASK-08 |
| 89 | TypeScript uses `strict` only; there is no `typecheck` script. | P2 · M | [tsconfig.json](../tsconfig.json) | TASK-09 |
| 90 | `verify:pdf-worker` reports PASS when `out/` is missing; guard scripts have no tests. | P2 · S | [verify-pdf-worker.mjs:20](../scripts/verify-pdf-worker.mjs#L20) | TASK-09 |
| 91 | No Playwright or other end-to-end suite exists in this checkout. | P1 · M | `git ls-files` (no e2e configuration) | TASK-109 |
| 92 | No `.github` workflow exists, although the documentation describes CI and Pages workflows. | P1 · M | [DEPLOY_PAGES.md:1](DEPLOY_PAGES.md#L1) | BUG-015, TASK-09 |

## 10. Release engineer and open-source maintainer

| # | Point | P · effort | Evidence | Tracked in |
| --- | --- | --- | --- | --- |
| 93 | The package is named `pdf-editor-scaffold` with no licence, repository or engines fields; storage keys are generic; `.gitattributes` covers PDFs only. | P2 · S | [package.json:2](../package.json#L2), [.gitattributes](../.gitattributes) | TASK-09, TASK-110 (related BUG-014) |
| 94 | No CHANGELOG, tags or visible build version; release checks are spread across scripts and prose. | P2 · M | [package.json:3](../package.json#L3) | TASK-09 |
| 95 | No NOTICE file or third-party licence inventory for the Apache-2.0 upstream and bundled code. | P1 · S | [LICENSE:188](../LICENSE#L188) | TASK-110 |
| 96 | Ten runtime dependencies have no imports; `fabric` also pulls optional `canvas` and `jsdom`. | P2 · S | [package.json:19](../package.json#L19) | TASK-110 |
| 97 | About 3.5 MB of unreferenced public files ship in the static export, including a 1.2 MB PDF.js worker. | P2 · S | [public/pdf.worker.min.mjs](../public/pdf.worker.min.mjs) | TASK-110 |
| 98 | Metadata claims zero external dependencies and the README says files never leave the device, while timestamping and OCR asset loading use the network. | P2 · S | [layout.tsx:10](../src/app/layout.tsx#L10), [timestamp-client.ts:12](../src/engine/signatures/timestamp/timestamp-client.ts#L12) | TASK-103 |
| 99 | The offline PWA direction has no manifest or service worker. | P1 · M | `git ls-files public` (no manifest) | TASK-110 |
| 100 | No SECURITY.md; Code of Conduct reports go to public issues. | P1 · S | [CODE_OF_CONDUCT.md:61](../CODE_OF_CONDUCT.md#L61) | TASK-110 |
