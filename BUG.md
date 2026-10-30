# Bug register

Initial review was against commit `d7a2f90` on 2026-10-30. Findings remain open
unless their status explicitly says otherwise. Most entries are based on static
inspection; priority should be reassessed after reproducing each case.
The earlier, separately scoped review leads remain in [docs/README.md](docs/README.md#review-findings-awaiting-verification); they have not all been rechecked here.
The prioritized implementation backlog is in [task.md](task.md).

## P1 — Security and data loss

### BUG-001: Failed signature verification can be reported as valid

- **Status:** Fixed in the current working tree; regression-tested at the engine
  boundary and checked in Chrome for untrusted, tampered and later-revision PDFs.
- **Trigger:** Validate a signed PDF whose document digest matches but whose CMS
  cryptographic signature verification fails or cannot be completed.
- **Original behavior:** The failure was downgraded to `null`, which was accepted as valid if
  the certificate is trusted or absent. A modified signature value in the
  excluded `/Contents` region can therefore potentially receive a `Valid` result.
- **Fix:** [validation-engine.ts](src/engine/signatures/validation/validation-engine.ts#L483)
  requires successful CMS verification, matching digest, verified coverage and
  an explicitly pinned signer certificate for `Valid`; incomplete checks report
  `Unknown`. The editor rejects validation when the current state may differ
  from the uploaded bytes and clears stale reports.
- **Evidence:** The targeted signature tests use a real signed PDF and mutate
  only its CMS signature; OpenSSL independently accepts the original and rejects
  the mutation. Tests also cover missing digest, unsupported algorithms,
  untrusted certificates, gap manipulation and subsequent revisions. `pdfsig`
  independently confirmed the sample signatures and current-file coverage.
- **Additional signing check:** A later browser-created PDF signed with a
  synthetic self-signed RSA identity was reported cryptographically valid and
  fully covered by Poppler `pdfsig`; the untrusted issuer was expected. This
  does not retest tampering or establish certificate-chain trust.
- **Trust follow-up:** A focused synthetic engine test passed for pinned leaf,
  unpinned, unknown-revocation and tampered cases. The editor supplies no trust
  anchors and CA-chain/signing-time validation is outside the current engine
  capability; an external OpenSSL chain check is not an application E2E pass.
- **Acceptance:** Reproduce with a valid signed fixture and a tampered signature;
  a failed cryptographic check must never yield `Valid`, and an unsupported or
  incomplete check must remain distinguishable from success.

### BUG-002: Closing a dirty document discards its recovery data without warning

- **Status:** Fixed in the current working tree; desktop browser checks exercised
  confirmation, cancellation, discard and download/restore. The mobile dialog
  layout and the signed-document failure message were also inspected.
- **Trigger:** Make an unsaved edit, then use the toolbar Close action.
- **Original behavior:** Close cleared the editor session and stored PDF and navigated away
  without checking `isDirty`. The `beforeunload` warning does not cover this
  client-side navigation.
- **Fix:** Close now waits for pending edits and offers keep editing, explicit
  discard, or download and close. The latest downloaded local copy is retained
  for resume; failed saves leave the editor open. See
  [page.tsx](src/app/editor/page.tsx) and [pdfStorage.ts](src/lib/pdfStorage.ts).
- **Acceptance:** Verify dirty and clean close paths, including reload and
  recovery; unsaved work must not be discarded without an explicit user choice.
- **Original browser reproduction (2026-10-30):** In an isolated Chrome session, after edits and
  a page insertion showed `Unsaved`, Close returned directly home without a
  confirmation. Navigating to `/editor/` redirected home instead of restoring
  the test document. A later browser check verified clean close retains the
  saved document for resume.

### BUG-003: JavaScript removal misses chained actions

- **Status:** Fixed for the supported action locations in the current working
  tree; the inspector explicitly reports that its scan is not exhaustive. XFA
  forms and unresolvable form dictionaries are rejected before cleanup.
- **Trigger:** A PDF action has a non-JavaScript root with a JavaScript action
  in its `/Next` chain; run Security > Clean > Remove JavaScript or Sanitize.
- **Original behavior:** The removal code checked only the root action or array entries and
  does not traverse `/Next`, although the analyzer does. The UI reports removal
  while the chained action remains.
- **Evidence:** [javascript-engine.ts:100](src/engine/security/javascript/javascript-engine.ts#L100),
  [javascript-engine.ts:206](src/engine/security/javascript/javascript-engine.ts#L206),
  [SecurityPanel.tsx:265](src/app/editor/components/SecurityPanel.tsx#L265).
- **Acceptance:** Reopen sanitized fixtures with direct, indirect and array
  `/Next` chains; prohibited actions must be absent, including nested chains.
- **Verification:** Tests cover nested, indirect, shared and cyclic chains and
  save/reopen, with additional page-navigation, 3D, field and outline locations.
  Chrome exercised both cleanup actions with a chained fixture and checked the
  saved bytes for the fixture's script marker. Cleanup requires a full rewrite;
  unsupported XFA is rejected instead of silently claiming success, including
  in a Chrome check of the final build.

### BUG-004: Secure redaction leaves vector content in the output

- **Status:** Partly fixed. The secure engine can clear isolated pages fully
  covered by one or more marks and wholly covered filled or stroked rectangles in simple unfiltered or
  strictly verified Flate-compressed target streams, including tested paths
  made of multiple rectangles when every subpath is fully covered.
  Complex paths and retained filtered streams remain unsupported; the legacy
  API rejects marked documents.
- **Trigger:** Apply the exported secure-redaction API to a region containing
  vector paths, including outlined text or graphics.
- **Original behavior:** Vector removal defaulted to enabled, but intersecting paths were
  deliberately left in the content stream; the redaction annotations are then
  removed and the operation returns normally.
- **Evidence:** [redaction-engine.ts:157](src/engine/security/redaction/redaction-engine.ts#L157),
  [redaction-engine.ts:223](src/engine/security/redaction/redaction-engine.ts#L223),
  [redaction-engine.ts:252](src/engine/security/redaction/redaction-engine.ts#L252).
  The original review found no editor UI caller; the editor now exposes the
  supported secure-redaction workflow ([BUG-198](#bug-198-secure-redaction-cannot-be-performed-from-the-editor)).
- **Acceptance:** Test outlined text and graphics in a saved and reopened PDF;
  remove the underlying content or explicitly reject unsupported redaction.
- **Verification:** Saved and reopened fixtures confirm removal of fully covered
  rectangles and full-page content; independent rendering checks preserve the
  surrounding graphics, including compressed target streams and multiple marks.
  Adjacent or overlapping marks may jointly cover a rectangle; a gap causes
  refusal without mutation. Signed-document refusal was tested with synthetic
  signature dictionaries and ByteRange data, not a real certificate.
  Multiple marks can also jointly cover a full page; Poppler confirmed that
  real page text disappears after save and reopen, and gap cases are rejected.
  A restricted same-page Text/Popup annotation subset can also be removed.
  Checks reject unknown fonts, streams and possible fragments when all distinct
  secret bytes are present in inspected retained data. This may refuse ordinary
  documents even without a copy. Arbitrary transformed semantic copies cannot be
  ruled out.
  Empty marks and boundary-only contact are rejected without mutation. Retained
  streams that cannot be strictly inspected are rejected; checks cannot prove
  absence of all differently scaled or semantic equivalents.
  Complex paths and shared or ambiguous resources remain unsupported.

### BUG-005: Secure redaction can retain image data and report a false clean result

- **Status:** Partly fixed. The secure engine can clear an isolated full page
  or wholly covered images in a restricted graphics subset, including a strictly
  verified Flate-compressed target stream. Other cases are rejected, including
  documents with retained filtered streams. Verification
  is diagnostic and cannot assert complete absence.
- **Trigger:** Redact an image, or verify forbidden text represented as a hex
  string or in a nested object.
- **Original behavior:** Image redaction removed the drawing `Do` instruction but did not
  remove the image resource reference, leaving its bytes reachable. Separately,
  `verifyRedaction` scans only literal page-stream bytes and Info strings, so it
  can return `ok` when encoded or nested content remains.
- **Evidence:** [redaction-engine.ts:208](src/engine/security/redaction/redaction-engine.ts#L208),
  [redaction-engine.ts:311](src/engine/security/redaction/redaction-engine.ts#L311).
  This is an exported engine API finding; an editor UI caller was not established.
- **Acceptance:** Inspect saved PDF objects and decoded text for image, encoded
  text and nested-object fixtures; verification must not assert absence beyond
  what it actually checks.
- **Verification:** Saved and reopened fixtures confirm removal of supported
  image resources and preserve surrounding graphics; multiple marks can jointly
  cover an image, while gaps cause refusal without mutation. Tests also cover refusal
  without mutation. The diagnostic scan detects nested, hexadecimal, UTF-16
  and split text, but a scan with no matches remains explicitly incomplete.
  Compressed duplicate streams are rejected; independent semantic copies in
  other representations may still exist.

## P2 — Editing and document fidelity

### BUG-006: Replace current changes every match on the selected page

- **Status:** Fixed for tested text-run matches; isolated Chrome confirmed one
  replacement changes four matches to three.
- **Trigger:** Search for a term occurring multiple times on one page and choose
  Replace for the selected match.
- **Original behavior:** The handler passed only the search term and page to a function
  that replaces every occurrence in every matching text run on that page.
- **Evidence:** [page.tsx:2385](src/app/editor/page.tsx#L2385) and
  [text-editor.ts:2151](src/engine/editor/text-editor.ts#L2151).
- **Acceptance:** Verify single-match replacement independently from Replace All,
  including multiple matches in the same run and on different pages.
- **Browser check (2026-10-30):** A synthetic two-page PDF had four `sample`
  matches, two per page. One Replace reduced the count from four to two and
  selected page 2, showing that both matches on page 1 were replaced.

### BUG-007: Find-and-replace bypasses editor undo history

- **Status:** Fixed for tested single and multi-page replacements; engine tests
  and Chrome exercised undo and redo through the document transaction history.
- **Trigger:** Replace one or all search matches, then use Undo.
- **Original behavior:** Both handlers directly updated page content without creating an
  editor history transaction. Undo cannot reliably restore the replacement and
  may instead undo an earlier operation.
- **Evidence:** [page.tsx:2392](src/app/editor/page.tsx#L2392) and
  [page.tsx:2408](src/app/editor/page.tsx#L2408); compare the transactional form
  edit at [page.tsx:2265](src/app/editor/page.tsx#L2265).
- **Acceptance:** Verify undo and redo for single and multi-page replacement,
  including interaction with earlier edits.
- **Browser check (2026-10-30):** After the replacement above, `Unsaved` was
  shown but Undo remained disabled when there were no earlier edits.

### BUG-008: An active search forces page navigation back to its match

- **Status:** Fixed in the current working tree; isolated Chrome exercised
  manual navigation with the search panel open and closed, and match navigation.
- **Trigger:** Search for a matching term, then navigate manually to another
  page, including after closing Find & Replace.
- **Original behavior:** `currentPage` reran the search effect, which reset the page to
  the active match; closing the panel leaves the query intact.
- **Evidence:** [page.tsx:2344](src/app/editor/page.tsx#L2344),
  [page.tsx:2363](src/app/editor/page.tsx#L2363), and
  [page.tsx:5630](src/app/editor/page.tsx#L5630).
- **Acceptance:** Manual navigation must remain on the requested page; next and
  previous match controls should still navigate to the selected match.
- **Browser check (2026-10-30):** With results on page 2, clicking the previous
  page control left the indicator at `2 / 2`. The closed-panel variant remains
  to be reproduced.

### BUG-009: Extracting or splitting pages loses AcroForm structure

- **Status:** Fixed for tested direct and inherited field trees; reopened outputs
  were edited and saved using the independent `pdf-lib` reader.
- **Trigger:** Extract or split a PDF containing form fields, especially widgets
  inheriting properties from parent fields.
- **Original behavior:** Extraction created a new catalog without `/AcroForm` and skipped
  every copied `/Parent` reference, including widget field parents. The exported
  PDF loses the field tree and inherited field properties.
- **Evidence:** [page-operations.ts:733](src/engine/writer/page-operations.ts#L733),
  [page-operations.ts:822](src/engine/writer/page-operations.ts#L822), and editor
  callers at [page.tsx:4872](src/app/editor/page.tsx#L4872).
- **Acceptance:** Extract and split forms with direct and inherited fields;
  reopen outputs and verify field names, values and editing in a PDF reader.

### BUG-010: Merging nested forms can drop later field branches

- **Status:** Fixed for the tested nested sibling and indirect-array fixtures.
  Tested safe root-name and font-resource conflicts are renamed, with field
  name mappings reported to the user. Ambiguous dependencies and other resource
  conflicts are rejected before mutation.
- **Trigger:** Insert a PDF whose form field tree contains multiple nested
  sibling branches with widgets.
- **Original behavior:** The relevance walk used `some`, which stopped at the first relevant
  child; subsequent nested branches are not marked and are filtered out when
  cloning the field tree.
- **Evidence:** [page-operations.ts:615](src/engine/writer/page-operations.ts#L615)
  and [page-operations.ts:644](src/engine/writer/page-operations.ts#L644).
- **Acceptance:** Insert and reopen a fixture with multiple nested sibling
  branches; all inserted fields and their parent relationships must survive.

### BUG-011: The upload entry point is not keyboard accessible

- **Status:** Fixed; Chrome verified keyboard focus and Enter activation, and
  automated tests cover both Enter and Space.
- **Trigger:** Attempt to open a PDF using only a keyboard on the home page.
- **Original behavior:** The clickable drop zone was a `div` without keyboard handling or
  focusability, and its file input is hidden.
- **Evidence:** [page.tsx:82](src/app/page.tsx#L82) and
  [page.tsx:113](src/app/page.tsx#L113). This confirms the code path behind the
  earlier accessibility lead in `docs/README.md`.
- **Acceptance:** In a browser, Tab reaches a named upload control; Enter and
  Space open the file picker, and drag-and-drop still works.
- **Browser check (2026-10-30):** On the local development build in Chrome,
  the first Tab focused Next.js Dev Tools rather than the upload area. The
  accessibility snapshot exposed no upload control while the input was hidden.

### BUG-012: Page and zoom toolbar buttons have no accessible names

- **Status:** Fixed; Chrome accessibility snapshots exposed all four names and
  disabled states, and keyboard navigation and zoom were exercised.
- **Trigger:** Navigate or zoom using assistive technology.
- **Original behavior:** Previous page, next page, zoom out and zoom in buttons contained
  only icons without an explicit accessible name.
- **Evidence:** [Toolbar.tsx:130](src/app/editor/components/Toolbar.tsx#L130).
- **Acceptance:** Inspect the accessibility tree and verify that all four
  controls expose distinct, meaningful names and retain their disabled states.
- **Browser check (2026-10-30):** The desktop Chrome accessibility snapshot
  exposed four page/zoom controls as unnamed buttons, including disabled state.

### BUG-013: Export descriptions advertise unsupported or misleading formats

- **Status:** Fixed; Chrome inspected the SVG output and confirmed the updated
  description identifies its embedded raster PNG.
- **Trigger:** Inspect the Export button tooltip or choose SVG export.
- **Original behavior:** The tooltip advertised Word and Markdown although the available
  formats are PNG, JPEG, SVG and text. The option says `SVG Vector`, but the
  generated SVG embeds a raster PNG of the page.
- **Evidence:** [Toolbar.tsx:218](src/app/editor/components/Toolbar.tsx#L218),
  [export-formats.ts:7](src/app/editor/export-formats.ts#L7), and
  [export-formats.ts:161](src/app/editor/export-formats.ts#L161).
- **Acceptance:** Labels accurately describe available formats and output;
  inspect the exported SVG and verify its description against its contents.
- **Browser check (2026-10-30):** SVG Vector export of a synthetic page
  generated an SVG Blob containing a base64 PNG and no `<text>` element. The
  visible export choices did not include Word or Markdown.

### BUG-014: The documented Node minimum is incompatible with the locked Next.js version

- **Status:** In progress. The supported Node ranges are declared and documented;
  a Node 20.20.2 offline clean install and production build passed on macOS arm64.
  Native Canvas test dependencies and Node 20 test compatibility were repaired.
  The full suite passed 2,202 tests without skips using a temporary qpdf build;
  repository-wide lint passed with 169 warnings. Other platforms and a cold
  network install remain unverified.
- **Trigger:** Set up the project using the README's minimum Node version.
- **Original behavior:** The README stated Node 18 or newer, while the locked
  Next.js package requires Node 20.9 or newer.
- **Evidence:** [README.md:50](README.md#L50) and
  [package-lock.json:7846](package-lock.json#L7846).
- **Acceptance:** Document and declare a supported Node version, then verify a
  clean install and the required checks on that version.

### BUG-015: Deployment guide references an absent Actions workflow

- **Status:** The deployment workflow from remote main is incorporated and the
  guide now describes it. Hosted workflow execution and the live site remain
  to be verified.
- **Trigger:** Follow the GitHub Pages guide in this checkout.
- **Original behavior:** The guide described a deployment workflow and smoke job,
  but no `.github` workflow was present in the checkout. The referenced
  `scripts/smoke-pages.sh` existed; the deployment workflow now invokes it.
- **Evidence:** [DEPLOY_PAGES.md:1](docs/DEPLOY_PAGES.md#L1) and
  [smoke-pages.sh](scripts/smoke-pages.sh).
- **Acceptance:** Confirm the intended deployment mechanism, make the tracked
  workflow and guide agree, and verify the deployed site and sub-path assets.

### BUG-016: Desktop tool buttons lack accessible names and selected state

- **Status:** Fixed; desktop and mobile accessibility snapshots expose tool
  names and selected state. Dedicated screen-reader testing remains pending.
- **Trigger:** Navigate the desktop tool sidebar with a screen reader.
- **Evidence:** [ToolsSidebar.tsx](src/app/editor/components/ToolsSidebar.tsx#L150)
  renders icon-only buttons without an accessible label or `aria-pressed`;
  their tooltip is a sibling rather than button text. This affects identifying
  tools and their active state.
- **Acceptance:** Each tool exposes its name and selected state in the browser
  accessibility tree and remains usable with keyboard and screen reader.
- **Browser check (2026-10-30):** The desktop Chrome accessibility snapshot
  exposed eight sidebar tool buttons without names. Screen-reader interaction
  and selected-state announcements were not tested.

### BUG-017: Reversed export range reports success for an empty file

- **Status:** Fixed; Chrome verified a reversed range shows an error and creates
  no Blob, while a valid range exports the selected pages.
- **Trigger:** Export Plain Text using a custom range From 3 To 1.
- **Actual:** The UI reports `Export complete — file downloaded!` while the
  generated `text/plain` Blob is zero bytes. A control range 1–2 produced an
  80-byte Blob with both expected page texts.
- **Evidence:** [ExportPanel.tsx](src/app/editor/components/ExportPanel.tsx#L111)
  builds an empty page list for a reversed range. The Blob was inspected in
  browser instrumentation; the operating-system download was not inspected.
- **Acceptance:** Reject reversed and otherwise invalid ranges with an actionable
  message, do not download or report success, and verify valid ranges across
  applicable export formats.

### BUG-018: Raster export resolution depends on display pixel ratio

- **Status:** Fixed and checked in Chrome at DPR 1 and 2 for PNG and JPEG;
  selected 72/150 DPI dimensions and multi-page JPEG output were verified.
- **Trigger:** Export a 300 × 400 pt page as PNG at Screen 72 DPI on a display
  reporting `devicePixelRatio = 2`.
- **Actual:** The PNG Blob decoded to 600 × 800 pixels instead of 300 × 400;
  a JPEG export at the same settings also decoded to 600 × 800. The selected
  export resolution is multiplied by the display pixel ratio in this case.
- **Evidence:** [export-formats.ts](src/app/editor/export-formats.ts#L108)
  supplies the DPI scale but no pixel-ratio override; the renderer defaults to
  the display ratio in [renderer.ts](src/engine/render/renderer.ts#L160).
  The Blob was inspected in-browser; OS download and visual fidelity were not.
- **Acceptance:** At each selected DPI, PNG and JPEG pixel dimensions reflect
  PDF points × DPI / 72, independent of display ratio. Verify at DPR 1 and 2.

### BUG-019: Export drawer close button has no accessible name

- **Status:** Fixed; Chrome exposed the named close control and restored focus to
  Export after closing, including at a 390 × 844 viewport.
- **Trigger:** Open Export and navigate its close control with assistive technology.
- **Actual:** The close control appears as an unnamed button, although clicking
  it closes the drawer. [ExportPanel.tsx](src/app/editor/components/ExportPanel.tsx#L193)
  renders only an icon without a label.
- **Acceptance:** The close button exposes a meaningful name, can be operated
  by keyboard, and closing the drawer restores focus to its trigger.

### BUG-020: Checked form field is read as unchecked by another PDF library

- **Status:** Fixed for tested direct and hierarchical checkboxes, multi-widget
  fields and radio options. Chrome toggled and downloaded a non-default on-state
  checkbox; `pdf-lib` confirmed both checked and unchecked outputs.
- **Trigger:** Check `Consent` in a PDF whose checkbox widget is a child of its
  field, then download the edited PDF.
- **Original behavior:** Paperloom displayed Checked and reopened its output as Checked,
  but pdf-lib reports `isChecked() === false` on two independently downloaded
  outputs. The field parent has no `/V`; its widget has `/V /Yes` and `/AS /Yes`.
- **Evidence:** [apply-field.ts](src/engine/forms/apply-field.ts#L32) writes the
  boolean value on `widget.dict`. The same fixture's edited text and dropdown
  values were read correctly by pdf-lib.
- **Acceptance:** Check and uncheck hierarchical and direct fields, save and
  reopen with Paperloom and independent readers; field values and appearance
  states must agree, including non-`Yes` on-state names and sibling widgets.

### BUG-021: Signed PDF graph edits had no automatic recovery

- **Status:** Recovery fixed in the current working tree. A signed draft is saved
  separately from the original signed bytes and can be restored after reload.
  Exporting the modified PDF remains intentionally blocked because it would
  invalidate its signature.
- **Trigger:** Open a digitally signed PDF and insert a page or otherwise modify
  its underlying PDF graph.
- **Original behavior:** The save guard threw `SignedDocumentEditError` to avoid
  silently invalidating the signature; autosave reused that export path and
  therefore failed to persist the edited graph.
- **Fix and verification:** Recovery stores a source-bound graph snapshot while
  retaining the original bytes. Protected snapshots and overlays are encrypted
  together with the non-empty unlock password; no password or PDF file key is
  stored in the snapshot. Chrome tests using synthetic signature markers covered
  insertion, reload, protected recovery, wrong-password preservation, corrupt
  draft preservation, rejected download, subsequent undo and explicit discard.
  Snapshot tests also check source mismatch and unchanged original bytes.
- **Evidence:** [save-pipeline.ts](src/engine/writer/save-pipeline.ts) and the
  autosave and close handlers in [page.tsx](src/app/editor/page.tsx).
- **Limits:** The autosave debounce leaves a short crash window, and undo history
  from before reload is not retained. Empty-password protected documents cannot
  use protected automatic recovery; cross-tab conflicts require manual handling.

## Static persona code review additions (2026-10-30)

These entries come from the static review in
[docs/CODE_REVIEW_2026-10-30.md](docs/CODE_REVIEW_2026-10-30.md). They use the
reserved range BUG-101 onward to avoid collisions with concurrent additions
above. The original findings were source reviews; subsequent reproductions and
fixes are recorded with each status. Line numbers may drift as code is edited.

### BUG-101: Stray delimiters can stop the object parser from advancing

- **Status:** Fixed; bounded subprocess tests cover stray delimiters in object
  dictionaries, arrays and content streams.
- **Priority:** P1 (a damaged or crafted PDF can hang parsing).
- **Trigger:** A dictionary or array containing a stray `)`, `{` or `}`.
- **Original behavior:** These characters are delimiters, but `nextToken` had no branch
  for them, so `readKeyword` returns an empty keyword without consuming input.
  The dictionary loop then `continue`s at the same position, and the array loop
  rewinds and retries. With no worker timeout, the parse may never return.
- **Evidence:** [lexer.ts:67](src/engine/parser/lexer.ts#L67),
  [lexer.ts:211](src/engine/parser/lexer.ts#L211),
  [lexer.ts:425](src/engine/parser/lexer.ts#L425),
  [parser.ts:302](src/engine/parser/parser.ts#L302),
  [parser.ts:333](src/engine/parser/parser.ts#L333).
- **Acceptance:** Every token consumes at least one byte or ends parsing;
  fixtures with each stray delimiter in dictionaries, arrays and content
  streams open, fail clearly or recover within a bounded time.

### BUG-102: Streams with an indirect length are cut at the first endstream

- **Status:** Fixed for tested direct and chained indirect lengths, including
  lengths in object streams. Twelve regression tests cover binary data, embedded
  markers and invalid or cyclic references; Poppler confirms saved rendering.
- **Priority:** P1 (possible corruption of unedited content).
- **Trigger:** A stream whose `/Length` is an indirect reference, especially
  one whose data contains the text `endstream` or ends in CR or LF bytes.
- **Actual:** Only a direct numeric `/Length` is used. Otherwise the reader
  takes data up to the first `endstream` and trims every trailing CR and LF,
  not just the single end-of-line marker. Whether each save mode writes the
  shortened bytes back has not been checked.
- **Evidence:** [parser.ts:366](src/engine/parser/parser.ts#L366),
  [parser.ts:415](src/engine/parser/parser.ts#L415).
- **Acceptance:** Resolve indirect lengths; trim at most one EOL; a parse, save
  and reopen of such fixtures preserves the raw stream bytes exactly.

### BUG-103: Cross-reference entries are written as 21 bytes

- **Status:** Fixed. Full and incremental saves now write 20-byte entries;
  boundary tests and independent pdfinfo and pdf-lib reads pass. qpdf was not
  available for its additional structural check.
- **Priority:** P2.
- **Trigger:** Any full or incremental save.
- **Actual:** Each entry ends in space, CR and LF because lines ending in
  `" \r"` are joined with `"\n"`. ISO 32000 requires exactly 20 bytes per entry.
  Strict readers may rebuild the table or flag the revision.
- **Evidence:** [serializer.ts:260](src/engine/writer/serializer.ts#L260),
  [incremental-writer.ts:301](src/engine/writer/incremental-writer.ts#L301).
- **Acceptance:** Every written entry is 20 bytes; saved fixtures pass an
  independent structural check such as `qpdf --check`.

### BUG-104: Literal strings above U+00FF become invalid octal escapes

- **Status:** Fixed for tested text entry points. Unicode metadata, signatures
  and annotations round-trip as text while binary strings retain byte semantics;
  independent pdfinfo and pdf-lib reads and regression tests pass.
- **Priority:** P2.
- **Trigger:** Writing a `PDFString` containing characters above U+00FF, such
  as a non-Latin certificate name, link text or annotation contents.
- **Actual:** Each UTF-16 code unit above 0x7E is written as a backslash plus
  its octal value. Values above 0o377 produce four or more digits, which
  readers decode as a different byte followed by stray digits.
- **Evidence:** [stream-compiler.ts:225](src/engine/editor/stream-compiler.ts#L225).
- **Acceptance:** Text strings are written as PDFDocEncoding or UTF-16BE with a
  byte-order mark; reopened fixtures return the original Unicode text.

### BUG-105: The Form XObject recursion guard never activates

- **Status:** Fixed in the renderer; tests exercise self-reference, mutual
  reference, excessive acyclic depth and repeated independent placements.
- **Priority:** P1 (a crafted PDF can exhaust the renderer).
- **Trigger:** A Form XObject that draws itself directly or through another form.
- **Original behavior:** The guard keyed on an `ObjNum` dictionary entry that no code sets,
  so the identifier is always 0 and is never recorded.
- **Evidence:** [renderer.ts:1466](src/engine/render/renderer.ts#L1466); a
  search of non-test sources finds no other use of `'ObjNum'`.
- **Acceptance:** Self-referencing and mutually referencing forms render with
  the cycle skipped and a bounded nesting depth.

### BUG-106: Negative DER lengths make signature parsing loop

- **Status:** Fixed; bounded subprocess tests cover malformed lengths, enclosing
  bounds and excessive DER nesting.
- **Priority:** P2 (user-triggered by validation or certificate import).
- **Trigger:** A DER structure whose four-byte length has the top bit set.
- **Original behavior:** The length was accumulated with signed shifts and became negative.
  A child node then reports zero length, so its constructed parent never
  advances and keeps adding children.
- **Evidence:** [signature-verify.ts:47](src/engine/signatures/crypto/signature-verify.ts#L47),
  [signature-verify.ts:80](src/engine/signatures/crypto/signature-verify.ts#L80).
- **Acceptance:** Malformed lengths, lengths beyond the buffer and excessive
  nesting are rejected with an error.

### BUG-107: Security actions can encrypt with built-in passwords

- **Status:** Fixed for new policy and encryption operations. A non-empty owner
  password is required; confidential and archive policies also require an open
  password. Tests exercise the policy, API and input validation. Old custom
  policy passwords already in local storage are ignored but not automatically
  removed; users must remove that historical data themselves.
- **Priority:** P1 (protection may be much weaker than the user expects).
- **Trigger:** Apply the Confidential policy, or encrypt with both password
  fields empty.
- **Actual:** The policy uses user password `confidential` and owner password
  `owner`; encryption falls back to owner password `owner`. A small note admits
  sample passwords, but the action reports success.
- **Evidence:** [policy-engine.ts:56](src/engine/security/policy/policy-engine.ts#L56),
  [SecurityPanel.tsx:228](src/app/editor/components/SecurityPanel.tsx#L228),
  [SecurityPanel.tsx:344](src/app/editor/components/SecurityPanel.tsx#L344).
- **Acceptance:** Encryption cannot complete with a built-in password; a missing
  owner password is generated randomly or required explicitly.

### BUG-108: Drawing, highlighting and erasing ignore touch drags

- **Status:** Fixed for tested simulated touch, pen and mouse gestures; real
  iOS and Android device checks remain outstanding. Drawing mode disables
  page-area touch scrolling and pinch zoom; switch tools or scroll from the
  margins.
- **Device follow-up:** No connected Android device was listed by `adb`; Apple
  device tooling was unavailable. This is not a test of touch behavior and does
  not change the finding's status.
- **Priority:** P2.
- **Trigger:** Use Draw, Highlight or Erase with a finger on a phone or tablet.
- **Original behavior:** The canvas container handled only mouse events, so
  touch drags did not reliably draw. Pointer capture now tracks gestures.
- **Verification:** Component tests cover touch, pen, mouse and cancellation.
  Mobile Chrome simulated touch drawing, highlighting and erasing; pdf-lib
  verified saved annotations, including a rotated and cropped fixture.
- **Evidence:** [page.tsx:5681](src/app/editor/page.tsx#L5681),
  [page.tsx:5609](src/app/editor/page.tsx#L5609).
- **Acceptance:** Pointer-event drawing works with touch, pen and mouse on real
  devices, without breaking scrolling for other tools.

### BUG-109: Floating overlays have no page identity

- **Status:** Fixed for tested text and image flows. Overlays track page identity
  and grouped saves preserve it; a delayed-edit conflict is checked before
  publishing. Recovery was checked for two-page text and images; legacy items
  without page identity require explicit assignment. Real delayed UI integration
  requires further checks.
- **Reproduction and verification:** Chrome reproduced text moving from page 1
  to page 2 after search navigation before the fix. After the fix, text and
  images stayed on their original pages after search and save; page reorder and
  undo/redo were also checked with independent PDF text/image extraction.
- **Priority:** P2 (P1 if reproduced).
- **Trigger:** Create a floating text box, image or drawing, then change page
  through a path that does not commit overlays first.
- **Actual:** These overlay types have no page field, and the commit uses the
  current page. The review found the commit-before-leaving sequence copied in
  several places and not used by every navigation path.
- **Evidence:** [types.ts:38](src/app/editor/types.ts#L38),
  [types.ts:52](src/app/editor/types.ts#L52),
  [types.ts:68](src/app/editor/types.ts#L68),
  [page.tsx:3193](src/app/editor/page.tsx#L3193).
- **Acceptance:** Each overlay records its page and renders only there; every
  navigation path commits or preserves overlays on their original page.

## Review limits

The original review did not run unit tests, the build, or browser/PDF reader
reproductions. Later verification is recorded on the relevant entry. This is a
bounded register, not an exhaustive list of defects.

### BUG-110: Attachment cleanup misses associated and directly embedded files

- **Status:** Fixed for the tested standard attachment paths. Cleanup rejects
  unresolved references and shared attachment data or file specifications before
  mutation, and successful removal requires a full rewrite.
- **Trigger:** Sanitize or remove attachments from a document with associated
  files (`/AF`), indirect name-tree arrays, or direct FileAttachment annotations.
- **Original behavior:** Cleanup only followed a subset of attachment names and
  annotations, leaving some attachment streams reachable in saved output.
- **Verification:** Save/reopen tests cover the affected paths and shared objects.
  Independent reproductions of multiple `/EF` streams, mismatched name-tree
  keys and shared file specifications are rejected without changing the PDF.
  Independent copies in other representations are not exhaustively identified.
  Single-file removal now handles tested `/AF`-only references and aliases;
  ambiguous same-name files, shared retained objects and unsupported `/RF`
  related files are rejected before mutation.

### BUG-111: Sanitizing hidden layers can reveal their content

- **Status:** Partly fixed. A restricted isolated hidden-text layer can be
  removed with a full rewrite; other optional-content structures are rejected
  before mutation rather than exposed.
- **Trigger:** Sanitize a PDF with optional-content layers enabled for cleanup.
- **Original behavior:** Layer configuration was removed while marked content
  remained in page streams, potentially making hidden content visible.
- **Verification:** Saved/reopened supported fixtures remove the hidden text
  while retaining visible pixels; pdf-lib, pdftotext and Poppler were used for
  uncompressed and Flate-compressed streams, including tested nested page
  trees and inherited resources. Tested hexadecimal `Tj` strings include PDF
  whitespace and odd-nibble padding; qpdf and Poppler checked saved output,
  extraction and visible pixels. Other filters and complex layer structures
  remain unsupported.
  Tests also cover refusal without mutation and preservation when disabled.
  Retained non-empty Info text is rejected when metadata cleanup is disabled;
  arbitrary reordered or transformed semantic copies cannot be ruled out.

### BUG-112: Sanitization skips directly embedded comments

- **Status:** Fixed for tested direct and indirect annotations; malformed or
  shared annotation data is rejected before modifying the document.
- **Trigger:** Remove comments or annotations when an `/Annots` array contains
  direct annotation dictionaries.
- **Original behavior:** Direct annotation dictionaries were skipped.
- **Verification:** Save/reopen tests cover direct comments, retained unrelated
  annotations, shared references, and failure without partial changes.

### BUG-113: Invalid metadata can be reported as removed during sanitization

- **Status:** False-success path blocked for tested malformed or chained XMP and
  malformed Info dictionaries. Valid XMP removal remains supported.
- **Trigger:** Sanitize malformed or unresolved metadata references.
- **Original behavior:** Cleanup could report metadata removed despite being
  unable to safely resolve its structure.
- **Verification:** Tests exercise rejection before mutation and valid metadata
  removal. Wider malformed-PDF cases are not exhaustively established.

### BUG-114: The PDF worker build guard accepts unrelated marker text

- **Status:** Fixed for tested webpack exports. The guard resolves the worker
  referenced by the editor and exercises its protocol in a Node VM.
- **Trigger:** An output file contains the old worker marker strings but is not
  the executable worker referenced by the editor.
- **Original behavior:** The guard could report success based on those strings
  alone, even when no usable worker was emitted.
- **Verification:** Negative fixtures reject fake and disconnected chunks; the
  worker smoke test parses, saves, optimizes and reopens a synthetic PDF. The
  VM check does not replace execution in a real browser.

### BUG-115: Encryption failure can leave a document partially modified

- **Status:** Fixed for tested password, policy and certificate encryption paths.
  Work is staged and published only after successful encryption and a concurrency
  check.
- **Trigger:** A secure random provider works initially but fails during a later
  encryption call, after the document or its security policy has begun changing.
- **Original behavior:** Encryption could throw while leaving an `/Encrypt`
  entry and partially modified objects in the original document.
- **Verification:** Fault-injection tests fail multiple random calls and verify
  the original graph is unchanged; successful encrypted files save and reopen.

### BUG-116: Certificate-encrypted PDFs can fail to reopen

- **Status:** Fixed for the tested engine-generated certificate fixture.
- **Trigger:** Save and reopen a certificate-encrypted PDF with its private key.
- **Original behavior:** The encryption dictionary reference was not retained
  on reopen, so the decryption path could try to decrypt that dictionary itself.
- **Verification:** A real test certificate encrypts, saves, reopens and decrypts
  using the engine. Independent reader interoperability remains unverified.

### BUG-117: Incremental save can append plaintext to an encrypted PDF

- **Status:** Fixed by rejecting incremental writes for protected documents;
  removing encryption requires a full rewrite. Ordinary encrypted full saves
  remain supported.
- **Trigger:** Open an encrypted PDF, then call an incremental save, signing or
  DSS path after its contents have been decrypted in memory.
- **Original behavior:** New objects could be appended as plaintext and the new
  trailer could omit `/Encrypt`; removing protection could also leave encrypted
  old revisions in an incremental output.
- **Verification:** AES fixture tests verify rejection before mutation and
  full-save/decrypt reopening; pdfinfo independently opens the saved fixtures.
  Encrypted incremental updates themselves remain unsupported.

### BUG-118: Security policies apply unrequested layer and image cleanup

- **Status:** Fixed for tested policy cleanup paths. Only Sanitized Export asks
  to remove optional layers and alternate images; other policies preserve them.
- **Trigger:** Apply a policy such as Internal Use to a PDF with optional content.
- **Original behavior:** Unspecified cleanup options defaulted to enabled, so a
  policy requesting JavaScript removal also attempted unrelated cleanup. After
  the hidden-layer safety guard, that caused such policies to fail unnecessarily.
- **Verification:** A regression fixture reproduces the failure without the fix;
  with the fix JavaScript is removed and optional content survives save/reopen.

### BUG-119: Timestamp responses can be embedded without integrity checks

- **Status:** Fixed in the high-level signing flow. Response imprint, nonce,
  CMS signature, signed attributes and TSA certificate purpose/time are checked
  before embedding. Certificate-chain trust and revocation remain unverified.
- **Trigger:** A timestamp service returns a successful but altered or unrelated
  response to a signing request.
- **Original behavior:** A successful response could be embedded without binding
  it to the request or verifying its signature.
- **Verification:** Real OpenSSL TSA fixtures and tampered responses exercise
  request binding and signature checks. An online TSA and independent PDF
  validator have not been tested. The low-level CMS builder accepts raw tokens
  and requires callers to validate them themselves.

### BUG-120: Certificate import advises exporting private keys without protection

- **Status:** Unsafe advice removed. Tested password-authenticated PBES2 AES-CBC
  P12/PFX identities can be imported; unsupported legacy or unprotected files
  are rejected rather than returning an incomplete identity.
- **Trigger:** Import an encrypted P12/PFX or view the certificate import help.
- **Original behavior:** The interface and error messages advised exporting an
  unencrypted private key. Some encrypted key bags could also be skipped.
- **Verification:** OpenSSL-generated synthetic P12 files cover RSA and EC keys,
  incorrect passwords, tampering, MAC and key-derivation limits, and mismatched
  keys. Chrome imported and signed using a synthetic P12 in both development
  and subpath static builds; pdfsig verified the signed outputs. The self-signed
  test certificate was not trusted, and chain
  trust and revocation are not established by this test.

### BUG-121: Cyclic page trees and revision chains are not rejected safely

- **Status:** Fixed for tested page-tree, indirect-reference and `/Prev` cycles;
  revision traversal has an explicit limit of 10,000 entries.
- **Trigger:** Open a PDF whose page tree or indirect references form a cycle,
  or inspect a cyclic or excessively long incremental revision chain.
- **Original behavior:** Some page-tree and reference cycles overflowed the
  stack; revision-chain cycles could be silently truncated.
- **Verification:** Bounded subprocess tests cover direct and mutual cycles,
  duplicate nodes, long valid trees, overlong revision chains and normal
  incremental revisions. Other allocation and worker bounds remain open.

### BUG-122: CID font rendering can ignore PDF width metrics

- **Status:** Fixed for tested CIDToGIDMap, `/W`, `/DW`, and character-to-CID
  mappings. The PDF's CID widths control advance; glyph mapping does not replace
  them with embedded-font widths.
- **Trigger:** Render a CID font whose embedded glyph widths differ from the
  document's `/W` or `/DW` widths, or whose character code differs from its CID.
- **Original behavior:** Font or unrelated character widths could override the
  specified CID width, producing incorrect text placement.
- **Verification:** Unit and saved/reopened PDF fixtures cover explicit and
  default widths. Poppler `pdftotext -bbox` independently measured the expected
  12-point advance for the test fixture.

### BUG-123: Oversized PDF images can request unbounded pixel buffers

- **Status:** Fixed for tested raw images, soft masks and JPEG decoding. Image
  dimensions are limited before pixel allocation; JPEG headers are checked
  before browser decoding and decoded dimensions are checked again.
- **Trigger:** Open a PDF with excessive image dimensions or a JPEG whose actual
  dimensions exceed its PDF image dictionary.
- **Original behavior:** Pixel buffers could be allocated from untrusted sizes
  without an explicit bound, potentially exhausting memory.
- **Verification:** Tests cover oversized declarations and JPEG frame types,
  malformed streams, and ordinary baseline/progressive JPEGs. Rare DNL and
  hierarchical JPEGs are rejected; decompression and other canvas allocations
  still need separate limits.

### BUG-124: Page extraction can drop protection or include unselected pages

- **Status:** Fixed for tested protected extraction and page references.
  Extracted pages preserve supported password protection; unsupported security,
  signed PDFs and references to unselected pages are rejected.
- **Trigger:** Extract a page from a password-protected document, or from a page
  that refers to another page that was not selected.
- **Original behavior:** Extraction could produce an unprotected copy or carry
  unselected page objects into the output.
- **Verification:** AES-128, AES-256 and RC4 fixture tests cover password handling;
  browser extraction and Poppler verify a protected output. Tests cover page
  references and retained form structures. Independent copies in attachments or
  other selected content are not covered by this check.

### BUG-125: PDF stream filters can expand without a size limit

- **Status:** Fixed for tested filter and predictor paths. Each decoding stage is
  limited to 128 MiB and raises an error rather than returning compressed data.
- **Trigger:** Open a PDF with a compressed stream or predictor parameters that
  expand to an excessive amount of data.
- **Original behavior:** Decoding could allocate memory without an explicit
  output bound.
- **Verification:** Tests cover native and manual Flate, LZW, RunLength, ASCII
  filters, chains, predictors and xref streams. Aggregate memory across multiple
  streams and other canvas allocations are not yet bounded.

### BUG-126: Failed decryption can leave partially decrypted objects in memory

- **Status:** Fixed for tested document decryption paths. Changes are staged and
  committed only after all objects have been decrypted successfully.
- **Trigger:** Decryption fails partway through, including when a decrypted
  stream exceeds a decoding limit.
- **Original behavior:** Earlier objects could remain changed after the error.
- **Verification:** Fault tests compare document snapshots before and after
  failure and verify a normal encrypted file can be opened, saved and reopened.

### BUG-127: Edited files can retain unverified PDF/A or PDF/UA claims

- **Status:** Mitigated for tested editor paths. Editing a document with a
  detectable claim shows a warning; unreadable metadata is reported as unknown.
  The Pages drawer repeats the visible warning before its download actions.
- **Trigger:** Edit and save a PDF containing PDF/A or PDF/UA XMP declarations.
- **Original behavior:** The application could preserve the declaration without
  warning that edits might invalidate it.
- **Verification:** Synthetic XMP fixtures, including compressed metadata, were
  tested; Chrome showed the warning after editing on desktop and mobile and in
  the mobile Pages drawer. Compliance is not validated, and warning coverage
  depends on each edit path setting the dirty state; assistive-technology testing
  and an actual conforming PDF remain outstanding.

### BUG-128: Failed or hung PDF workers can leave requests pending or rerun them on the UI thread

- **Status:** Fixed for tested worker failure, timeout and invalid-message paths.
  Failed workers are terminated, pending requests reject, and a later request
  can create a new worker. Direct execution remains when the Worker API is absent.
- **Trigger:** A worker crashes, hangs or returns an invalid response.
- **Original behavior:** Requests had no timeout and worker failures could cause
  the same operation to run again on the main thread.
- **Verification:** Fault-injection tests cover timeouts, crashes, invalid
  messages, concurrent requests and worker replacement. A real browser crash
  was not simulated.

### BUG-129: Unsupported compressed images can render as pixel noise

- **Status:** Fixed for tested CCITT, JBIG2, JPEG 2000 and unknown image filters.
  A labelled placeholder is drawn while the original encoded stream is kept.
- **Trigger:** Render a PDF image whose compression filter is not implemented.
- **Original behavior:** Encoded bytes could be interpreted as raw pixels,
  producing misleading image noise.
- **Verification:** Decoder and rendering tests cover the named formats, encoded
  masks and undecoded/indirect filters. Saved output retains the stream bytes and
  opens with an independent PDF library. Chrome verified a CCITT XObject
  placeholder and ordinary inline-image pixels. Inline formats without a
  verifiable boundary are rejected rather than displayed.

### BUG-130: Inline image data can contain an ambiguous end marker

- **Status:** Fixed for tested supported filters. Flate, JPEG, ASCII85,
  ASCIIHex and RunLength use verified format terminators; inline filters without
  a provable boundary and malformed data are rejected before interpretation.
- **Trigger:** Open a filtered inline image whose data includes a whitespace-
  delimited `EI` sequence that is not the actual image terminator.
- **Original behavior:** The lexer could end the image early and interpret the
  remaining bytes as page instructions.
- **Verification:** Regression fixtures include a fake `EI` followed by drawing
  operators. Chrome showed the correct image and unchanged surrounding pixels;
  unsupported inline CCITT was rejected, and saved source bytes were preserved.
  Inline CCITT, JPEG 2000, JBIG2 and LZW are not supported.

### BUG-131: Concurrent saves can replace newer document bytes with an older snapshot

- **Status:** Fixed for tested worker and direct quick/optimized save entry points.
  Quick saves for one document are serialized, and an obsolete snapshot is
  rejected before publication. Independent documents can still save concurrently.
- **Trigger:** Start overlapping saves on the same document and deliver worker
  results out of order, or modify the document while a save is in flight.
- **Original behavior:** A later-arriving old response could overwrite
  `doc.rawBytes`, leaving memory and the latest saved bytes inconsistent.
- **Verification:** Tests use real worker command handlers with delayed responses,
  mixed entry points, failures and subsequent saves. Snapshot creation raises
  peak memory usage for large documents; its performance remains unmeasured.

### BUG-132: Form edits create per-keystroke history and can lose draft input

- **Status:** Fixed for tested text and single-choice form paths. Drafts commit
  on blur, Enter or navigation as one history entry and are included in local
  recovery; protected recovery encrypts the draft.
- **Trigger:** Edit a form field, navigate away, reload, or undo after typing.
- **Original behavior:** Each keystroke was committed separately, while changing
  commit timing without retaining a recovery draft could lose unsaved input.
- **Verification:** Chrome tested refresh, field/page navigation, undo and
  download for ordinary and password-protected documents. A real signed fixture
  retained its original bytes while the draft recovered separately. Multi-select
  fields remain unsupported and real IME-device testing is outstanding.

### BUG-133: Composition input and rapid button toggles can be handled incorrectly

- **Status:** Fixed for tested IME state and checkbox/radio interactions.
- **Trigger:** Press Enter while an IME composition is active, unmount a field
  during composition, or toggle a checkbox twice while the first write is pending.
- **Original behavior:** Composition could submit prematurely or leave submission
  stuck; rapid toggles could both use the old field state.
- **Verification:** Component and engine regressions cover composition lifecycle,
  pending toggles, read-only widgets and radio behavior. No real IME device was
  available for verification.

### BUG-134: Page and offscreen canvases can be allocated without size limits

- **Status:** Fixed for tested page, selected-image preview, transparency-group
  and soft-mask canvases. Each checked canvas is limited to 32,767 pixels per
  side and 32 million pixels in total before allocating its backing store.
- **Trigger:** Open or render a document with extreme page dimensions, zoom or
  device-pixel ratio, or oversized transparency/soft-mask bounds.
- **Original behavior:** Untrusted geometry could trigger excessive canvas
  allocation before an error was reported.
- **Verification:** Allocation-spy tests cover oversized and ordinary rendering,
  previews, masks and transparency groups. Aggregate memory across canvases and
  other editing/signature canvas paths are not yet bounded.

### BUG-135: The static app cannot reopen its editor offline

- **Status:** Fixed for the tested subpath static build after its first online
  visit. A service worker caches the versioned application shell and bundled
  fonts, while leaving selected PDFs and arbitrary requests out of its cache.
- **Trigger:** Disconnect after a first online visit, then reload and open a PDF.
- **Original behavior:** The application had no manifest or service worker and
  its editor assets were unavailable offline.
- **Verification:** In isolated Chrome, a subpath build installed its cache,
  reloaded with network emulation offline, opened and rotated a synthetic PDF,
  restored the edit after an offline editor reload, and downloaded an independently
  checked output. Cache inspection found no PDF entries. Installation prompts,
  other browsers are unverified. A later cold offline Chrome test also verified
  OCR with the bundled English model ([BUG-231](#bug-231-ocr-cannot-initialize-offline)).

### BUG-136: Multiple-choice form fields cannot be edited

- **Status:** Fixed for tested list-box multi-selection paths. Values and option
  indices are saved, an appearance is generated, and encrypted drafts remain
  protected in local recovery.
- **Trigger:** Select multiple options in a PDF choice field and save or recover.
- **Original behavior:** Multi-select controls were disabled to avoid replacing
  an array of values with a single string.
- **Verification:** Chrome exercised selection, reload, undo/redo and download;
  pdf-lib read the saved values and Poppler confirmed encryption was retained.
  Ambiguous or unsupported field configurations are rejected.

### BUG-137: Default-hidden PDF layers can appear or be edited

- **Status:** Fixed for tested default ON/OFF configurations, nested marked
  content, optional-content membership and visibility expressions. Rendering,
  search, replacement, text export, editing and visible form fields use the
  same document context.
- **Trigger:** Open or edit a PDF whose optional-content layer is hidden by its
  default View configuration.
- **Original behavior:** The layer state was ignored, so its content could be
  drawn or included in editing and search results.
- **Verification:** Synthetic saved/reopened PDFs, real canvas rendering and
  Poppler pixel comparisons cover hidden content, forms and annotations. Some
  View usage rules and hidden soft-mask groups remain unsupported and explicitly
  fail instead of displaying content with an unverified state.

### BUG-138: Hidden or no-view annotations can appear and be edited

- **Status:** Fixed for tested standard annotations and form widgets. Hidden and
  NoView annotations are excluded from display and form hit testing while their
  PDF objects remain intact; Invisible is handled according to annotation type.
- **Trigger:** Open a PDF whose annotation or widget uses Hidden or NoView flags.
- **Original behavior:** Flagged annotations could be displayed and widgets
  could be selected for editing.
- **Verification:** Direct and indirect flag fixtures, saved/reopened widgets and
  regular annotation rendering were tested. Pixel output was independently
  compared with Poppler for normal, Hidden, NoView and Invisible flags.

### BUG-139: XMP metadata can lose Unicode text on save

- **Status:** Fixed for tested UTF-8 and UTF-16 metadata. Unsupported declared
  encodings and invalid Unicode are rejected before modifying the document.
- **Trigger:** Set XMP containing non-Latin characters or emoji, then save.
- **Original behavior:** XML was converted as a PDF byte string and characters
  outside the byte range could be truncated.
- **Verification:** Save/reopen fixtures cover Chinese, accented text, emoji,
  UTF-16 byte order and declared encodings; pdf-lib independently opens the
  results. Automatic ModDate/Producer/XMP synchronization remains open.

### BUG-140: Reusable visual signatures are stored without application encryption

- **Status:** Partly fixed. New signatures default to session-only storage;
  device persistence is an explicit choice and failures are reported. Existing
  device entries remain unencrypted, separate from protected PDF recovery.
- **Trigger:** Save a drawn, typed or uploaded signature to the reusable library.
- **Original behavior:** Images and optional typed text were written to
  localStorage without an explicit choice; storage failures were suppressed.
- **Verification:** Tests cover session/device choices and storage failures.
  Chrome verified protected-document recovery, signature movement and deletion;
  real digitally signed PDF browser recovery has not been checked.
- **Evidence:** [library.ts](src/engine/signatures/visual/library.ts) and
  [SECURITY_PRIVACY.md](docs/SECURITY_PRIVACY.md).
- **Acceptance:** Offer a clear storage choice and report persistence failures;
  any encryption or migration must preserve existing entries and explain key
  recovery and deletion limits.

### BUG-141: Signature protection can miss legal PDF string formatting

- **Status:** Fixed for tested raw-byte and parsed-document signature paths.
  Signed documents are preserved or rejected before destructive cleanup.
- **Trigger:** A valid signature stores its `/Contents` hexadecimal string with
  whitespace, or a signature exists in the parsed graph without raw bytes.
- **Original behavior:** A narrow raw-byte pattern could miss the signature,
  allowing a full rewrite or cleanup to proceed without the signature guard.
- **Verification:** A real self-signed PDF remained cryptographically valid after
  equal-length whitespace was inserted into the excluded signature padding;
  save and compression preserved bytes, while cleanup and extraction refused.
  Empty placeholders and nested signature dictionaries are also covered.

### BUG-142: Annotation appearances ignore their transformation matrix

- **Status:** Fixed for tested normal appearance streams. The appearance BBox is
  transformed by its matrix before mapping into the annotation rectangle, and
  drawing is clipped to the BBox.
- **Trigger:** Render an annotation whose appearance stream has a rotation,
  reflection, translation or shear matrix.
- **Original behavior:** When a BBox and Rect were present, the renderer mapped
  the untransformed BBox and ignored the appearance matrix, moving or distorting
  the displayed content.
- **Verification:** Synthetic annotation PDFs compare interior rendered pixels
  against Poppler for identity, rotation, reflection, shear/translation and a
  nonzero BBox origin with clipping. An overflow regression rejects geometry
  whose mapping would produce a non-finite scale. Other appearance-state and
  unsupported-annotation cases remain to be audited.

### BUG-143: Standalone metadata stripping can leave old metadata in the file

- **Status:** Fixed for the tested standalone strip and quick-save paths.
  Removing metadata requires a full rewrite; signed documents and unsafe
  metadata references are refused before removal.
- **Trigger:** Strip Info or XMP metadata, then save incrementally with explicit
  modified objects.
- **Original behavior:** The new document graph omitted the metadata, but the
  incremental output retained the original bytes in an earlier PDF revision.
- **Verification:** Strip-to-quick-save tests inspect saved bytes and reopen the
  PDF, and exercise signed, unresolved and shared metadata cases. Independent
  copies elsewhere in the document are not guaranteed to be detected. Shared
  direct and indirect descendants of catalog XMP also cause refusal.

### BUG-144: Deleting a page can retain its form widgets

- **Status:** Fixed for the tested field-tree and page-deletion cases. Shared
  fields retain widgets on surviving pages; ambiguous references are rejected.
- **Trigger:** Delete a page with an AcroForm widget, including an orphaned
  widget whose `/P` points at the deleted page but is absent from `/Annots`.
- **Original behavior:** The field tree could keep the widget and its reference
  to the deleted page, making that page reachable after saving.
- **Verification:** Tests inspect saved and reopened PDFs, shared multi-page
  fields, calculation-order cleanup, and rejection without mutation. pdf-lib
  independently reopened and edited surviving fields.

### BUG-145: Cross-reference streams can exhaust resources or truncate offsets

- **Status:** Fixed for the tested xref streams, revision chains and recovery
  paths, subject to explicit limits on declared entries and index ranges.
- **Trigger:** Open an xref stream with excessive entries or field widths,
  multiple large revisions, or an offset greater than 2 GiB.
- **Original behavior:** Zero-byte entries could allocate an unbounded map,
  and 32-bit arithmetic truncated large offsets. Recovery of many objects could
  also exceed JavaScript's function-argument limit.
- **Verification:** Bounded subprocess fixtures cover oversized declarations,
  cumulative revisions, range limits and recovery of 150,000 objects. Valid
  large offsets and ordinary multi-revision files have regression coverage.

### BUG-146: Page thumbnails omit form widget appearances

- **Status:** Fixed for tested existing text and button appearance
  streams. Missing or unrecognized appearance states are not synthesized.
- **Trigger:** Open a PDF with AcroForm widgets or edit a field shared by pages.
- **Original behavior:** The thumbnail renderer skipped all widgets, so form
  content was absent even when its appearance was present in the PDF.
- **Verification:** Poppler comparisons cover text and checkbox appearances;
  Chrome verified an edited shared field updates thumbnails on both pages. Main
  editor rendering continues to use its interactive form overlays.

### BUG-147: Annotation state appearances are not rendered

- **Status:** Fixed for tested normal appearance state dictionaries. A matching
  `/AS` selects the appearance; missing or unknown states are not guessed.
- **Trigger:** Render a non-widget annotation whose `/AP /N` is a dictionary of
  named appearance states rather than a single appearance stream.
- **Original behavior:** The renderer ignored the dictionary, leaving the
  annotation invisible even when a selected appearance was available.
- **Verification:** Direct on/off state fixtures match Poppler, and indirect
  dictionaries have engine-level regression coverage. This Poppler version
  displayed the indirect fixture blank, so that case lacks independent visual
  confirmation.

### BUG-148: Batch page deletion can partially modify a document

- **Status:** Fixed for tested batch validation, shared form fields, cyclic
  destination structures and shared annotation arrays.
- **Trigger:** Delete several pages with duplicate or invalid indices, remove
  every page, or encounter an unsafe outline or name tree during cleanup.
- **Original behavior:** Earlier pages or outline entries could be changed before
  a later failure; duplicate indices could also remove an unintended page. A
  shared annotation array could be deleted while still referenced.
- **Verification:** Tests check failure before mutation, shared fields after
  save/reopen, cyclic and over-deep outlines, and shared annotation arrays.
  pdf-lib independently reopened and edited a surviving shared field.

### BUG-149: CJK fonts named Regular contain Thin faces

- **Status:** Fixed for the bundled JP, KR and TC font assets. They are now
  static weight-400 instances from pinned official Noto CJK variable fonts.
- **Trigger:** Export Japanese, Korean or Traditional Chinese text using the
  bundled script font advertised as Regular.
- **Original behavior:** The three files' embedded PostScript names identified
  Thin faces despite their `Regular` filenames, leading to unexpectedly light
  glyphs. Their OS/2 weight field reported 400 and could conceal the mismatch.
- **Verification:** Font metadata tests initially failed for all three assets,
  then passed for the replacements. New character maps retain every character
  from the previous files; existing export tests and Poppler text extraction
  pass. Source hashes, license and generation steps are in `docs/FONTS.md`.

### BUG-150: Importing another certificate retains the previous signer

- **Status:** Fixed for tested file and PEM import flows: the imported identity
  becomes the certificate manager's selected identity.
- **Trigger:** Import a certificate while another identity is already selected.
- **Original behavior:** The dialog briefly selected the new entry locally, then
  refreshed from the manager, which still selected the previous identity. A user
  could continue signing with the previously selected certificate.
- **Verification:** Component regressions check selection after file and PEM
  imports. Chrome with two synthetic P12 identities confirmed the old signer
  was retained before the fix and the newly imported signer selected afterward.

### BUG-151: Encrypted PDFs with compressed page objects cannot open

- **Status:** Fixed for tested RC4-128, AES-128 and AES-256 documents whose
  catalog, pages or Info dictionaries are in encrypted object streams.
- **Trigger:** Open a protected PDF whose page tree is stored in an ObjStm.
- **Original behavior:** The parser tried to resolve the page tree before the
  password was available and could not read the encrypted object stream. Stream
  dictionary strings also did not round-trip through encryption correctly.
- **Verification:** qpdf and Poppler read the synthetic originals and resaved output;
  tests cover wrong passwords, malformed objects, string round-trips, rollback,
  shared Info detection, compressed indirect `/Length` dependencies and the
  cumulative object-stream decode limit. These fixtures do not establish support
  for all encrypted PDF structures.

### BUG-152: Invisible OCR text is painted on scanned pages

- **Status:** Fixed for tested PDF text rendering mode 3 in page and Form XObject
  rendering; invisible text remains available for extraction in tested page
  and nested Form paths. Form search still has clipping, reading-order and
  `/ActualText` geometry limitations. Annotation drawing uses the same no-paint
  guard but has not been separately verified here.
- **Trigger:** Open a scan with an invisible OCR text layer using `3 Tr`.
- **Original behavior:** The interpreter tracked the rendering mode but the
  canvas renderer ignored it, painting OCR text over the scanned page.
- **Verification:** A synthetic scan is saved and reopened, checked with
  Poppler for text extraction and compared over a white patch where OCR text
  must not paint. Tests cover all four text-showing operators, adjacent runs,
  nested mixed visible/invisible `/ActualText` and a Form XObject. Other text rendering and clipping modes
  have not been comprehensively verified.

### BUG-153: Component metadata can survive sanitization

- **Status:** Fixed for tested indirect component XMP streams. Cleanup removes
  these streams from pages and nested resources; direct or unresolved streams
  streams or their descendants also used as non-metadata content, and typed
  XMP streams reachable through other keys are rejected before mutation.
- **Trigger:** Request metadata cleanup for a page or nested resource with its
  own XMP metadata stream.
- **Original behavior:** Sanitization removed catalog XMP and the Info
  dictionary, then reported metadata removed while component metadata remained.
- **Verification:** Regression tests cover page and nested resource metadata,
  compressed streams, shared metadata references and descendants, unexpected
  reachable XMP streams, preserved shared content and real signed-document
  refusal. pdf-lib independently reopens saved output;
  direct and unresolved references remain unsupported.

### BUG-154: Incomplete page cache can hide content from cleanup

- **Status:** False-success path blocked for tested inconsistent page trees.
  Redaction, sanitization, and standalone JavaScript and attachment removal
  refuse before mutation if cached pages do not match the complete page tree.
- **Trigger:** A document's cached pages omit a real page carrying a redaction
  mark or content requiring sanitization.
- **Original behavior:** The operations inspected only cached pages and could
  report success while the saved file retained content on an omitted page.
- **Verification:** Two-page redaction and cleanup fixtures reproduced false
  success before the fix. Tests cover omitted pages, damaged page trees, normal
  operation, and unchanged documents after refusal.

### BUG-155: Certificate management loses keyboard focus after deletion

- **Status:** Fixed for the tested certificate-management dialog paths.
- **Trigger:** Select or delete an identity using only the keyboard.
- **Original behavior:** Identity selection was not keyboard focusable, and
  deleting the focused identity left focus on the dialog container.
- **Verification:** Component tests and Chrome with two synthetic identities
  cover keyboard selection, named deletion, focus moving to the next identity
  or import button, and focus returning to the opener on Escape. Native file
  picker and screen-reader behavior were not exercised.

### BUG-156: Form text search does not follow content-stream order

- **Status:** Fixed for tested page and nested Form text; Form clipping and
  geometric reading order remain open.
- **Trigger:** Search a page with text both before and after Form XObject calls.
- **Original behavior:** Search appended all Form text after the page's text,
  even when the Form was drawn between two page text operations.
- **Verification:** Tests cover interleaved, nested and repeated Forms and
  preserve page run indices. Poppler `pdftotext -raw` confirmed the tested
  stream order; Form matches remain read-only.

### BUG-157: Form page copy can lose alignment or unsupported form dependencies

- **Status:** Fixed for tested inherited `/Q` values. XFA, calculation order
  and field actions are rejected before mutation when they cannot be preserved.
- **Trigger:** Extract or merge fields whose alignment comes from an AcroForm or
  ancestor, or copy forms with document-wide dependencies and no name collision.
- **Original behavior:** Default alignment could be lost, and unsupported XFA,
  calculation order or actions could be silently dropped outside collision paths.
- **Verification:** Saved and reopened fixtures cover inherited precedence,
  no-collision refusal and unchanged documents. pdf-lib independently reads and
  edits the copied fields. Broader interactive-form compatibility remains open.

### BUG-158: Direct page extraction bypasses document protection

- **Status:** Fixed for tested public writer and session extraction paths.
- **Trigger:** Call the exported page extraction function on a signed or
  password-protected PDF rather than using the session workflow.
- **Original behavior:** The lower-level function could produce a new document
  with an invalid signature or without preserving the original protection.
- **Verification:** Real signed and AES-protected fixtures are rejected without
  changing the source. Session extraction retains password protection and
  rejects an incorrect password.

### BUG-159: Search exposes underlying Form text instead of ActualText

- **Status:** Fixed for tested closed, single-layer `/ActualText` spans across
  Form XObjects. Nested and unclosed spans are rejected; broader extraction
  geometry and clipping remain open.
- **Trigger:** Search for text in marked content whose `/ActualText` surrounds a
  Form invocation.
- **Original behavior:** Search indexed the underlying Form text and omitted the
  logical replacement text, unlike Poppler extraction.
- **Verification:** Poppler comparisons and search/replacement regressions cover
  mixed page and Form content, invisible layers, nesting, malformed spans, and
  preserving underlying text when an unrelated match is replaced. These Form
  matches remain read-only.

### BUG-160: Page insertion copies invalid source signatures

- **Status:** Fixed for tested page-insertion paths. Signed or encrypted source
  documents and locked or unauthenticated encrypted targets are rejected before
  mutation; signed targets and authenticated encrypted targets remain editable.
- **Trigger:** Insert pages from a signed PDF into another document.
- **Original behavior:** The copied field still appeared signed, although the
  original byte-range signature did not authenticate the resulting PDF.
- **Verification:** Real signed-source and signed-target fixtures test rejection
  or draft recovery as appropriate. AES-protected targets retain their password;
  locked and missing-key targets are rejected without modification.

### BUG-161: Search misses text spanning separate runs

- **Status:** Partly fixed. Search joins tested adjacent horizontal runs; a
  restricted equal-length Courier replacement is supported for page text.
  Form matches remain read-only. Tested unclipped rotated page runs can be
  searched, but their highlights and cross-run replacement remain unavailable;
  complex-glyph, explicit path-clipped and `/ActualText` boundaries are not
  generally joined.
- **Trigger:** Search for a word spanning adjacent runs, such as text drawn in
  two fonts or across page and Form XObject content.
- **Original behavior:** A query for the complete word returned no match even when
  Poppler extracts the adjacent text as a single word.
- **Verification:** Synthetic Courier/Courier-Bold and page/Form fixtures both
  reproduced the missing match; a same-font merged-run control found it. Safe
  searches now find the tested cross-run cases with checked highlights. Tests
  cover geometry gaps, Unicode matching, resource budgets and refusal before
  any unsafe Replace All write. Equal-length Courier replacements are verified
  through a session transaction, undo/redo, save/reopen, Poppler and Chrome.
  Cross-run replacement beyond that verified subset remains unsupported.
  The original 90-degree Courier/Courier-Bold fixture missed a cross-run match
  while Poppler extracted the word. Searches now find tested unclipped 30, 90,
  180 and 270 degree page runs; a clear message replaces the unreliable highlight.
  Cross-run replacement remains rejected, including mixed Replace All. More
  complex rotations, clipping, fonts and reliable highlights remain unverified.

### BUG-162: Text rendering ignores some valid clipping paths

- **Status:** Fixed for tested clipping paths and graphics-state transitions.
- **Trigger:** Render text that lies outside a clip or is substantially cut by it.
- **Original behavior:** The renderer skipped clips that did not intersect a
  text run or covered less than 85% of its width. Very small or zero-area
  constructed paths were also skipped, and different clip states could merge.
- **Evidence:** A synthetic Form fixture reproduced the original divergence
  from Poppler; [clipping.ts](src/engine/render/clipping.ts) now applies the
  recorded clip instead of those heuristics.
- **Acceptance:** Preserve PDF clipping semantics, including empty and partial
  clips, without reintroducing incorrectly inherited clipping. Compare saved and
  reopened fixtures with Poppler and existing producer regression cases.
- **Verification:** Poppler comparisons cover non-intersecting, partial, narrow,
  zero-area and W/W* path-ending cases. q/Q and ActualText regressions preserve
  separate drawing states; Word, Chrome and LibreOffice producer tests pass.
  A completely empty `W n` path was a no-op in the tested Poppler version.

### BUG-163: Form rendering ignores indirect Matrix and BBox arrays

- **Status:** Fixed for tested ordinary and nested Form XObjects and supported
  soft-mask groups; malformed geometry is rejected.
- **Trigger:** Render a Form XObject whose `/Matrix` or `/BBox` is an indirect
  array, as permitted by the PDF object model.
- **Original behavior:** The renderer read only direct arrays, substituting an
  identity matrix or empty bounding box and potentially moving or hiding the Form.
- **Evidence:** The former renderer used direct `getArray` access; the current
  [renderer](src/engine/render/renderer.ts) resolves bounded indirect values.
- **Acceptance:** Render direct and indirect arrays and their numeric entries
  consistently, verify transformed and clipped saved fixtures with Poppler,
  and explicitly handle malformed references.
- **Verification:** Direct and indirect arrays and numbers produce equivalent
  output in saved fixtures, including nested Forms; Poppler provides an
  independent pixel comparison. Supported soft-mask groups also have direct/
  indirect geometry comparisons. Cyclic, missing, over-deep and invalid references
  are rejected.

### BUG-164: Search highlights ignore page rotation and crop origin

- **Status:** Fixed for tested right-angle rotations and CropBox geometry.
- **Trigger:** Search on a rotated page or one with a non-default CropBox.
- **Original behavior:** The highlight used only MediaBox dimensions, so it
  could appear at a different location or size from the matching content.
- **Evidence:** On a 200×300 page rotated 90°, a PDF rectangle at (20,40) of
  size 30×10 was mapped to (20,250,30,10) instead of (40,20,10,30).
- **Acceptance:** Map and clip each highlight consistently with the rendered
  CropBox and rotation; verify all right-angle rotations and nonzero origins.
- **Verification:** Unit tests cover 0°, 90°, 180° and 270°, nonzero origins,
  cropped and out-of-bounds rectangles. Chrome verified a rotated, cropped page
  against actual rendered text pixels.

### BUG-165: Soft masks do not reliably limit painted content

- **Status:** Partly fixed. Tested isolated Alpha and Luminosity masks are
  composited without erasing the previously drawn page; unsupported mask
  configurations are rejected explicitly.
- **Trigger:** Render content with an `/SMask` transparency group.
- **Original behavior:** Mask intensity was stored as opaque RGB pixels, so
  `destination-in` could fail to mask content; applying it directly to the
  page canvas could also alter previously drawn background pixels.
- **Acceptance:** Compare alpha and luminosity masks, transparency and existing
  backgrounds with Poppler; unsupported mask variants must fail explicitly.
- **Verification:** Poppler comparisons cover Alpha, Luminosity, RGB, opacity,
  page backgrounds, scale, rotation and indirect Form geometry. Transfer
  functions, backdrop, non-isolated or nested masks, masked Forms and shading,
  and masks established under a non-identity CTM remain unsupported.
  Direct and indirect `/SMask /None` transitions, including q/Q restoration,
  have Poppler pixel regressions, including closing a mask under a transformed
  graphics state; unresolved or cyclic values are rejected.

### BUG-166: Text clipping modes are rendered without the requested clip

- **Status:** Partly fixed. Modes 4–7 support a verified subset of embedded
  simple TrueType glyphs; unsupported fonts and ambiguous outlines are rejected.
- **Trigger:** Render text using PDF text rendering modes 4–7 followed by paint.
- **Original behavior:** The canvas renderer did not apply the text's glyph
  outlines as a clipping path; mode 7 could also paint text that should only clip.
- **Verification:** Saved and reopened fixtures for modes 4–7 match Poppler
  in tested glyph shapes, rotations, nested Forms and `q/Q` transitions. Tests
  cover `/ActualText`, text extraction and rejection of malformed fonts,
  composite glyphs and ambiguous overlaps. Full PDF font support remains open.
- **Acceptance:** Match the PDF glyph clip, or explicitly reject unsupported
  rendering without losing text extraction and search.

### BUG-167: A failed page render can leave the previous page visible

- **Status:** Fixed for tested render failure and concurrent page-switch paths.
- **Trigger:** Navigate to a page whose rendering fails after another page has
  already rendered.
- **Original behavior:** The error path reported the failure but retained the
  previous canvas and render state, risking a misleading page or stale editing.
- **Acceptance:** Clear or disable stale visual and editing state for the failed
  page while keeping navigation and text search available; verify failure and
  concurrent page-switch cases.
- **Verification:** Chrome regressions cover a failed second page after an
  unsaved edit, retry after an in-progress text draft, and a late failure from
  an old page. The original edit and draft remain recoverable.

### BUG-168: Text stroke rendering modes are drawn as fills

- **Status:** Partly fixed. Tested `Tr 1/2` text uses its stroke and fill
  graphics state; unsupported transformations, Type3 glyphs and hairlines are
  rejected rather than silently painted incorrectly.
- **Trigger:** Render text using `Tr 1` (stroke) or `Tr 2` (fill and stroke).
- **Original behavior:** The canvas output did not apply the requested stroke.
- **Verification:** An independent Courier fixture with 4-point line width
  produced the same dark-pixel count for modes 0, 1 and 2 in Paperloom; Poppler
  produced substantially more dark pixels for the stroked modes.
- **Acceptance:** Preserve fill/stroke behavior, line width, transforms and
  clipping for both modes, with independent-reader regression tests.
- **Verification:** Poppler comparisons exercise colors, opacity, width,
  rotation and clipping; Word, Chrome and LibreOffice producer regressions pass.
  A `0 w` hairline remains unsupported after a measured rendering discrepancy.

### BUG-169: Image-heavy search falls back to a synchronous full scan

- **Status:** Partly fixed. Text-only search no longer computes image-edit
  fingerprints, including for images nested in Forms. Search can now yield and
  cache when a large graph has a bounded, verifiable set of read streams;
  graphs exceeding the structure or dependency budgets still use a synchronous
  uncached scan, and unverifiable custom object shapes are rejected.
- **Trigger:** Search a document whose graph exceeds the 8 MiB snapshot budget,
  such as a multi-page scanned PDF with separate embedded images.
- **Original behavior:** The search index disabled caching and intermediate
  yields on over-budget graphs to avoid publishing stale results. A local Node
  20 measurement with 40 synthetic scan-image pages delayed a queued timer by
  59.9 ms; this was not a browser measurement or a general latency guarantee.
- **Acceptance:** Keep search results correct under concurrent edits while
  reducing measured main-thread blocking and memory on representative image-
  heavy documents. Record before/after timings and browser memory evidence.
- **Verification so far:** Search and Form extraction tests verify matching
  results without accessing nested image bytes; ordinary image interpretation
  retains its version for safe replacement. In one local Node 20 run on a
  40-page synthetic scan fixture, the indexed scan took 92.7 ms after the
  change versus 236.0 ms in a prior run. On the same 40-page, 20.4 MB fixture
  in local headless Chrome, three interleaved scans per mode found 640 matches;
  median search and timer delays were 272.6 ms with image fingerprinting and
  10.1 ms without it. Browser-process RSS sums for the combined run were about
  1,002 MiB at baseline and 1,120 MiB at sampled peak; shared pages may be
  counted more than once, and the combined sample cannot compare memory by mode.
  A later three-sample scheduling comparison on the same 40-page fixture found
  cold elapsed medians of 22.3 ms forced synchronous versus 41.6 ms cooperative,
  maximum event-loop gaps of 22.3 versus 13.6 ms, and repeated-query medians of
  21.8 versus 8.3 ms. Modes use the current code and an artificial budget
  fallback; combined process RSS cannot compare memory. See
  [PERFORMANCE_SEARCH.md](docs/PERFORMANCE_SEARCH.md). These synthetic results
  are not general latency or memory guarantees.

### BUG-170: Text redaction misses numeric copies in retained PDF objects

- **Status:** Fixed for the tested isolated-text redaction subset. Retained
  numbers and supported content-stream operands are checked before mutation.
- **Trigger:** Redact a numeric text string while another page retains the same
  value as a PDF number or text-positioning operand.
- **Original behavior:** The secure operation could report success while that
  numeric value remained readable after a full rewrite.
- **Verification:** Tests cover numeric annotations, content operands, writer
  rounding, decimal/exponent representations, shared references and unchanged
  documents on refusal. Short numbers may collide with ordinary geometry and
  be conservatively rejected; arbitrary semantic or encoded copies are not
  exhaustively detected.

### BUG-171: Grouped text edits can lose later paint styles

- **Status:** Fixed for the tested editing paths. Independently painted text
  remains segmented for rendering and line editing; a low-level replacement
  that cannot preserve multiple paint segments is rejected.
- **Trigger:** Edit a logical text run assembled from adjacent operators with
  different colors or other paint state.
- **Original behavior:** Grouped rewriting placed the full replacement in the
  first text-showing operator and cleared later operators, potentially applying
  the first segment's style to text that originally used another style.
- **Acceptance:** Preserve independent drawing styles and text position during
  supported edits; reject edits that cannot safely retain source segmentation.
- **Verification:** Regression tests cover mixed-color replacements, font-size
  changes, undo/redo and saved output checked with Poppler.

### BUG-172: ActualText spans can hide adjacent text or change paint order

- **Status:** Fixed for the tested ActualText cases.
- **Trigger:** An ActualText span contains independently painted or differently
  styled text, or a drawing operation appears between its text fragments.
- **Observed behavior:** Merging a painted fragment with adjacent ordinary
  text can remove the ordinary text from extraction and search; merging across
  an intervening drawing operation can change which text remains visible;
  merging different fonts can render later glyphs with the wrong font.
- **Acceptance:** Preserve logical extraction and original paint order, including
  ordinary text before and after an ActualText span.
- **Verification:** Tests cover both adjacent directions, extraction and search,
  intervening paths, mixed fonts and colors, nested spans and Poppler rendering.

### BUG-173: Hidden-text cleanup can retain numeric copies

- **Status:** Fixed for the tested isolated hidden-text cleanup subset.
- **Trigger:** Hidden text contains a numeric string also present as a retained
  page geometry value or a visible content-stream positioning operand.
- **Observed behavior:** Cleanup reports success and the numeric value remains
  readable in the saved PDF.
- **Acceptance:** Detect supported numeric representations before mutation and
  refuse cleanup if a retained value matches removed hidden text.
- **Verification:** Tests cover page geometry, content operands, decimal and
  exponent forms, writer rounding, retained stream length, and unchanged
  documents on refusal. Short numeric secrets can collide with ordinary
  coordinates; arbitrary semantic or encoded copies are not exhausted.

### BUG-174: Whole-page redaction can leave independent text copies

- **Status:** Partly fixed. A bounded additional scan rejects some copies of
  removed ASCII text bytes in retained text and PDF strings, including tested
  split text and UTF-16 strings; it is not an exhaustive absence check.
- **Trigger:** Redact a whole page while another page or metadata contains an
  independent copy of its sensitive text.
- **Original behavior:** Checks only compared complete stream bytes, so a
  differently encoded or partial copy could remain after a successful rewrite.
- **Verification:** Tests cover octal and hex strings, split Tj/TJ text, UTF-16
  metadata, saved output and rejection without mutation. Tested split and
  reordered copies across retained PDF strings now cause refusal, including
  UTF-16 fragments; retained-string inspection budget exhaustion also causes
  refusal. The
  conservative byte-set check can reject unrelated strings. Scans are bounded and
  do not establish coverage for short or non-ASCII text, unknown filters, other
  streams, image content or equivalent text with different font encodings.

### BUG-175: Alternative image cleanup skips nested direct dictionaries

- **Status:** Fixed for tested reachable nested dictionaries.
- **Trigger:** Sanitize alternative images when an `/Alternates` entry is inside
  a direct dictionary nested in page resources or another live container.
- **Original behavior:** Cleanup visited top-level objects only and could report
  `Nothing to sanitize` while the entry and its referenced data remained.
- **Verification:** Tests save and reopen nested and shared direct dictionaries,
  check retained unrelated resources, and verify that explicitly disabling the
  cleanup preserves the entry. A shared alternative image stream causes refusal
  before mutation, including shared image masks, while shared color resources
  and color-key masks are retained. Real signed PDFs are rejected before a
  removal; a no-op preserves their original bytes. Removal of a reference does
  not prove that a separately encoded copy of the image is absent.

### BUG-176: Text redaction can delete retained streams or leave numeric data

- **Status:** Fixed for the tested isolated-text redaction subset.
- **Trigger:** A removed redaction annotation references another page's retained
  content stream, or a rewritten stream length matches removed numeric text.
- **Original behavior:** Annotation cleanup could delete the retained stream;
  the rewritten `/Length` was not included in numeric-copy checks.
- **Verification:** Tests reject both cases before mutation and check saved,
  reopened multi-stream documents and Poppler output.

### BUG-177: Secure redaction can exhaust the stack or block on large graphs

- **Status:** Fixed for the tested redaction and save paths. Object snapshots,
  parsing and serialization avoid recursive stack growth; reachability and
  graphics work are bounded.
- **Trigger:** Redact a PDF containing a very deep object graph or a large
  uncompressed graphics stream.
- **Observed behavior:** Recursive reachability checks can overflow the call
  stack; a 1.6 MB stream containing 400,000 `q Q` pairs delayed a timer by
  about 2.1 seconds and left approximately 587 MB RSS in one local Node run.
- **Acceptance:** Bound traversal and parsing work, reject excessive input
  before mutation, and preserve ordinary supported documents.
- **Verification:** Tests cover deep graphs through the public API, parser,
  graphics-state, geometry and stream-comparison budgets, and unchanged output
  on refusal. The same synthetic stream was rejected in 3.9 ms in one later
  local Node run; these measurements are not browser or peak-memory results.
  Large legitimate inputs exceeding the inspection budgets are refused. The
  application saved and reopened a 14,000-level fixture; qpdf independently
  checked 32- and 100-level fixtures but rejects 14,000 levels under its own
  default nesting limit. Serialization preflight rejects direct cycles,
  excessive expansion and reader-unsafe sparse object numbers before redaction.

### BUG-178: Times-BoldItalic `p` uses an incorrect standard-font advance

- **Status:** Fixed for the tested standard Latin glyphs.
- **Trigger:** Lay out text containing `p` in Times-BoldItalic.
- **Original behavior:** The built-in width was 556 units; the standard AFM
  advance is 500, shifting later glyphs.
- **Verification:** The advance of every supported ASCII glyph was compared
  against independent AFM metrics across all twelve standard Latin fonts.

### BUG-179: Security cleanup mutates signed PDFs before rejecting the save

- **Status:** Fixed for the tested sanitization and action-removal paths.
- **Trigger:** Remove comments or JavaScript from a signed PDF using sanitize
  or the standalone action-removal API.
- **Observed behavior:** Cleanup mutates the document and reports success;
  the later save refuses to invalidate the signature.
- **Acceptance:** Reject changes before mutation and preserve original bytes
  and signature for no-op cleanups.
- **Verification:** Real signed fixtures cover comments, annotations, action
  cleanup, garbage collection, empty action dictionaries and no-op reporting;
  successful no-ops retain original bytes and a valid signature.

### BUG-180: Buffer-backed snapshots can share bytes with the live document

- **Status:** Fixed for worker snapshots and staged transaction byte fields.
- **Trigger:** A PDF byte field is a Node `Buffer` and the document is cloned
  for a worker snapshot or editing transaction.
- **Original behavior:** `Buffer.slice()` shared its backing memory, so a later
  write could change the snapshot or live document and evade conflict detection.
- **Verification:** Tests cover independent source and snapshot writes,
  transfer buffers, failed transactions and a Buffer supplied by a successful
  staged operation. This does not audit every byte copy elsewhere in the app.

### BUG-181: Redaction diagnostic overflows on deeply nested objects

- **Status:** Fixed for the tested diagnostic paths.
- **Trigger:** Scan a document containing deeply nested direct arrays or
  dictionaries, including cyclic object graphs.
- **Original behavior:** Recursive traversal could throw a stack overflow
  before reporting a matching sensitive string.
- **Verification:** A 14,000-level nested cyclic fixture finds the deep marker
  without throwing. A clear diagnostic scan remains explicitly inconclusive.

### BUG-182: Stream deduplication can merge different PDF objects

- **Status:** Fixed for the tested low-level deduplicator; automatic save-path
  deduplication is paused to preserve independent edits (BUG-185).
- **Trigger:** Two streams have the same content hash or identical bytes but
  different dictionaries, such as images with different dimensions.
- **Observed behavior:** A full rewrite can merge the objects, changing the
  retained page after save and reopen. Encrypted streams need special handling
  because identical ciphertext under different object keys is not equivalent.
- **Acceptance:** Merge only independently verified equivalent streams; keep
  protected-document streams separate and verify saved output independently.
- **Verification:** Tests compare raw bytes and dictionaries, force hash
  collisions, check different image dimensions with Poppler, and verify real
  encrypted fixtures after quick and optimized saves. Exhausted comparison
  budgets retain the streams; the explicit low-level API remains available.

### BUG-183: Comment cleanup leaves shared annotation descendants

- **Status:** Fixed for the tested annotation and appearance-resource paths.
- **Trigger:** A removed comment's content string or appearance is also
  reachable from a retained object.
- **Observed behavior:** Cleanup reports success while the sensitive shared
  object remains in the saved PDF.
- **Acceptance:** Reject shared sensitive descendants before mutation while
  allowing safe sharing of unrelated resources.
- **Verification:** Tests cover direct and indirect contents, appearance streams,
  Type3 and embedded fonts, ToUnicode, marked-content properties, patterns,
  shadings, graphic-state functions and color-space data. Shared sensitive data
  is rejected before mutation; verified standard fonts and device colors may be
  shared. Unknown resource structures and shared ICC profiles are conservatively
  rejected. Independent or differently encoded copies are not exhaustively found.

### BUG-184: Action cleanup can leave partial mutations after a deep chain

- **Status:** Fixed for the tested standalone action-cleanup paths.
- **Trigger:** Remove JavaScript from an unsigned PDF with an action followed
  by a very deep `/Next` chain.
- **Observed behavior:** Earlier actions may be removed before traversal
  overflows, leaving a modified document after the operation fails.
- **Acceptance:** Preserve the original document on failure and handle or
  explicitly reject deep action graphs before publishing changes.
- **Verification:** Tests cover 16,000 nested actions with qpdf save/reopen,
  12,000 nested fields, signed documents, existing empty `/Next` arrays and
  budget failures without mutation.
  Excessive action graphs are conservatively rejected.

### BUG-185: Automatic stream deduplication can couple future edits

- **Status:** Fixed for the tested save paths by pausing automatic stream
  deduplication until editing supports safe copy-on-write.
- **Trigger:** Save and reopen two pages with independently editable but
  byte-identical content streams, then edit only one page.
- **Observed behavior:** Automatic deduplication makes the pages share a stream;
  an in-place edit to one page can change the other page as well. Other editable
  image and metadata streams have similar ownership concerns.
- **Acceptance:** Preserve independent edit behavior after saving and reopening;
  do not automatically merge mutable streams without copy-on-write protection.
- **Verification:** Full, quick, optimized, compact and image-compression save
  tests reopen the PDF and edit one page and image without changing the other.
  Page-content edits now isolate tested shared streams and handle indirect
  content arrays, but other writable resources do not all have this protection.
  Garbage collection remains enabled; output files may be larger.

### BUG-186: Security optimizer reports deduplication it did not perform

- **Status:** Fixed for the tested optimizer report.
- **Trigger:** Optimize a document containing duplicate stream candidates.
- **Original behavior:** The report claimed stream groups were deduplicated,
  but no reference remapping was applied.
- **Verification:** A fixture with two reachable duplicate streams reports zero
  deduplicated streams and states that deduplication was skipped.

### BUG-187: Whole-page redaction can miss stale cached page content

- **Status:** Fixed for tested full-page content-reference structures.
- **Trigger:** A marked page's cached `contentRefs` points to a different stream
  from its `/Contents` entry, including one shared with another page.
- **Observed behavior:** The editor can expose sensitive cached content, while
  whole-page redaction clears only the dictionary entry and reports success;
  the cached stream may remain in the saved output.
- **Acceptance:** Verify the marked page's content cache and underlying ordered
  content references before mutation; reject mismatches without changing it.
- **Verification:** Tests cover wrong-page references, missing, additional and
  reordered entries, reference aliases, direct and indirect arrays, empty
  pages and invalid references. Mismatches are rejected before mutation.

### BUG-188: Replacing a reused image changes every placement on the page

- **Status:** Fixed for tested direct-page image placements.
- **Trigger:** A page draws the same image resource more than once; replace one
  selected placement and save.
- **Observed behavior:** Both placements change because the replacement edits
  the shared image resource rather than just the selected `Do` instruction.
- **Acceptance:** Change only the selected placement, preserving other uses
  after quick and optimized save/reopen; reject ambiguous selections safely.
- **Verification:** Tests cover quick, optimized and incremental save/reopen,
  shared page content, alpha masks, asynchronous failure and concurrent changes.
  Stale selections are separately checked by resource version
  ([BUG-190](#bug-190-an-old-image-selection-cannot-identify-a-replaced-resource)).

### BUG-189: Shared page content references can target the wrong page

- **Status:** Fixed for the tested page-owner bindings.
- **Trigger:** Two page objects share the same in-memory `contentRefs` array.
- **Observed behavior:** The last owner binding can replace the first, so an
  edit requested for one page changes the other page's content reference.
- **Acceptance:** Detect ambiguous ownership before mutation and preserve both
  pages, including bindings without a document context.
- **Verification:** Tests cover shared arrays with and without document context,
  concurrent changes, history restoration and unchanged documents on refusal.

### BUG-190: An old image selection cannot identify a replaced resource

- **Status:** Fixed for the tested image replacement paths.
- **Trigger:** Select an image, replace its resource by another operation at
  the same name and position, then use the old selection for another replace.
- **Risk:** `ImageItem` does not retain the selected resource's identity, so
  the second operation may target the newer image without detecting staleness.
- **Acceptance:** Verify the original selected resource before mutation, while
  preserving worker serialization and valid repeated image edits.
- **Verification:** Tests cover same-name and position replacement, changes to
  indirect image masks and named color spaces, worker serialization, repeated
  placements, sequential edits and undo. Unresolved or oversized dependency
  graphs remain viewable but are refused for replacement.

### BUG-191: Transparent SVG image uploads are flattened onto white

- **Status:** Fixed for the tested upload and replacement paths.
- **Trigger:** Insert or replace an image with a transparent SVG.
- **Original behavior:** The editor drew non-PNG uploads onto a white canvas and
  exported JPEG before inserting them, so transparency was lost.
- **Acceptance:** Preserve transparent SVG pixels through insertion, replacement
  and save/reopen, with a browser and independent-reader regression.
- **Verification:** Chrome insertion, floating-image and embedded-image
  replacement were saved and reopened; Poppler confirmed transparent pixels.
  PNG and JPEG upload behavior was also checked.

### BUG-192: Incremental save can omit in-place page content edits

- **Status:** Fixed for tested page-content update paths.
- **Trigger:** Edit an existing unshared page stream and explicitly save an
  incremental revision while another document object is also changed.
- **Observed behavior:** The updated stream was not registered as modified, so
  the incremental revision could preserve the other change but omit the edit.
- **Acceptance:** Record changed stream and page keys, including edits staged
  in a transaction, without recording unchanged streams as modified.
- **Verification:** Tests cover in-place changes, staged-to-live transfers,
  unchanged streams and saved incremental output.

### BUG-193: Cleanup feedback does not explain that a new copy must be downloaded

- **Status:** Fixed in the security panel for the tested cleanup actions.
- **Trigger:** Run sanitization, attachment removal or metadata stripping in the
  editor, then leave without downloading the result.
- **Original behavior:** The success message said content was removed without
  explaining that the original file on disk was unchanged.
- **Acceptance:** Explain that changes must be downloaded as a new copy, without
  claiming the original file was modified.
- **Verification:** Component tests cover the four cleanup actions. Chrome
  verified the sanitization message and a downloaded, independently reopened
  copy without the test title; the original fixture retained it.

### BUG-194: Shared Info metadata values can survive cleanup

- **Status:** Fixed for the tested metadata cleanup paths.
- **Trigger:** A value or descendant of an Info dictionary field being removed
  is also reachable from another document object or a retained Info field.
- **Original behavior:** Cleanup could report the field removed while the same
  indirect value remained reachable in the saved document.
- **Acceptance:** Detect shared or unresolvable metadata object graphs and
  reject before mutation; save unshared removals in a full rewrite.
- **Verification:** Standalone and sanitization tests cover shared indirect and
  nested values, preserved fields, unresolved references, and quick-save/reopen
  of an unshared value. Independent copies or differently encoded equivalents
  are not exhaustively detected.

### BUG-195: Many image aliases repeatedly hash the same image

- **Status:** Fixed for each tested page interpretation.
- **Trigger:** A page uses many XObject names for the same large image, or
  contains many distinct large image resources.
- **Original behavior:** Every resource name independently hashed the image
  and its dependencies on the main thread, with no cumulative work limit.
- **Acceptance:** Reuse a version within one interpretation for the same source,
  bound cumulative fingerprint work and refuse replacement when verification
  cannot be completed, while continuing to display the image.
- **Verification:** Tests exercise aliases, multiple images, byte and graph
  limits, original-size compatibility and resource changes between
  interpretations. Each nested Form is interpreted separately; this does not
  impose a global budget on the complete rendering operation.

### BUG-196: Creating a redaction mark can target the wrong page or no page

- **Status:** Fixed for the tested marking paths.
- **Trigger:** A page's annotation array is shared with another page, is
  malformed, or cannot be resolved when a mark is created.
- **Original behavior:** A shared array was changed for both pages; malformed
  annotation data could leave a detached mark while reporting a reference.
- **Acceptance:** Attach a valid mark to only the selected page and reject
  invalid pages, rectangles or annotation collections without mutation.
- **Verification:** Tests cover direct and indirect shared arrays through
  save/reopen, missing and cyclic references, malformed collections, invalid
  page indices and non-finite or empty rectangles.

### BUG-197: Hidden-layer cleanup can change later visible graphics

- **Status:** Fixed for the tested isolated hidden-text cleanup paths.
- **Trigger:** A hidden block closes its initial graphics-state save, changes a
  setting such as color, then opens another balanced graphics-state block.
- **Observed behavior:** The cleanup can accept and delete the hidden block,
  also deleting a state change that affected later visible content. An
  independent Poppler comparison reproduced a visible color change.
- **Acceptance:** Require the entire removed block to remain inside its initial
  saved graphics state, or preserve the state correctly; reject unsupported
  structures without mutation and verify visible pixels after save/reopen.
- **Verification:** An independent two-page reproducer is now rejected before
  mutation, preserving its visible red text. Valid nested-state fixtures and a
  three-page cleanup pass Poppler checks at 36, 72, 150 and 300 dpi.

### BUG-198: Secure redaction cannot be performed from the editor

- **Status:** Fixed for the tested secure-redaction subsets.
- **Trigger:** A user needs to redact a selected region, a whole page, or
  existing redaction annotations in the editor.
- **Original behavior:** The security panel showed a mark count but provided
  no controls to select or apply secure redaction.
- **Acceptance:** Provide a transaction-safe flow that maps the visible region
  correctly, preserves unfinished work on refusal, supports undo and makes clear
  that the user must download a new copy. Reject unsupported documents without
  claiming success.
- **Verification:** Desktop and mobile Chrome tests cover region and page
  redaction, existing marks, rotated CropBox and zoom, undo/redo, signed-file
  refusal, draft preservation, touch selection and downloaded PDFs checked by
  qpdf and Poppler. Unsupported transformations and document structures are
  rejected; Escape and mobile browser-level zoom were not separately tested.

### BUG-199: Incremental save can omit a newly created redaction mark

- **Status:** Fixed for tested direct and staged marking paths.
- **Trigger:** Create a redaction annotation, then explicitly save an
  incremental revision with another page listed as modified.
- **Original behavior:** The new annotation and its page were not registered
  as modified, so the unrelated edit was saved but the mark disappeared.
- **Acceptance:** Include both the page dictionary and new annotation in the
  incremental revision, including after publishing a staged transaction.
- **Verification:** Direct and staged regressions reproduced the omission;
  both now save, reopen and retain the mark alongside the other page edit.
  A mark alone does not remove underlying content; redaction must be applied.

### BUG-200: Incremental save can overwrite an existing object with a new-object key

- **Status:** Fixed for the tested incremental save paths.
- **Trigger:** An explicit incremental save supplies a new object with the same
  key as an object already in the live document, such as a redaction mark.
- **Observed behavior:** The supplied object replaces the live object in both
  the saved output and the editor without reporting the conflict. Direct and
  worker saves both reproduce the problem.
- **Acceptance:** Reject object identity collisions before publishing changes,
  while preserving valid new-object saves and queued save behavior.
- **Verification:** Direct, worker and low-level API tests cover conflicts,
  queued saves, object-identity changes, free generations and failed
  serialization or revision bookkeeping without partial publication. Some
  ambiguous historical generation cases remain restricted under BUG-201.

### BUG-201: Some valid historical object-number reuse is conservatively rejected

- **Status:** Fixed for tested validated revision chains and hybrid xrefs.
- **Trigger:** An incremental PDF has multiple historical generations for the
  same object number, and a caller tries to reuse that number.
- **Cause:** The parser retains historical xref entries but does not expose
  whether their order came from a validated revision chain or recovery scan.
  The writer cannot always identify the current generation safely.
- **Acceptance:** Carry verifiable xref provenance through parsing and worker
  serialization, permit valid reuse when the current entry is unambiguous, and
  continue rejecting ambiguous recovery data and live-object conflicts.
- **Verification:** Tests cover real historical generations, hybrid object
  streams, direct and worker saves, provenance tampering and damaged xrefs.
  Incomplete or untrusted recovered xrefs still reject unknown allocations.

### BUG-202: Failed incremental serialization can publish partial objects

- **Status:** Fixed for the tested low-level writer failure paths.
- **Trigger:** An incremental save includes multiple new objects and a later
  object, trailer or revision bookkeeping step fails.
- **Original behavior:** Earlier new objects could already have been inserted
  into the live document despite the save failing.
- **Acceptance:** Publish new objects and revision state only after all output
  is ready, and preserve the document and bookkeeping on failure.
- **Verification:** Tests inject a cyclic second object, invalid trailer and
  offset/revision manager failures; successful output reopens with the correct
  trailer size and objects.

### BUG-203: Sanitization reports metadata removal even when none was present

- **Status:** Fixed for tested metadata reporting paths.
- **Trigger:** Run sanitization on a document with no metadata, only Info,
  only catalog XMP, or only component-level XMP.
- **Original behavior:** The report always claimed Info and XMP were removed
  and set `metadataRemoved` to true, even when neither existed.
- **Acceptance:** Report only metadata categories actually removed, with a
  truthful no-op result when no category was present.
- **Verification:** Unit tests cover absent, Info-only, catalog-XMP-only and
  component-XMP-only cases and check saved output for the removed data.

### BUG-204: A saved incremental revision can leave the live xref stale

- **Status:** Fixed for the tested incremental save paths.
- **Trigger:** Save a new object incrementally, remove it from the live object
  map, then allocate the same number in another save.
- **Observed behavior:** The live xref was not advanced with the saved bytes,
  so the second save could overwrite the first object's number.
- **Acceptance:** Atomically synchronize trustworthy xref state with a
  successful revision and detect subsequent allocation conflicts in direct,
  worker and low-level save paths.
- **Verification:** Direct and worker regressions reproduce the original
  collision and verify refusal after saving and removing a live object; low-level
  save and failed-publication tests cover atomicity.

### BUG-205: A session edit can discard concurrent trailer changes

- **Status:** Fixed for the tested session edit and history restore paths.
- **Trigger:** Change `/Size`, `/Prev` or `/XRefStm` while a session edit is
  awaiting completion.
- **Observed behavior:** Its normalized serialization can hide the change from
  the transaction comparison and allow the older trailer to overwrite it.
- **Acceptance:** Detect the concurrent change before publishing and preserve
  the current document and trailer on failure.
- **Verification:** Independent tests change all three fields during edit and
  undo, and assert that the operation fails without discarding those changes.

### BUG-206: Canceling a prepared history restore can leave changes applied

- **Status:** Fixed for the tested public history and toolbar paths.
- **Trigger:** Call the public `prepareRestore` API on a live document, then
  cancel the prepared undo or redo.
- **Observed behavior:** The document is modified before the prepared restore
  is committed; canceling only releases the session lock.
- **Acceptance:** Publish the restored document only when committed, and retain
  its original state on cancellation or a stale transaction.
- **Verification:** Tests cover cancellation, stale commit and concurrent edits;
  toolbar multi-session undo/redo remains covered by integration tests.

### BUG-207: Large PDF incremental saves can block the editor and use substantial memory

- **Status:** Open.
- **Trigger:** Save a large PDF incrementally using the browser editor.
- **Evidence:** One local headless Chrome run with a 100 MiB synthetic PDF
  measured approximately 3.16 seconds for direct save (maximum heartbeat gap
  3.16 seconds) and 4.51 seconds for worker save (maximum gap 405 ms). Sampled
  browser-process RSS sums peaked near 2 GiB, with shared pages possibly counted
  multiple times. No before-change baseline was available, so attribution and
  general performance remain unproven.
- **Acceptance:** Measure representative real PDFs and a baseline, then reduce
  main-thread blocking and peak memory without weakening xref mutation checks.
- **Progress:** Redundant snapshots were reduced for tested saves and a
  reproducible browser benchmark was added. A three-sample 20 MiB synthetic
  comparison showed mixed direct/worker timings and did not establish a memory
  improvement; see [PERFORMANCE_SAVE.md](docs/PERFORMANCE_SAVE.md).

### BUG-208: Failed DSS creation can leave an in-memory partial edit

- **Status:** Fixed for the tested incremental DSS paths.
- **Trigger:** Add DSS information while the document's xref provenance is stale.
- **Observed behavior:** The operation modifies the live catalog and object map
  before the incremental writer rejects the save.
- **Acceptance:** Validate and stage the complete change, leaving the document
  and original signed bytes unchanged if creation or saving fails.
- **Verification:** An independent stale-proof regression confirms no mutation;
  a real RSA-signed PDF with DSS passes qpdf and OpenSSL CMS checks.

### BUG-209: Signature finalization can publish bytes from a different PDF

- **Status:** Fixed for the tested signature-finalization paths.
- **Trigger:** Finalize a signature on one live document using placeholder
  bytes belonging to a different document.
- **Observed behavior:** The new bytes and xref replace the live document's
  originals while its page and object graph still belongs to the first PDF.
- **Acceptance:** Verify that the signing input corresponds to the live graph,
  or publish a verified corresponding graph atomically; reject mismatches
  without mutation while preserving supported signing workflows.
- **Verification:** Independent tests reject an unrelated PDF and unsaved page
  edits, and verify a real AcroForm signature without an explicit `sigRef`
  using qpdf and OpenSSL. Multiple signatures and undo/redo were also tested.

### BUG-210: Object stream index can resolve the wrong PDF object

- **Status:** Fixed for the tested unencrypted and encrypted object-stream paths.
- **Trigger:** An xref stream assigns a compressed object's index to a
  different object number in the object stream header.
- **Original behavior:** The parser used the indexed object without checking
  its number, so one object's data could be loaded under another reference.
- **Acceptance:** Validate object stream headers, ensure each xref entry names
  the object at its indexed position, and reject truncated or extra member
  syntax without publishing partial decrypted results.
- **Verification:** Real malformed object-stream fixtures cover swapped
  indices, malformed headers, offsets, work limits and incomplete or extra
  object syntax, including extra tokens after the object-stream header. Valid
  unencrypted and encrypted object streams pass the related regression tests
  and independent qpdf and pdf-lib checks.

### BUG-211: A literal or name `R` can be mistaken for a PDF reference

- **Status:** Fixed for the tested parser paths.
- **Trigger:** Parse a valid sequence such as `[5 0 (R)]` inside an object
  stream (or an equivalent sequence using `/R`).
- **Original behavior:** The parser checked only the third token's value and
  could treat a string or name as the reference keyword, silently changing the
  data. Other syntax keywords had the same ambiguity.
- **Verification:** The parser now requires keyword tokens for references and
  structural keywords. Regression tests cover literal strings, names, real
  references and nested dictionaries; independent qpdf checks confirm valid
  object streams, including escaped literal strings.

### BUG-212: NUL whitespace can conceal retained hex-string copies during cleanup

- **Status:** Fixed for the tested cleanup paths.
- **Trigger:** A retained `PDFHexString` contains a copy of removed ASCII text
  with legal NUL whitespace between its hexadecimal digits.
- **Original behavior:** `PDFHexString.toBytes()` used JavaScript whitespace
  rules, which exclude NUL, so some retained copies were decoded incorrectly.
  Independent tests reproduced successful whole-page redaction and hidden-layer
  cleanup while such a copy remained in Info or the trailer ID, respectively.
- **Acceptance:** Use PDF whitespace and odd-nibble rules, reject malformed or
  over-budget retained hex strings before mutation, and verify retained copies
  are refused across supported cleanup paths.
- **Verification:** Independent regressions reproduced both failures before
  the fix and now pass for whole-page redaction, isolated text redaction and
  hidden-layer cleanup. Tests cover malformed syntax, NUL and other PDF
  whitespace, odd nibbles, cumulative work limits and refusal without mutation.
  Redaction of supported whitespace-containing text was checked after saving
  and reopening with Poppler extraction and pixel comparisons. These checks do
  not establish exhaustive detection of differently encoded copies.

### BUG-213: Copying pages loses popup annotation parent links

- **Status:** Fixed for tested same-page indirect popup relationships.
- **Trigger:** Extract or insert a page containing a text annotation and its
  popup annotation, linked by indirect `/Parent` and `/Popup` references.
- **Original behavior:** Page copying discarded every `/Parent` entry, including
  the popup's link to its owning annotation. An independently reopened fixture
  reproduced the missing link in both extracted and inserted PDFs.
- **Acceptance:** Preserve supported same-page popup relationships without
  copying unrelated pages or field trees; reject ambiguous relationships before
  changing the target document.
- **Verification:** Saved and reopened extraction and insertion fixtures retain
  the popup and parent links, including a widget parent. Independent pdf-lib
  checks also confirm the form remains editable; malformed, cross-page and
  excessive graphs are rejected before mutation.

### BUG-214: Copying a page with ResetForm can damage its field hierarchy

- **Status:** Fixed for tested field-reference actions; ambiguous graphs are
  rejected before mutation.
- **Trigger:** Extract or insert a page whose Link annotation has a `/ResetForm`
  action referencing an AcroForm root with child fields.
- **Original behavior:** The action could copy the field objects before the form
  merge rebuilt the tree. Later cloning reused those incomplete objects, leaving
  their `/Parent` links absent. Independent pdf-lib reopening could not find the
  original qualified field after either operation.
- **Acceptance:** Preserve usable field relationships and action targets after
  save and reopen, or reject unsupported action graphs without partial changes.
- **Verification:** Saved and reopened extraction and insertion fixtures retain
  the referenced field tree and usable field; pdf-lib checks the qualified name
  and value. Tests reject references to omitted fields, partial extraction with
  name-based actions, action-dependent name conflicts and excessive or cyclic
  graphs without changing the source or target.

### BUG-215: Page copying can retain a source-only content reference

- **Status:** Fixed for the tested extraction and insertion paths.
- **Trigger:** A page's cached `contentRefs` disagrees with its `/Contents`
  graph, then the page is extracted or inserted into another document.
- **Original behavior:** When copying had not mapped a cached reference, the
  code reused its source object number in the target. The copied page could
  display empty or unrelated content even though reopening the saved PDF used
  different `/Contents` data.
- **Acceptance:** Validate cached page content against the graph before mutation
  and never publish an unmapped source reference in the copied document.
- **Verification:** Independent regressions cover indirect arrays and aliases,
  object-number collisions, shared streams, copying followed by editing and
  save/reopen. Conflicting or unresolved caches are rejected before mutation.

### BUG-216: Redaction stream comparisons can block on many similar objects

- **Status:** Fixed for bounded stream-comparison work; large documents can be
  rejected when the inspection budget is exhausted.
- **Trigger:** Apply whole-page or partial-graphics redaction to documents with
  many removed and retained streams, especially long equal-prefix streams or
  empty streams.
- **Original behavior:** Whole-page redaction compared streams without a work
  budget; the partial-graphics comparison's byte-pair budget did not count
  empty-stream pairs. An independently created two-page PDF with 120 streams on
  each side exceeded 20 seconds in whole-page processing.
- **Acceptance:** Bound stream-pair and byte comparison work, refuse excessive
  inputs before mutation, and retain duplicate detection for supported cases.
- **Verification:** Both paths now bound outer stream pairs, buffer pairs and
  byte comparisons. Tests cover empty streams, raw/decoded and alias cases,
  long common prefixes, budget exhaustion and no-change refusal. Duplicate
  representations in the isolated plan are checked and deduplicated. The
  64 MiB byte and 65,536 pair limits can reject otherwise valid documents;
  bounded work does not guarantee a responsive browser.

### BUG-217: Some rotated single-run search highlights are misplaced

- **Status:** Fixed for the tested unsafe geometries; reliable rotated highlights
  remain unsupported.
- **Trigger:** Search a rotated, sheared or reflected text run whose glyphs do
  not satisfy the cross-run adjacency checks, for example a 90-degree run with
  nonzero character spacing.
- **Original behavior:** Search reused a horizontal box and drew a highlight at
  the wrong location. A real PDF with `2 Tc` returned a 3-by-12-point box while
  Poppler reported a rotated word approximately 9 by 44 points.
- **Verification:** Regression tests cover spacing, Form clipping, reflection,
  shear and complex glyphs; Chrome confirms that unsupported highlights are
  suppressed with an explanatory message and horizontal controls still work.

### BUG-218: Search can cache a transient document state after it is restored

- **Status:** Fixed for the tested search and shared-index paths.
- **Trigger:** During a yielded search, mutate a page stream in place without
  changing the supplied revision, then restore it before final validation.
- **Original behavior:** Only the starting and final graph snapshots were
  compared. A three-page fixture published a match from the transient second
  page and retained it in the search index even after the bytes were restored.
- **Acceptance:** Never publish or retain mixed-state results, including when
  input changes and later returns to the starting state; preserve cancellation
  and safe handling of cross-thread shared buffers.
- **Verification:** Search uses a private snapshot for cacheable graphs, and
  concurrent searches cannot reuse a cache owned by another snapshot. Tests
  reproduce in-place change/restore, shared-index races, cancellation and
  retry. Shared buffers are rejected, including cross-realm and shadowed-buffer
  cases; graph inspection has object, step and depth limits. Graphs exceeding
  lazy structure or dependency budgets still scan synchronously
  ([BUG-169](#bug-169-image-heavy-search-falls-back-to-a-synchronous-full-scan)).

### BUG-219: Annotation copy checks can miss serialized non-Latin-1 names

- **Status:** Fixed for the tested whole-page redaction paths.
- **Trigger:** Whole-page annotation redaction inspects a retained PDF name or
  dictionary key containing characters above U+00FF in an in-memory graph.
- **Original behavior:** Copy checks encoded the name as UTF-8, while the PDF
  writer serializes the same name differently. A constructed `ZQXJ` secret was
  recovered as fragments from the retained name after save and reopen.
- **Acceptance:** Inspect or reject names and keys using a representation
  consistent with saved PDF bytes, before applying the redaction.
- **Verification:** Tests reproduce the saved and reopened name/key corruption,
  including when no Text annotation is present, and confirm no-change refusal.
  Annotation copy checks include serialized escape spellings and bounded
  positive and fragmented-copy fixtures; arbitrary semantic transformations
  remain outside their guarantee.

### BUG-220: Redaction marks can leave copies of their own sensitive text

- **Status:** Fixed for the tested annotation fields and retained-copy checks;
  unsupported mark metadata is rejected before mutation.
- **Trigger:** Apply a redaction mark whose annotation text also exists elsewhere
  in the document, including when the text is split between retained metadata fields.
- **Original behavior:** Whole-page redaction skipped the mark's own metadata,
  and local fallback paths could succeed after the whole-page path refused it.
  A serialized fixture retained its mark's `/Contents` in the reopened PDF's
  document title after the mark was removed.
- **Verification:** The whole-page path checks supported mark text and bounded
  retained copies. Partial-graphics and isolated-text paths accept simple,
  non-textual marks; isolated text additionally permits a validated reference
  to a content stream that it replaces. Tests cover saved/reopened PDFs, split
  and encoded metadata,
  fallback paths and no-change refusal. Arbitrary semantic transformations remain
  outside these checks; some otherwise valid PDFs are refused.

### BUG-221: OCR drops words returned by the current Tesseract engine

- **Status:** Fixed for tested Tesseract.js 7 structured output.
- **Trigger:** Recognize text using the installed Tesseract.js version.
- **Original behavior:** The adapter read the old top-level `words` field and
  requested no structured output, so it returned an empty list even when the
  engine recognized text.
- **Verification:** Tests cover structured output, confidence and rectangle
  validation. An isolated test passed actual synthetic image data through the
  production adapter and a real local Tesseract worker, recognizing two words.
  A later cold offline Chrome test verified the bundled worker and model
  ([BUG-231](#bug-231-ocr-cannot-initialize-offline)).

### BUG-222: OCR results can be applied to the wrong page

- **Status:** Fixed for tested page and document changes; unsupported page
  geometry is rejected.
- **Trigger:** Start OCR and rearrange pages while recognition is pending.
- **Original behavior:** The operation could read a different page's canvas and
  insert its text into the original page. A Chrome reproduction moved the first
  page while a delayed recognition ran and found the result on the wrong page.
- **Acceptance:** Capture the intended page and image before asynchronous work,
  reject stale results, and apply changes as one undoable transaction.
- **Verification:** Controlled asynchronous tests cover stale document changes,
  transactional insertion and cleanup. Two Chrome tests with a delayed mock
  adapter cover page moves, navigation, close protection, save and undo/redo.
  Rotated, cropped and horizontally offset pages are refused until their OCR
  coordinates can be mapped reliably.

### BUG-223: Search root validation can delay cancellation on large documents

- **Status:** Fixed for bounded root validation and repeated inspection work.
- **Trigger:** Search a document with many cross-reference entries or page roots.
- **Original behavior:** Root validation repeatedly inspected the full graph
  before checking cancellation and snapshot budgets.
- **Verification:** Tests cover graph limits, cancellation, unsafe accessors and
  shared buffers. A synthetic 250,000-entry Node benchmark improved from
  277–312 ms to 189–237 ms across three runs. This is not a browser benchmark;
  the remaining synchronous validation can still block browser events.

### BUG-224: OCR text inherits page transforms and conflicting fonts

- **Status:** Fixed for the tested isolated, single-stream insertion cases;
  unsupported page content and non-ASCII OCR words are rejected.
- **Trigger:** Add OCR to a page whose content leaves a transformed graphics
  state or whose resources already use `/Helv` for a different font.
- **Original behavior:** OCR text inherited the page's final transform and reused
  the existing font name. Poppler placed a word at x=40 instead of x=20 after a
  2x transform, and extracted `HELLO` as different characters with a conflicting
  ZapfDingbats font. Inherited resources could also be overwritten.
- **Verification:** Tests check isolation, inherited resources, font collisions,
  refusal without mutation and incremental save/reopen. Poppler confirms the
  tested text and x position. OCR text width is not yet fitted to word boxes;
  complex/multiple content streams and non-ASCII words remain unsupported.

### BUG-225: Whole-page text inspection can silently stop at its budget

- **Status:** Fixed for tested marked-page inspection failures and limits.
- **Trigger:** Redact a page containing more text fragments than the bounded
  inspection supports, or content whose text cannot be inspected.
- **Original behavior:** Inspection could return no patterns after reaching the
  limit, so a later copy of the removed text could survive in metadata while the
  operation reported success. An independently saved and reopened fixture with
  64 preceding text shows retained its sensitive title.
- **Verification:** Tests exercise the public redaction API, excessive fragments,
  malformed content, page limits and unsupported filters, including refusal
  without modifying the input. Retained-page scans and other representations
  still have the separate limitations described in BUG-174.

### BUG-226: Whole-page redaction can skip retained pages during copy checks

- **Status:** Fixed for the tested retained-page inspection limits when a
  supported removed-text pattern is available.
- **Trigger:** Redact a page while a later retained page contains a copy of its
  text, but retained-page inspection exceeds its page or byte budget or cannot
  decode the page content.
- **Original behavior:** The scan silently stopped or skipped the page. In a
  66-page fixture, Poppler extracted the original text from the last page after
  the first page had been redacted and saved successfully.
- **Verification:** Tests cover a copy beyond the 64-page limit, unsupported or
  corrupt filters, byte limits, no-change refusal and a supported 64-page
  control. The check does not prove the absence of copies represented using
  unsupported text encodings or other uninspectable structures.

### BUG-227: Indirect action names can bypass script cleanup

- **Status:** Fixed for tested indirect action types and 3D annotation subtypes.
- **Trigger:** A JavaScript action uses an indirect `/S` name, or a 3D
  annotation uses an indirect `/Subtype` name with an `/OnInstantiate` script.
- **Original behavior:** Analysis classified the indirect action type as Other,
  and cleanup could report nothing removed while the JavaScript remained in the
  saved PDF. An independently constructed fixture retained the script after
  save and reopen.
- **Verification:** Tests cover analysis, direct cleanup and sanitization, chained
  actions, 3D scripts, save/reopen, malformed or cyclic type references, and
  preservation of signed documents. Unsafe type references are rejected before
  mutation. Inspection is still limited to the known action locations described
  in TASK-03; the result is not proof that all possible scripts are absent.

### BUG-228: Dense single-page search blocks and allocates unbounded matches

- **Status:** Fixed for bounded match collection and cooperative scanning when
  a safe document snapshot is available.
- **Trigger:** Search for a common character in a page with a very large number
  of matches.
- **Original behavior:** A single page built a complete intermediate match array
  before yielding, delaying cancellation and consuming substantial memory.
  A 100,000-match synthetic PDF delayed a queued timer until search finished.
- **Verification:** Tests cover complete ordered results, in-page cancellation,
  snapshot changes, concurrent index ownership, the cumulative 50,000-result
  boundary, and Replace All refusal before mutation. The limit produces a clear
  error rather than returning partial results. Long nonmatching runs and
  contiguous run chains are now scanned in bounded batches when a snapshot
  permits yielding; Unicode differential tests compare against native regular
  expressions. Page decoding, Replace All and the synchronous fallback can still
  block the main thread. A synthetic Node benchmark found greater total time
  with improved timer responsiveness; it is not a browser performance claim.

### BUG-229: Nested form widgets are reported more than once

- **Status:** Fixed for tested nested form trees.
- **Trigger:** Open a PDF whose AcroForm fields contain nested child fields and
  widgets, such as the independently maintained CC0 sample form.
- **Original behavior:** The field walker already aggregated descendant widgets,
  but the widget collector recursed over the same descendants again. A six-widget
  sample produced twelve detections, causing duplicate editor controls and edits.
- **Verification:** Tests cover nested fields, same-name radio widgets, fields
  shared across pages and widgets resolved through page annotations. Two CC0
  sample forms are edited, saved and reopened with independent pdf-lib and
  Poppler checks.

### BUG-230: Flattening form fields can discard values and appearances

- **Status:** Fixed for tested, inspectable appearances and simple fallback
  fields; unsupported or inconsistent cases are rejected before mutation.
- **Trigger:** Flatten a form containing text, checkbox or radio widgets.
- **Original behavior:** The operation synthesized page operators without
  registering the required font resources, emitted an invalid `arc` operator
  and removed the fields. In an independently maintained form, Poppler could no
  longer extract the edited text after flattening.
- **Verification:** Saved and reopened fixtures preserve tested text and widget
  appearance pixels; independent Poppler and pdf-lib checks confirm output and
  field removal. A Chrome test also edits, flattens, downloads and undoes an
  external CC0 form. Tests cover stale text and button appearances, viewer-generated
  appearances, unsupported annotation flags, conflicting font resources, and refusal
  without mutation. Complex or uninspectable appearances and non-printing
  widgets are refused; this does not cover every PDF form configuration.
  Tested multi-stream pages now preserve their original streams, with bounded
  validation and independent save/reopen checks; unsupported filters are refused.

### BUG-231: OCR cannot initialize offline

- **Status:** Fixed for the tested Chrome static build after its first online
  visit and successful application-cache installation.
- **Trigger:** Open the application offline before the OCR worker and English
  model have previously been loaded from the network.
- **Original behavior:** Tesseract.js fetched its worker, runtime and language
  model from a third-party CDN, so OCR could fail even with the editor cached.
- **Verification:** The build copies the locked worker and LSTM core variants
  and verifies the pinned default English model's hash. Tests check asset
  integrity, cache inclusion, missing-asset failure and root/subpath URLs. In a
  fresh Chrome session, the subpath app was disconnected before its first OCR
  operation; recognized words were saved and independently extracted with
  Poppler. An independent root-path offline test and a subpath development
  server OCR test also passed in Chrome. Other browsers and an uncached first
  visit remain unverified.

### BUG-232: RichMedia activation scripts survive JavaScript cleanup

- **Status:** Fixed for tested flat RichMedia asset name trees; unsupported or
  shared structures are rejected before mutation.
- **Trigger:** A RichMedia annotation references embedded JavaScript through
  its activation `/Scripts` array and `/Assets` name tree.
- **Original behavior:** The analyzer and cleanup only checked ordinary action
  dictionaries and 3D scripts, so they could report no JavaScript while the
  embedded script survived in the saved PDF.
- **Verification:** Synthetic, serialized fixtures cover analysis and cleanup,
  retaining independent video assets, multiple scripts, shared objects,
  limits and signed-document refusal. pdf-lib checks the reopened asset tree and
  saved bytes no longer contain the script marker. Nested name trees and other
  uninspectable structures are refused; execution in a RichMedia-capable viewer
  has not been verified.

### BUG-233: Page content split inside a string can be read incorrectly

- **Status:** Partly fixed. Multi-stream writes now reject tested unsafe
  merges without changing the document, and the flattening path preserves the
  source streams. The editor's own content extraction can still interpret
  nonconforming cross-stream tokens differently from other readers.
- **Trigger:** A nonconforming PDF splits a literal string or escape sequence
  across multiple `/Contents` streams. ISO 32000-1:2008 §7.7.3.3 permits
  stream divisions only at lexical-token boundaries; some readers tolerate
  the split anyway.
- **Observed behavior:** `getPageContentBytes` inserts a space between every
  stream. In a serialized fixture, Poppler extracted `FIRSTSECOND` while the
  editor's parser returned `FIRST SECOND`; split escapes also differed. Before
  the guard, a replacement permanently wrote the extra space into the file.
- **Verification:** Tests cover no-change refusal for split strings and image
  data, supported compressed streams and legal token boundaries. A Chrome test
  opens the document, rejects the unsafe replacement and downloads content that
  Poppler still extracts as the original text.
- **Next step:** Decide how to handle nonconforming token splits consistently
  across rendering, search and editing; compare independent readers without
  breaking conforming stream boundaries. Removing all separators is not
  sufficient: independent operators also need correct boundary handling.

### BUG-234: Linux CI rejects standard Courier stroke and assumes one qpdf precedence

- **Status:** Fixed in tested Ubuntu and macOS configurations; hosted CI remains
  to be verified for the resulting commit.
- **Trigger:** Render stroked Courier text on Linux without a metric-compatible
  fallback, or inspect a deliberately conflicting hybrid xref with qpdf 11.
- **Original behavior:** The Linux canvas could choose a proportional font,
  causing normal Courier text to fail the nonuniform-transform safety check.
  The independent xref test also assumed qpdf 12's interpretation, whereas
  qpdf 11 resolves the conflict differently.
- **Verification:** Linux and macOS tests cover Courier rendering, including
  independent Poppler checks and rejection of actual unsupported transforms.
  Both qpdf 11.9 and 12.4 tests independently verify the conflicting xref
  entries and require the application to reject object-number reuse. CI and
  Pages workflows install the compatible Liberation fonts and PDF tools.

### BUG-235: Search can cover the page-render retry control

- **Status:** Fixed for tested desktop and mobile viewport sizes.
- **Trigger:** A page fails to render while the Find & Replace panel is open,
  particularly around a 768-pixel viewport.
- **Original behavior:** The search/OCR panel and the failure notice occupied
  overlapping positions, leaving the Retry rendering button visible but unable
  to receive pointer clicks. The GitHub CI browser test timed out on that click.
- **Verification:** Chrome regression tests check that the notice, search panel
  and OCR control do not overlap and that retry works with search open and closed
  at 320, 390, 768, 1024 and 1280 pixels. Existing render-failure tests continue
  to verify that unsaved edits and drafts survive failed and retried renders.


### BUG-236: Tapping the page does not place a library signature

- **Status:** Fixed for tested simulated mobile touch and desktop Chrome.
- **Trigger:** Select a signature from the library and tap an empty page while
  the Sign tool is active.
- **Original behavior:** The panel said to click the page, but empty-page clicks
  only deselected signatures. Free placement required desktop drag and drop.
- **Fix:** Tap/click and drag now share a transactional placement path; existing
  signature fields and overlays take priority. If no library entry is selected,
  tapping an empty page does not add a signature.
- **Verification:** In mobile Chrome at 390×844 with simulated touch, a session
  signature was created, placed, saved and reopened with its appearance visible.
  A rotated/cropped page was checked against the saved annotation coordinates,
  and an existing signature field retained its field appearance without adding
  a free stamp. Desktop Chrome verified drag-and-drop and reselecting an overlay.
  Real iOS and Android devices were not tested.

### BUG-237: The mobile Sign options close button scrolls out of view

- **Status:** Fixed for tested simulated mobile viewports; discovered during
  BUG-236 testing.
- **Trigger:** In the Sign tool at a 390×844 mobile viewport, create a session
  signature and scroll the options sheet down to its library.
- **Original behavior:** The sheet's header and Hide panel button scrolled above
  the visible sheet. Before the fix, the button's lower edge was at 237 px while
  the sheet began at 295 px after scrolling to the bottom.
- **Fix:** The shared mobile options header remains visible above scrolling
  content and has a 44×44 px close target. Desktop layout stays unchanged.
- **Verification:** Chrome simulated touch checked Sign and Watermark at the
  top, middle and bottom at 390×844, 320×568 and 568×320; close and the bottom
  Watermark scan action were tapped. Dark mode and keyboard close were checked
  at 390×844, and desktop behavior at 1280×800. Real iOS and Android devices
  were not tested.

### BUG-238: Mobile text editing lacks visible Done and Cancel actions

- **Status:** Fixed for tested simulated mobile viewports.
- **Trigger:** Edit an existing line using touch in the PDF editor.
- **Original behavior:** There were no touch-accessible Done or Cancel controls.
  Enter committed, Escape canceled, and tapping away could commit without an
  explicit choice.
- **Fix:** Mobile editing exposes Done and Cancel. Both use the existing edit
  transaction; a pending submit is shared with other callers and cannot be
  canceled midway. While a line is being applied, input is read-only and the
  status is visible; an unfinished IME composition must finish before applying.
  Selected signature controls are unavailable during the line edit and return
  when the edit ends, preventing a concurrent signature mutation.
  The controls follow visual-viewport changes when available.
- **Verification:** Chrome simulated touch and keyboard tests cover portrait and
  landscape, PDF text extraction, undo, focus, overlapping action attempts,
  delayed and failed font loading, signature-handle gestures, and synthetic
  composition events. The
  keyboard viewport was simulated; real iOS and Android devices and their soft
  keyboards and input methods remain untested.

### BUG-239: Mobile form-field selection does not open its editor

- **Status:** Fixed for tested simulated mobile viewports.
- **Trigger:** Select a generated ordinary text form field in mobile Chrome at
  390×844 with simulated touch.
- **Original behavior:** The field was selected but its editor did not open;
  the same fixture opened the editor on desktop.
- **Fix:** A valid page selection opens the mobile options sheet and reveals
  the selected field's name and editor without taking keyboard focus. Stale
  selections are discarded if their document, page or subsequent intent changes.
  A signature field directs users to the Sign tool without altering its value.
- **Verification:** Chrome simulated touch checked text fields at 390×844,
  320×568 and 568×320, plus checkbox, dropdown, unsigned signature field,
  save/reopen, undo, IME draft protection, delayed selection and breakpoint
  changes. Desktop closed-panel preference and Focus Mode remained unchanged.
  Real iOS and Android devices, soft keyboards and other widget variants have
  not been verified.

### BUG-240: Existing text-widget appearances are missing from the canvas and image exports

- **Status:** Fixed for supported existing text-widget appearances.
- **Trigger:** Open the independently generated PDF with an ordinary text form
  field and an existing value.
- **Observed:** The main canvas and downloaded PNG, JPEG and SVG did not show
  the field appearance; the page thumbnail and Poppler did, and the saved PDF
  field value was preserved. Ordinary page text remained visible in every output.
- **Fix:** Render existing text-field appearances in the editor, selected-image
  background and image exports, resolving inherited field types and retaining
  annotation visibility and signature-overlay exclusion. No appearance is
  synthesized for an absent or invalid appearance. SVG uses the rendered crop
  and rotation dimensions. Page-resource fallback includes inherited resources;
  appearance-provided resources remain authoritative.
- **Verification:** Chrome downloads and canvas pixels were compared with a
  generated field and Poppler; the page-text control, shared-field commit,
  undo and reopen, and cropped/rotated exports were checked. Renderer tests
  cover hidden/NoView fields, inherited types and page resources, explicit
  appearance resources, indirect non-text widget types, invalid geometry and a
  corrupted Flate stream. Existing signature-placement
  and mobile form tests passed in simulated Chrome.
- **Limit:** Existing unsupported or stale appearances and NeedAppearances are
  not repaired; the existing decoder warns and passes unknown filters through.
  Checkbox, dropdown and other widget appearances and real mobile devices are
  outside this fix's verified scope.
