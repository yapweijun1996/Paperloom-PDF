# Project improvement backlog

Created from the 10-perspective review of commit `d7a2f90` on 2026-10-30.
The goal is a reliable browser-local PDF editor: protect user data and truthful
security results first, then strengthen editing, accessibility, compatibility,
and delivery. [BUG.md](BUG.md) owns individual defect details and status;
[docs/README.md](docs/README.md#review-findings-awaiting-verification) retains
earlier investigation leads. Tasks remain open unless a status says otherwise.

Effort estimates are relative planning estimates. The proposed order can change
after reproducing failures and confirming product priorities. Preserve browser-
local processing, existing PDF content, unrelated changes, and static hosting.

## First: safety and data integrity

### TASK-01 — Make signature validation fail closed

- **Status:** Complete for the fail-closed validation scope in the current
  working tree. The implementation deliberately returns `Unknown` where its
  verification or trust capabilities are insufficient.
- **Priority / effort:** P1 / high. **Related:** [BUG-001](BUG.md#bug-001-failed-signature-verification-can-be-reported-as-valid).
- **First step:** Reproduce the validation outcome using an independently signed
  PDF and a fixture with a tampered CMS signature. Review digest, signed byte
  coverage and certificate trust as separate claims, including the older leads.
- **Acceptance:** A failed signature never reports `Valid`; unsupported or
  incomplete verification is distinguishable from success. Valid, tampered,
  untrusted and incrementally updated fixtures are checked with an independent
  verifier and reported accurately in the UI.
- **Verification:** Real signed and tampered CMS fixtures were independently
  checked with OpenSSL; `pdfsig` checked integrity and coverage for valid,
  tampered and later-revision files. Chrome showed `Unknown` with the appropriate
  reason for the untrusted signer, tampered signature and later revision; after
  editing, the old report cleared and validation required reopening the PDF.
  Automated engine tests cover pinned trust, missing digests, unsupported
  algorithms, untrusted signers, invalid gaps and later revisions. Multi-
  certificate CMS tests also use the same unique signer for signature and trust
  checks regardless of certificate order. Certificate
  chains and signing-time trust are not validated; revocation is checked only
  through an optional caller-supplied callback.

### TASK-02 — Protect unsaved work on close and recovery

- **Status:** Implemented and verified for ordinary, signed and non-empty-password
  protected documents. See [BUG-021](BUG.md#bug-021-signed-pdf-graph-edits-had-no-automatic-recovery)
  for signed-draft recovery and the remaining limitations below.
- **Priority / effort:** P1 / medium. **Related:** [BUG-002](BUG.md#bug-002-closing-a-dirty-document-discards-its-recovery-data-without-warning).
- **First step:** Add an explicit dirty-document decision before clearing the
  session; investigate the existing encrypted and stale-recovery leads.
- **Acceptance:** Cancel retains the open document and recovery data; discard
  requires an explicit choice; save/download and reload restore the correct
  state. Test clean, dirty, delayed-autosave and encrypted-document paths. Also
  investigate the signed-PDF edit path: inserting a page during the TASK-01
  browser smoke produced a `SignedDocumentEditError` during autosave.
- **Review points:** #1, #5–#8 and #10 in the [static code review](docs/CODE_REVIEW_2026-10-30.md):
  no saved-state indicator or visible autosave failure, silent session recovery,
  one storage key shared by all tabs, no warning when opening a signed PDF, and
  an error screen whose Go Back deletes the stored copy.
- **Verified so far:** Chrome tests covered keep editing, explicit discard,
  download and resume of the latest local copy, protected overlay encryption,
  wrong-password preservation and protected recovery after reload. Signed graph
  edits recover from a separate draft while retaining the original signed bytes;
  exporting those edits remains prohibited. A
  non-empty password is required for newly encrypted recovery overlays; empty-
  password protected PDFs report that automatic protected recovery is unavailable.
  Cross-tab conflicts are detected and leave both records intact, but a tab with
  unsaved conflicting work must copy it before reloading. A downloaded protected
  PDF required its password after reload and reopened with the inserted page;
  clean close then retained the saved document for resume. Signed and protected
  signed test fixtures restored an inserted page in Chrome; wrong passwords and
  corrupt drafts preserved the recovery. A later edit could be undone, but undo
  history from before reload is not retained. Autosave remains debounced, so a
  crash before it finishes can still lose the most recent changes.

### TASK-03 — Make sanitization and redaction honest and complete

- **Status:** In progress. Known JavaScript action chains are cleaned and checked;
  isolated full-page, restricted partial graphics and a narrow text-redaction
  subset are supported. Most text, complex paths, retained filtered streams and other unsupported cases
  remain rejected. Hidden-layer cleanup supports a strictly isolated text
  subset on up to 64 pages, including tested nested page trees; other optional-content
  structures remain rejected.
- **Priority / effort:** P1 / high. **Related:** [BUG-003](BUG.md#bug-003-javascript-removal-misses-chained-actions),
  [BUG-004](BUG.md#bug-004-secure-redaction-leaves-vector-content-in-the-output),
  [BUG-005](BUG.md#bug-005-secure-redaction-can-retain-image-data-and-report-a-false-clean-result),
  [BUG-110](BUG.md#bug-110-attachment-cleanup-misses-associated-and-directly-embedded-files),
  [BUG-111](BUG.md#bug-111-sanitizing-hidden-layers-can-reveal-their-content),
  [BUG-112](BUG.md#bug-112-sanitization-skips-directly-embedded-comments),
  [BUG-113](BUG.md#bug-113-invalid-metadata-can-be-reported-as-removed-during-sanitization),
  [BUG-143](BUG.md#bug-143-standalone-metadata-stripping-can-leave-old-metadata-in-the-file),
  [BUG-153](BUG.md#bug-153-component-metadata-can-survive-sanitization),
  [BUG-154](BUG.md#bug-154-incomplete-page-cache-can-hide-content-from-cleanup).
- **First step:** Reproduce chained action removal in the UI and separately
  exercise exported redaction APIs; reject or clearly identify unsupported cases.
- **Acceptance:** Saved and reopened fixtures contain no prohibited chained
  actions or recoverable redacted content for supported cases. Unsupported
  cases do not claim success; inspect objects and decoded content independently.
- **Progress:** The cleanup handles nested, indirect and cyclic action chains,
  including known field, outline, page-navigation and 3D action locations.
  RichMedia activation scripts are removed from tested flat asset trees while
  preserving independent video assets; shared or unsupported structures are
  rejected ([BUG-232](BUG.md#bug-232-richmedia-activation-scripts-survive-javascript-cleanup)).
  Cleanup resolves tested indirect action-type and 3D-subtype names, rejecting
  malformed references before mutation
  ([BUG-227](BUG.md#bug-227-indirect-action-names-can-bypass-script-cleanup)).
  Cleanup requires a full rewrite and rejects XFA forms before mutation. Attachment
  cleanup handles tested associated files, indirect name trees and direct file
  annotations, rejecting shared or unresolved objects before mutation. Browser
  checks exercised both cleanup buttons with a chained-action fixture; saved
  output no longer contained its script marker. The diagnostic redaction scan
  reports incomplete coverage and traverses tested deeply nested objects without
  stack overflow ([BUG-181](BUG.md#bug-181-redaction-diagnostic-overflows-on-deeply-nested-objects)).
  Automatic stream deduplication is paused to preserve independently editable
  streams; the explicit low-level deduplicator compares raw bytes and complete
  dictionaries ([BUG-182](BUG.md#bug-182-stream-deduplication-can-merge-different-pdf-objects),
  [BUG-185](BUG.md#bug-185-automatic-stream-deduplication-can-couple-future-edits)).
  Tested shared page content is now isolated on edit, and incremental saves
  record in-place page stream changes ([BUG-189](BUG.md#bug-189-shared-page-content-references-can-target-the-wrong-page),
  [BUG-192](BUG.md#bug-192-incremental-save-can-omit-in-place-page-content-edits)).
  Garbage collection remains available, but optimized files may be larger until
  independent editing has reliable copy-on-write protection.
  The secure engine now clears an isolated page
  when one or more rectangular marks jointly cover its entire MediaBox, and
  forces a full rewrite. Tested whole-page marks can also remove restricted
  same-page Text and Popup annotations. Retained-content checks reject when
  all distinct secret bytes could be reconstructed from inspected data, so
  ordinary documents may still be refused even without a real copy. Complex
  annotations, unverified fonts and unknown streams are rejected;
  arbitrary transformed semantic copies cannot be ruled out. The editor now
  exposes selected-region, whole-page
  and existing-mark redaction through an isolated transaction, with undo and
  refusal that preserves pending work ([BUG-198](BUG.md#bug-198-secure-redaction-cannot-be-performed-from-the-editor)).
  Users must download a new copy to apply the changes.
  Separately created marks are retained by tested explicit incremental saves
  ([BUG-199](BUG.md#bug-199-incremental-save-can-omit-a-newly-created-redaction-mark));
  a mark alone does not remove content.
  Incremental writers also reject tested new-object collisions and publish
  staged objects only after successful serialization
  ([BUG-200](BUG.md#bug-200-incremental-save-can-overwrite-an-existing-object-with-a-new-object-key),
  [BUG-202](BUG.md#bug-202-failed-incremental-serialization-can-publish-partial-objects)).
  Validated revision chains and hybrid xrefs can reuse tested historical
  generations; damaged or untrusted recovery data remains conservatively
  rejected ([BUG-201](BUG.md#bug-201-some-valid-historical-object-number-reuse-is-conservatively-rejected)).
  Partial graphics marks can also remove wholly covered images and supported filled or
  stroked rectangles
  from simple unfiltered or strictly verified Flate-compressed target streams;
  paths containing multiple rectangles are supported when every subpath in the
  same paint operation is fully covered. Mixed covered and retained subpaths
  remain rejected: independent low-zoom raster checks found changes outside
  the marks when attempting to split them.
  Up to 64 marks on a page are supported when each hits a fully removed object.
  Multiple adjacent or overlapping marks can jointly cover one object's
  conservative bounds; even a small gap causes refusal before mutation.
  Unsupported features are rejected before
  mutation. Any retained filtered stream also causes refusal, because it could
  hide an encoded copy; unparseable retained streams are rejected. Independent
  semantic copies, including differently scaled equivalents, are not exhaustively
  detected. The legacy page-level redaction API still refuses all marks. A
  bounded traversal and parsing budget rejects exceptionally large inputs
  before mutation ([BUG-177](BUG.md#bug-177-secure-redaction-can-exhaust-the-stack-or-block-on-large-graphs)).
  Whole-page redaction verifies marked-page content references against the
  page cache before removing anything ([BUG-187](BUG.md#bug-187-whole-page-redaction-can-miss-stale-cached-page-content)).
  This can also reject large legitimate graphics streams. A staged serialization
  preflight rejects direct cycles, excessive expansion and sparse object numbers
  that qpdf would ignore. A
  general secure region-redaction workflow is still needed. Two experimental
  partial-image approaches (rewriting marked samples and
  splitting into cropped subimages) changed pixels fully outside the marks in
  independent Poppler checks at 150/300 dpi. Neither approach was adopted;
  partial image intersections remain rejected before mutation.
  An experimental partial-character TrueType approach also changed pixels
  outside the marked area in independent low-resolution Poppler checks; it was
  withdrawn, and embedded TrueType partial-character marks remain rejected
  without mutation.
  On Node 20.20.2, a clean offline install previously passed 2,202 tests with qpdf available, the
  production build and browser boundary checks. Chrome also confirmed the XFA
  refusal message. The later joint-coverage change passed 85 partial-graphics
  tests, including saved/reopened PDFs, Poppler pixel comparisons, gaps, and
  refusal of synthetic signed documents. The signed cases do not use a real
  certificate. Joint full-page coverage was also verified with real text and
  Poppler, refusal for gaps, duplicate or excessive marks, and a deterministic
  50,000-case independent grid comparison of the coverage calculation.
  A bounded whole-page scan additionally detects tested independent copies of
  ASCII text bytes in retained text and strings, including split operators and
  UTF-16 metadata ([BUG-174](BUG.md#bug-174-whole-page-redaction-can-leave-independent-text-copies)).
  It does not prove that all independent copies are absent: unknown or oversized
  streams, short or non-ASCII text, images and font encodings remain limitations.
  A separate path can remove fully covered, isolated text blocks on up to 64
  pages, including a verified multi-level page tree, using 12 unmodified standard Latin base fonts
  while preserving other supported text. It rejects partial
  coverage, unverified fonts, shared data, signatures and unsupported operators.
  It also handles tested `TJ` arrays containing split strings and numeric
  spacing, initial `Td`/`TD` positioning, exact identity `Tm` and default black
  text, and isolated bare `BT`/`ET` blocks without `q`/`Q` when each block
  sets its font and position and does not alter unverified persistent state.
  Complete covered blocks with consecutive `Tj`/`TJ` shows are also removed,
  including tested positive and negative spacing across shows; retained
  fragments are checked. Hexadecimal text strings may contain PDF whitespace;
  retained hex strings are validated and inspected with bounded work before
  text redaction, whole-page redaction and hidden-layer cleanup
  ([BUG-212](BUG.md#bug-212-nul-whitespace-can-conceal-retained-hex-string-copies-during-cleanup)).
  Nested arrays and partial character removal remain unsupported. Stream
  comparison work is now bounded for whole-page and partial-graphics redaction;
  large otherwise valid inputs can be rejected when the budget is exhausted
  ([BUG-216](BUG.md#bug-216-redaction-stream-comparisons-can-block-on-many-similar-objects)).
  Direct and standard indirect content-stream arrays are supported when each
  stream contains complete independent blocks separated by whitespace;
  cross-stream graphics state and reference-to-reference aliases remain
  unsupported. Real indirect-array fixtures passed qpdf checks and Poppler
  extraction and pixel checks at 36, 72, 150 and 300 dpi. Shared annotation/content references and
  rewritten numeric stream lengths are checked before mutation
  ([BUG-176](BUG.md#bug-176-text-redaction-can-delete-retained-streams-or-leave-numeric-data)).
  Poppler text extraction and pixel comparisons covered all 93 allowed ASCII
  characters in each font; independent AFM metric checks also fit the bounds.
  This does not prove font bounds for every PDF reader or rule out differently
  encoded semantic copies. Tested retained numeric objects and content operands
  are checked as possible copies ([BUG-170](BUG.md#bug-170-text-redaction-misses-numeric-copies-in-retained-pdf-objects));
  ordinary coordinates matching short redacted numbers can cause refusal.
  An isolated CI-mode release check passed 2,562 tests with qpdf,
  the production build and browser boundary checks; eight Chrome end-to-end
  flows also passed. After the multi-stream and bounded-processing changes,
  an isolated CI-mode run passed all 2,759 tests without skips, with qpdf,
  OpenSSL and pdfsig available, using four test workers. The production build,
  targeted lint and eight Chrome end-to-end tests also passed. The separate
  pixel-redaction experiment remains rejected; its high-DPI regression tests
  are included in that suite. After the page-content and image safeguards,
  an isolated CI-mode run passed all 2,835 tests across 226 files with qpdf
  and no skips. The production build, targeted lint and 12 Chrome end-to-end
  tests passed; four of the browser tests also checked saved image output with
  Poppler. After the indirect-array and metadata-sharing fixes, an isolated
  CI-mode run passed 2,864 tests across 228 files with qpdf and no skips.
  The production build, targeted lint and all 13 Chrome end-to-end tests also
  passed. Following the editor redaction workflow and multi-page hidden-text
  changes, 2,910 tests across 232 files and all 25 Chrome end-to-end tests
  passed with qpdf. The production build and targeted lint also passed; the
  build retains the existing harfbuzz top-level-await warning. After the nested
  hidden-layer, multi-rectangle and incremental-save changes, 3,000 tests in
  237 files and all 26 Chrome end-to-end tests passed with qpdf; the production
  build and targeted lint also passed. After xref provenance, bare-text and
  metadata-report changes, 3,100 tests in 251 files passed with qpdf; the
  production build, targeted lint and all 26 Chrome end-to-end tests also passed.
  After consecutive text-show and object-stream parsing changes, 3,166 tests in
  258 files passed with qpdf, as did the production build, targeted lint and
  all 26 Chrome end-to-end tests. After hexadecimal whitespace and bounded
  retained-copy checks, 3,188 tests in 261 files passed with qpdf; the
  production build, targeted lint and all 26 Chrome end-to-end tests also
  passed. After hidden-hex, popup, field-reference and rotated-search changes,
  3,233 tests in 268 files passed with qpdf; the production build, targeted
  lint and all 28 Chrome end-to-end tests also passed. After bounded stream
  comparisons, page-content copying and highlight safety changes, 3,266 tests
  in 274 files passed with qpdf; the production build, targeted lint and all
  29 Chrome end-to-end tests also passed. Following the annotation cleanup,
  search snapshot and real IRS fixture changes, 3,316 tests in 280 files passed
  with qpdf; the production build, targeted lint and all 29 Chrome end-to-end
  tests also passed. After bounded lazy search and annotation-copy changes,
  3,369 tests in 285 files passed with qpdf; the production build, targeted
  lint and all 29 Chrome end-to-end tests passed. After the mark and marked-text
  inspection changes, 3,429 tests across 292 files, the production build and all
  29 Chrome end-to-end tests passed in isolation. These checks do not establish
  general redaction coverage. After indirect-action, search and form fixes,
  an isolated CI run passed 3,474 tests in 299 files, the production build and
  all 29 existing Chrome end-to-end tests. After RichMedia cleanup, offline OCR,
  multi-stream and search changes, an isolated CI run passed 3,524 tests in
  305 files, the production build and all 32 Chrome end-to-end tests.
  Marked-page text inspection now refuses tested malformed and over-budget
  inputs rather than silently treating them as having no text
  ([BUG-225](BUG.md#bug-225-whole-page-text-inspection-can-silently-stop-at-its-budget)).
  For supported removed-text patterns, retained-page checks now also refuse
  tested undecodable or over-budget content instead of silently skipping pages
  ([BUG-226](BUG.md#bug-226-whole-page-redaction-can-skip-retained-pages-during-copy-checks)).
  Whole-page redaction now also rejects tested split and reordered copies of
  supported ASCII text across retained PDF strings. Its conservative byte-set
  test can reject unrelated metadata and does not establish general coverage
  ([BUG-174](BUG.md#bug-174-whole-page-redaction-can-leave-independent-text-copies)).
  Redaction marks now include their own supported text in retained-copy checks;
  local fallbacks reject marks with uninspectable metadata
  ([BUG-220](BUG.md#bug-220-redaction-marks-can-leave-copies-of-their-own-sensitive-text)).
  This does not prove general redaction coverage.
  Single-file deletion supports tested `/AF`-only attachments and removes aliases
  for the same file specification. Different same-name files, shared retained
  objects and unsupported `/RF` related files are rejected before modification.
  Alternative-image cleanup also visits reachable nested direct dictionaries
  ([BUG-175](BUG.md#bug-175-alternative-image-cleanup-skips-nested-direct-dictionaries));
  it refuses shared alternative image data but does not prove independently
  encoded copies absent.
  Comment cleanup checks tested shared annotation descendants and appearance
  resources ([BUG-183](BUG.md#bug-183-comment-cleanup-leaves-shared-annotation-descendants));
  unknown resource structures and shared ICC profiles cause refusal, while
  different or re-encoded copies cannot be exhaustively ruled out.
  Hidden-text cleanup was checked after full
  save/reopen with pdf-lib, pdftotext and Poppler pixel comparison, including
  uncompressed and Flate-compressed streams. The supported subset now permits
  up to 64 pages with isolated hidden text, including nested page trees and
  tested inherited or overridden resources. Hidden and visible `Tj` hex strings
  support PDF whitespace and odd-nibble padding; saved and reopened fixtures
  passed qpdf, Poppler extraction and pixel checks. Shared streams, other stream
  filters and complex layer structures remain unsupported. Hidden
  blocks that leak graphics state are rejected before mutation
  ([BUG-197](BUG.md#bug-197-hidden-layer-cleanup-can-change-later-visible-graphics)).
  Retaining non-empty Info metadata is rejected
  for this cleanup. Retained numeric values and content operands are also
  checked for hidden-text copies ([BUG-173](BUG.md#bug-173-hidden-text-cleanup-can-retain-numeric-copies));
  short numeric secrets can collide with ordinary coordinates and be rejected.
  Arbitrary transformed or reordered copies cannot be
  exhaustively ruled out. Standalone metadata stripping also requires a full
  rewrite when it removes data, so a later quick save cannot retain the old
  revision; signed documents and unsafe references are rejected before removal.
  Shared indirect Info values and their descendants are checked against
  retained objects and fields before removal ([BUG-194](BUG.md#bug-194-shared-info-metadata-values-can-survive-cleanup)).
  The sanitization report now distinguishes Info, catalog XMP and component
  metadata and reports no removal when none was present
  ([BUG-203](BUG.md#bug-203-sanitization-reports-metadata-removal-even-when-none-was-present)).
  Cleanup messages explain that users must download a new copy to apply changes
  ([BUG-193](BUG.md#bug-193-cleanup-feedback-does-not-explain-that-a-new-copy-must-be-downloaded)).
  Sanitization removes tested indirect component-level XMP streams, including
  compressed streams and streams shared by metadata entries; non-metadata
  sharing of streams or descendants, unexpected reachable typed XMP, direct
  streams and unresolved references are rejected before mutation.
  Signed documents are rejected when component metadata would be removed. Redaction and
  sanitization and the standalone JavaScript and attachment removal APIs check
  that the page cache matches the complete page tree before processing, rather
  than silently missing an uncached page.
  Sanitization and standalone action cleanup preflight signed documents, reject
  tested changes before mutation, and preserve bytes and truthful reports for
  no-op requests ([BUG-179](BUG.md#bug-179-security-cleanup-mutates-signed-pdfs-before-rejecting-the-save)).
  Standalone action cleanup also stages unsigned documents and handles tested
  deep chains without partial changes ([BUG-184](BUG.md#bug-184-action-cleanup-can-leave-partial-mutations-after-a-deep-chain));
  excessive graphs are rejected within an inspection budget.

## Next: reliable editing and access

### TASK-04 — Repair search, replace and undo

- **Status:** In progress. Replacements and history are verified for individual
  text runs. Search finds tested adjacent horizontal runs, and a restricted
  equal-length Courier cross-run replacement is supported. Tested unclipped
  rotated page runs can be searched without a highlight; their cross-run
  replacement, Form replacement and more complex boundaries remain unsupported
  (BUG-161). Unsafe single-run highlights are suppressed for tested rotated,
  sheared and reflected cases ([BUG-217](BUG.md#bug-217-some-rotated-single-run-search-highlights-are-misplaced)).
- **Priority / effort:** P1 / medium. **Related:** [BUG-006](BUG.md#bug-006-replace-current-changes-every-match-on-the-selected-page),
  [BUG-007](BUG.md#bug-007-find-and-replace-bypasses-editor-undo-history),
  [BUG-008](BUG.md#bug-008-an-active-search-forces-page-navigation-back-to-its-match),
  [BUG-161](BUG.md#bug-161-search-misses-text-spanning-separate-runs),
  [BUG-164](BUG.md#bug-164-search-highlights-ignore-page-rotation-and-crop-origin).
- **First step:** Reproduce each issue using multiple matches on multiple pages;
  integrate replacement into the existing document transaction/history path.
- **Acceptance:** Replace affects only the selected match; Replace All affects
  the intended matches; undo and redo restore each operation; manual page
  navigation and match navigation both work after opening and closing search.
- **Review points:** #2 in the [static code review](docs/CODE_REVIEW_2026-10-30.md):
  the case-insensitive path also interprets `$&` and `$$` in the replacement text.
- **Verification:** Engine and history tests cover individual matches, literal
  replacement text, stale selection, and multi-page undo/redo. In isolated
  Chrome, one replacement changed four matches to three, undo and redo restored
  each state, and Replace All was undone. Manual page navigation stayed on the
  requested page with search open or closed; match navigation still changed page.

### TASK-05 — Preserve form fields across page operations

- **Status:** In progress. Extraction, splitting and nested-field insertion
  preserve tested field trees; deleting pages also prunes their widgets and empty
  field branches while preserving shared fields on surviving pages. Equivalent resources are reused and a restricted
  set of conflicting font and field names is renamed with a user-visible
  mapping. Documents with field actions, XFA, shared field graphs or ambiguous
  resource conflicts remain rejected; tested page ResetForm actions are handled
  when their field references can be safely preserved.
- **Priority / effort:** P1 / high. **Related:** [BUG-009](BUG.md#bug-009-extracting-or-splitting-pages-loses-acroform-structure),
  [BUG-010](BUG.md#bug-010-merging-nested-forms-can-drop-later-field-branches),
  [BUG-144](BUG.md#bug-144-deleting-a-page-can-retain-its-form-widgets),
  [BUG-148](BUG.md#bug-148-batch-page-deletion-can-partially-modify-a-document),
  [BUG-157](BUG.md#bug-157-form-page-copy-can-lose-alignment-or-unsupported-form-dependencies),
  [BUG-158](BUG.md#bug-158-direct-page-extraction-bypasses-document-protection),
  [BUG-160](BUG.md#bug-160-page-insertion-copies-invalid-source-signatures).
- **First step:** Add fixtures for extracted inherited fields and inserted
  nested sibling fields; define preservation of field trees and widget parents.
- **Acceptance:** Reopened extracted, split and merged PDFs preserve relevant
  fields, values and relationships; an independent reader can use those fields.
- **Progress:** Regression fixtures cover inherited fields, widgets shared across
  pages, indirect field arrays and nested siblings. `pdf-lib` independently
  reopened and edited the resulting fields. Supported root-name conflicts are
  renamed and reported; unsupported name dependencies and resources are
  rejected. Supported font conflicts are renamed with their inherited
  appearance strings rewritten, without changing the source. Deletion tests
  also cover fields shared across pages and orphaned widgets pointing at the
  removed page, with unsupported ambiguous references rejected before mutation.
  Batch deletion preflights all targets, rejects duplicate indices and unsafe
  outline or name-tree structures, and preserves shared annotation arrays.
  Copying fields now preserves tested inherited `/Q` alignment; XFA, calculation
  order and field actions are rejected even without name collisions. Direct
  page extraction rejects signed and encrypted documents; the session path
  retains tested password protection instead of producing a plaintext copy.
  Insertion rejects signed or encrypted sources, while tested signed-target
  recovery and unlocked encrypted-target editing remain supported. Same-page
  popup annotation links and tested ResetForm field references survive copying
  and independent reopening ([BUG-213](BUG.md#bug-213-copying-pages-loses-popup-annotation-parent-links),
  [BUG-214](BUG.md#bug-214-copying-a-page-with-resetform-can-damage-its-field-hierarchy)).
  Omitted field dependencies, name-based actions in partial extraction, and
  ambiguous or over-budget graphs are rejected before mutation. Copied content
  references are validated and mapped rather than reusing source object numbers
  ([BUG-215](BUG.md#bug-215-page-copying-can-retain-a-source-only-content-reference)).

### TASK-06 — Make primary controls keyboard and screen-reader accessible

- **Status:** In progress. Primary controls are implemented and exercised; an
  end-to-end keyboard-only native file-picker check and dedicated screen-reader
  testing, plus the broader accessibility extension, remain outstanding.
- **Priority / effort:** P1 / low to medium. **Related:** [BUG-011](BUG.md#bug-011-the-upload-entry-point-is-not-keyboard-accessible),
  [BUG-012](BUG.md#bug-012-page-and-zoom-toolbar-buttons-have-no-accessible-names),
  [BUG-016](BUG.md#bug-016-desktop-tool-buttons-lack-accessible-names-and-selected-state),
  [BUG-019](BUG.md#bug-019-export-drawer-close-button-has-no-accessible-name).
- **First step:** Fix upload and icon-button names; inspect page thumbnail
  selection and reordering for keyboard alternatives.
- **Acceptance:** Complete upload, navigation and zoom with keyboard only; names,
  focus and disabled states are exposed in the accessibility tree. Verify a
  keyboard page-organization path and retain pointer and touch behavior.
- **Verification:** Desktop Chrome exercised keyboard activation of the upload
  chooser, navigation, zoom, page reordering and export-panel focus return.
  The OS file picker itself was not operated by keyboard. Desktop and mobile
  accessibility snapshots exposed named toolbar, tool and export controls;
  tests cover selected/disabled states and existing pointer reordering.
  A Chrome keyboard check with two synthetic P12 identities also verified
  selection, named deletion, focus on the next certificate or import button,
  and Escape returning focus to certificate management. The OS picker and a
  screen reader were not exercised in that check.
- **Review points:** #16 and #21–#30 in the [static code review](docs/CODE_REVIEW_2026-10-30.md)
  extend this beyond primary controls: an accessible text layer for the canvas,
  focusable overlays, dialog semantics and focus return, labelled controls,
  configurable shortcuts, contrast, live regions, landmarks and reduced motion.
  This extension is high effort; split it into its own task when scheduled.

### TASK-07 — Align export descriptions with actual outputs

- **Status:** Implemented and verified in the current working tree.
- **Priority / effort:** P2 / low. **Related:** [BUG-013](BUG.md#bug-013-export-descriptions-advertise-unsupported-or-misleading-formats).
- **First step:** Correct the tooltip and SVG description; evaluate demand before
  committing to Word, Markdown or true vector export.
- **Acceptance:** Every listed format corresponds to a working export; labels
  accurately describe SVG contents when opened and inspected.
- **Browser evidence:** The tested SVG embeds a raster PNG. The reversed range
  defect is tracked separately as [BUG-017](BUG.md#bug-017-reversed-export-range-reports-success-for-an-empty-file).

### TASK-13 — Validate export page ranges before download

- **Status:** Implemented and verified in the current working tree. Chrome
  rejected a reversed range without creating a Blob; valid ranges exported the
  selected pages. Automated checks cover invalid selections and every format.
- **Priority / effort:** P2 / low. **Related:** [BUG-017](BUG.md#bug-017-reversed-export-range-reports-success-for-an-empty-file).
- **First step:** Validate custom range bounds and ordering before export.
- **Acceptance:** Invalid ranges show a useful error and produce no download or
  success message; valid single-page and multi-page ranges work for each format.

### TASK-14 — Make raster export resolution device independent

- **Status:** Implemented and verified for PNG and JPEG. At DPR 1 and 2,
  Chrome produced 300 × 400 pixels for a 300 × 400 pt page at 72 DPI, and
  three 625 × 834 pixel JPEG pages at 150 DPI with quality 0.92.
- **Priority / effort:** P2 / low to medium. **Related:** [BUG-018](BUG.md#bug-018-raster-export-resolution-depends-on-display-pixel-ratio).
- **Acceptance:** Verify PNG and JPEG pixel dimensions against page geometry and
  selected DPI at DPR 1 and 2, including multi-page export and output quality.

### TASK-15 — Preserve interoperable checkbox field values

- **Status:** Implemented and verified for tested checkbox and radio field
  layouts, including non-default on-state names and multi-widget fields.
- **Priority / effort:** P1 / medium. **Related:** [BUG-020](BUG.md#bug-020-checked-form-field-is-read-as-unchecked-by-another-pdf-library).
- **Acceptance:** Saving checked and unchecked hierarchical and direct fields
  preserves value and appearance in Paperloom and independent readers, with
  non-default on-state names and multiple widgets covered by regression tests.
- **Verification:** `pdf-lib` independently reopened checked and unchecked
  hierarchical and direct fixtures, including different on-state names and radio
  options. Chrome toggled a non-default checkbox both ways, downloaded each
  result, and `pdf-lib` read the correct state in both outputs.

## Then: compatibility, delivery and maintainability

### TASK-08 — Establish a representative PDF regression corpus

- **Status:** In progress. Four generated text/graphics, image, form and
  synthetic scan-with-OCR cases
  now exercise open, text edit, rotation, save and reopen, with pdf-lib and
  Poppler checks. Solid interior colors are compared to avoid renderer-specific
  edge rounding. [The corpus notes](src/engine/__tests__/golden/README.md)
  document fixture origins and limits. A fifth synthetic case edits, rotates,
  signs, saves and reopens a PDF; `pdfsig` independently validates its temporary
  self-signed signature. A public-domain historical scan from the National
  Archives is also embedded in a generated PDF and checked with Poppler. The
  scan is not a real-world PDF structure or OCR ground truth. A blank,
  independently sourced IRS W-9 adds a six-page XFA and UR3 usage-rights
  signature fixture; no-edit save preserves the bytes and prohibited rewrites
  are rejected. OpenSSL verifies the original CMS and rejects tampering, without
  establishing certificate trust. Two independently maintained CC0 form
  samples now cover text, multiline, checkbox, radio and choice edits, saved
  and reopened with pdf-lib and checked with Poppler. They are generated
  samples, not real-world business documents. Nested widgets are collected once
  ([BUG-229](BUG.md#bug-229-nested-form-widgets-are-reported-more-than-once)).
  Automated editable real-world form coverage
  and further scans remain outstanding. An external, unmodified [U.S. Courts AO 440](https://www.uscourts.gov/sites/default/files/ao440.pdf)
  was also checked once: Paperloom edited its `Plaintiff` field with synthetic
  text, and pdf-lib and Poppler read the saved value. The original hash and
  reproduction limits are recorded in the corpus notes. Its embedded font
  redistribution rights remain unverified, so it is not a committed fixture
  or automated regression.
- **Priority / effort:** P1 / medium to high. **Dependency:** Can start alongside
  TASK-01 through TASK-05 and expand with their reproductions.
- **First step:** Curate legally usable small fixtures for forms, signatures,
  rotated pages, text, images and scans; document fixture origins and expected
  behavior. Extend the existing synthetic [golden smoke](src/engine/__tests__/golden/README.md).
- **Acceptance:** Automated open/edit/save/reopen checks and independent-reader
  checks cover the critical paths; rendering comparisons have justified platform
  tolerances. Fixture failures identify the affected document and behavior.
- **Review points:** #88 in the [static code review](docs/CODE_REVIEW_2026-10-30.md):
  the original golden-render plan was unimplemented and Canvas was only a
  transitive optional dependency. Rendering tests now use a declared Canvas
  test dependency; the broader representative corpus remains to be built.

### TASK-09 — Make fresh setup and release checks reproducible

- **Status:** In progress. Supported Node ranges and rendering test dependencies
  are declared; Node 20 clean install and build passed on macOS arm64 using an
  offline cache. The deployment guide describes the separate CI and GitHub
  Pages deployment workflows; a
  `typecheck` script and a CI missing-build guard are available. The compiled
  worker guard now executes parse/save/optimize checks in a Node VM. A local
  `verify:release` command runs tests, lint, typecheck, build and the applicable
  static guards in sequence. The command passed after an offline clean install
  on macOS arm64 in CI mode, with 2,497 tests passing and none skipped;
  the subpath build and guards passed. Full lint warnings and hosted deployment
  verification remain open; lint reported 169 warnings and no errors. qpdf
  12.4.2 was built from verified official source in a temporary directory for
  this run, not installed system-wide. A GitHub Actions workflow now provisions
  the required tools and runs release, coverage and static E2E checks; actionlint
  validates it locally, but a hosted run has not yet been observed. The Pages
  workflow builds and deploys main and includes a post-deployment smoke check;
  its hosted result remains to be verified. Linux Courier fallback and qpdf
  version differences found in hosted CI are addressed with Ubuntu and macOS
  regression checks ([BUG-234](BUG.md#bug-234-linux-ci-rejects-standard-courier-stroke-and-assumes-one-qpdf-precedence)).
- **Priority / effort:** P2 / medium. **Related:** [BUG-014](BUG.md#bug-014-the-documented-node-minimum-is-incompatible-with-the-locked-nextjs-version),
  [BUG-015](BUG.md#bug-015-deployment-guide-references-an-absent-actions-workflow).
- **First step:** Confirm the actual Pages deployment mechanism, select a
  supported Node version and reconcile setup and deployment documentation.
- **Acceptance:** A clean checkout runs install, test, lint, webpack build and
  applicable worker/browser/base-path checks; the intended CI provisions required
  tools and a deployed static build passes a browser smoke test. The guide matches
  the verified workflow; the existing smoke script is retained where applicable.
- **Review points:** #89, #90 and #92–#94 in the [static code review](docs/CODE_REVIEW_2026-10-30.md):
  add a `typecheck` script, make guard scripts fail in CI when `out/` is
  missing, declare supported engines, and add a changelog, tags and one
  command that runs every release check.

### TASK-10 — Reduce editor coupling through targeted transaction migration

- **Status:** In progress. Concurrent save entry points coordinate and reject
  stale results ([BUG-131](BUG.md#bug-131-concurrent-saves-can-replace-newer-document-bytes-with-an-older-snapshot));
  broader editor transaction and architecture work remains open.
- **Priority / effort:** P2 / medium to high. **Dependency:** Begin with TASK-04;
  avoid a broad rewrite.
- **First step:** Extract the search/replace flow behind a coherent controller
  and route its writes through the existing session transaction boundary. Review
  other direct mutation paths only as they are touched.
- **Acceptance:** Interaction and failure-injection tests preserve behavior,
  undo/redo and save/reopen results; public engine and browser-only boundaries
  remain intact. The change has a clear rollback boundary.
- **Review points:** #62 and #64–#72 in the [static code review](docs/CODE_REVIEW_2026-10-30.md):
  an unused store and hooks, document invalidation counters, dual history paths,
  deep imports past `browser-core`, text-edit, watermark and signature state
  clusters, inverted engine layering, the non-incremental Quick save mode and
  dead code.

### TASK-11 — Measure and improve large-document responsiveness

- **Status:** In progress. A bounded, validated search index and cooperative
  scanning improve repeated text-only queries; [the reproducible baseline](docs/PERFORMANCE_SEARCH.md)
  records one 200-page local run (241 ms old, 274 ms cold, 24 ms warm median).
  [History snapshots](docs/PERFORMANCE_HISTORY.md) have a synthetic text and
  image-containing memory baseline. Thumbnail generation now yields between
  batches; [the Node baseline](docs/PERFORMANCE_THUMBNAILS.md) records timer
  delay and identical output for text and image fixtures. Thumbnails now show
  supported existing form appearances and refresh affected pages after field edits
  ([BUG-146](BUG.md#bug-146-page-thumbnails-omit-form-widget-appearances));
  Chrome verified a field shared across two pages. Unsafe or over-budget
  appearance snapshots fall back to a full rebuild. Browser memory is not yet
  measured separately by mode. Before the lazy snapshot, a 40-page synthetic
  scan-image fixture exceeded the snapshot budget, used no index and
  delayed a queued Node timer by 59.9 ms in one local run. This does not measure
  browser memory or demonstrate an improvement for image-heavy PDFs
  ([BUG-169](BUG.md#bug-169-image-heavy-search-falls-back-to-a-synchronous-full-scan)).
  Search now skips image-edit fingerprinting; in a local Chrome run of a
  40-page synthetic scan fixture, median search and timer delays fell from
  272.6 ms to 10.1 ms across three interleaved scans per mode with identical
  results. A combined process-RSS sample cannot establish a memory improvement.
  A search-specific lazy snapshot can now yield and cache on tested large
  image graphs by copying and validating only accessed streams. A local
  three-sample comparison found lower maximum event-loop gaps and faster repeat
  queries, with slower cold elapsed time; browser memory improvement remains
  unproven ([PERFORMANCE_SEARCH.md](docs/PERFORMANCE_SEARCH.md)). Dependency or
  structure budget exhaustion still falls back to synchronous scanning;
  unverifiable custom object shapes are rejected. Cacheable searches guard
  index ownership against
  concurrent change-and-restore races ([BUG-218](BUG.md#bug-218-search-can-cache-a-transient-document-state-after-it-is-restored));
  shared buffers and graphs beyond the safety-inspection limits are rejected.
  Long no-match runs and adjacent-run checks also yield in bounded batches
  when a safe snapshot is available; page parsing and Replace All remain
  synchronous. Unicode matching is compared with native regular expressions.
  Dense page searches now create matches incrementally and yield when a safe
  snapshot permits it. Search and Replace All reject more than 50,000 matches
  instead of silently truncating results
  ([BUG-228](BUG.md#bug-228-dense-single-page-search-blocks-and-allocates-unbounded-matches)).
  Root validation now has explicit budgets and avoids redundant scans; the
  remaining synchronous work can still delay UI events
  ([BUG-223](BUG.md#bug-223-search-root-validation-can-delay-cancellation-on-large-documents)).
  A single headless Chrome run with a 100 MiB synthetic PDF also exposed long
  incremental-save pauses and high sampled process memory; the baseline and
  representative real-document measurements remain open
  ([BUG-207](BUG.md#bug-207-large-pdf-incremental-saves-can-block-the-editor-and-use-substantial-memory)).
  Redundant save snapshots were reduced for tested paths, and a reproducible
  synthetic browser benchmark is documented in [PERFORMANCE_SAVE.md](docs/PERFORMANCE_SAVE.md).
  A small before/after sample had mixed worker timings and did not establish
  a memory improvement.
- **Priority / effort:** P2 / medium to high. **Dependency:** Establish a
  representative baseline before choosing an optimization.
- **First step:** Measure search latency, thumbnail generation and history memory
  on small and large PDFs; compare incremental processing or indexing as needed.
- **Acceptance:** Record reproducible baseline and target measurements, demonstrate
  improvements without stale search or thumbnails, and verify memory and editing
  behavior on the same fixtures. No performance gain is assumed until measured.
- **Review points:** #73–#83 in the [static code review](docs/CODE_REVIEW_2026-10-30.md)
  name candidate hotspots to measure first: full thumbnail rebuilds, image
  re-decoding, repeated content parsing, history memory, whole-file autosave,
  synchronous search, eager stream decoding, canvas size, whole-page re-renders,
  bundle splitting and font loading.

### TASK-12 — Validate product priorities with users

- **Priority / effort:** P2 / medium. **Dependency:** Stabilize core flows first.
- **First step:** Run short, consented task walkthroughs with representative users
  covering open, edit, replace, save and reopen; treat target audience and pain
  frequency as hypotheses.
- **Acceptance:** Record task completion, observed friction and participant
  feedback without storing document contents; use evidence to prioritize later
  features and repeat critical accessibility scenarios with assistive technology.

## Static code review additions

These tasks come from the [static persona code review](docs/CODE_REVIEW_2026-10-30.md)
of 2026-10-30; `#n` refers to a point in that document. They use TASK-101
onward to avoid colliding with concurrent additions above. The review was
static, so reproduce each issue before changing it. Tasks are listed in
suggested order.

### TASK-101 — Harden parsing and rendering against malformed PDFs

- **Status:** In progress. Stray delimiters and malformed DER lengths now fail
  or advance within bounds; Form XObject cycles and nesting are bounded.
  Page-tree and reference cycles and revision chains are bounded and rejected.
  Xref parsing bounds cumulative entries and index ranges across revisions and
  recovery, and handles large offsets without 32-bit truncation. Image and JPEG
  pixel allocation and per-stage stream expansion have explicit
  bounds. Page, preview and transparency canvases now also have per-canvas
  limits. Worker failures and timeouts reject and replace the worker; aggregate
  memory, other canvas paths and real browser failure recovery remain open.
  Xref limits reject files with more than 250,000 declared entries or 16,384
  ranges, including otherwise valid files; trailer arrays are limited to 32,768
  elements. Cumulative xref stream work is limited to 32 MiB, each decode
  stage to 16 MiB, and each stream to eight filters. Failed stages are charged
  conservatively and may cause damaged files to be rejected before recovery.
  These compatibility limits require consideration for large PDFs.
- **Priority / effort:** P1 / medium. **Related:** [BUG-101](BUG.md#bug-101-stray-delimiters-can-stop-the-object-parser-from-advancing),
  [BUG-105](BUG.md#bug-105-the-form-xobject-recursion-guard-never-activates),
  [BUG-106](BUG.md#bug-106-negative-der-lengths-make-signature-parsing-loop),
  [BUG-145](BUG.md#bug-145-cross-reference-streams-can-exhaust-resources-or-truncate-offsets).
  **Review points:** #39–#43, #53.
- **First step:** Add failing fixtures for stray delimiters, self-referencing
  forms, negative DER lengths, cyclic page trees and `/Prev` chains; make each
  loop guarantee progress or stop at an explicit bound.
- **Progress:** Bounded subprocess tests exercise malformed object and content
  arrays, DER lengths and nesting. Renderer tests cover direct and mutual Form
  cycles, deep acyclic nesting and repeated placements. Existing parser and
  signature tests pass. Bounded subprocess fixtures also cover cyclic and deep
  page trees, reference chains and `/Prev` revisions. Iterative object parsing
  handles a 14,000-level internal fixture without stack overflow; qpdf checks
  pass for 32 and 100 levels, while its default limit rejects 14,000.
- **Acceptance:** Each fixture opens, renders or fails clearly within bounded
  time and memory. Decoders and canvas allocation respect explicit limits. A
  failed or hung worker is reported and replaced instead of re-running the same
  input on the main thread. Xref recovery handles truncated files and selects
  the newest revision.

### TASK-102 — Make saved files conform and preserve stream bytes

- **Status:** In progress. Fixed-length xref entries and Unicode text strings
  pass regression and independent-reader tests; tested indirect-length streams
  preserve bytes across save and reopen. Incremental trailers retain both `/ID`
  values across repeated saves; encrypted incremental writes are rejected to
  prevent plaintext leakage. Edited documents update existing ModDate, Producer
  and corresponding XMP values with the same timestamp, without creating missing
  fields or metadata. UTF-8 and UTF-16 XMP retain unrelated XML text; invalid,
  ambiguous, shared or unsupported metadata is rejected rather than rewritten.
  Signed documents retain their existing byte-preservation policy; security
  cleanup requiring a full rewrite and already-encrypted object graphs skip
  automatic updates. Quick saves publish metadata changes back to the live graph;
  optimized saves retain their existing isolated-staging behavior. Ten metadata
  regression cases cover worker and repeated incremental saves, UTF-16, malformed
  XML, cleanup, and encrypted reopening; pdf-lib and pdfinfo independently read
  the output. Related signature, encryption, worker and concurrency regressions
  pass. Sparse xref output is used for tested large object numbers; qpdf reads
  the catalog reference and target for a compatible example, while layouts it
  would silently discard are rejected. qpdf 12.4.2 checks pass for the tested
  generated fixtures; broader
  standards requirements remain open.
- **Priority / effort:** P1 / medium. **Related:** [BUG-102](BUG.md#bug-102-streams-with-an-indirect-length-are-cut-at-the-first-endstream),
  [BUG-103](BUG.md#bug-103-cross-reference-entries-are-written-as-21-bytes),
  [BUG-104](BUG.md#bug-104-literal-strings-above-u00ff-become-invalid-octal-escapes).
  **Review points:** #50, #52, #54, #56.
- **First step:** Add a parse, save and reopen test that compares raw stream
  bytes for indirect-length streams, and a test that each xref entry is 20 bytes.
- **Acceptance:** Untouched streams round-trip byte-identically; saved files pass
  `qpdf --check`; Unicode text strings round-trip; incremental trailers keep
  `/ID`. Saves update ModDate, Producer and XMP consistently, and editing a
  PDF/A or PDF/UA file warns instead of silently keeping its claim.

### TASK-103 — Remove unsafe security defaults and disclose network use

- **Status:** In progress. New encryption operations require explicit passwords;
  cryptographic random bytes require Web Crypto, and encryption stages changes
  atomically; protected incremental saves are rejected to prevent plaintext
  leakage. Document link opening restricts dangerous schemes and confirms other unrecognized schemes. The
  high-level timestamp flow checks response integrity, but TSA trust and
  revocation remain unverified. Other cryptography, network and storage
  requirements remain open. Password-authenticated PBES2 AES-CBC PKCS#12
  import verifies the MAC and key/certificate match; legacy encryption and
  unsupported or unprotected containers are rejected. Old stored custom-policy
  passwords are ignored, but not automatically deleted. Static CSP constraints
  and local visual-signature storage are documented in
  [SECURITY_PRIVACY.md](docs/SECURITY_PRIVACY.md). New signatures default to a
  session-only library with explicit device storage; existing stored entries
  remain unencrypted. No CSP is deployed or verified.
- **Priority / effort:** P1 / medium. **Related:** [BUG-107](BUG.md#bug-107-security-actions-can-encrypt-with-built-in-passwords).
  **Review points:** #9, #44–#49, #98.
- **First step:** Remove built-in passwords from policies and the encryption
  fallback; restrict link schemes where page links are listed.
- **Acceptance:** Encryption never uses a built-in password. Only http(s),
  mailto and tel links open without confirmation. Random bytes never fall back
  to `Math.random`. Timestamp tokens are validated before embedding. Encrypted
  PKCS#12 files import without advice to export plaintext keys. README and page
  metadata explain timestamp network use and the local OCR assets. A CSP for the static
  export and the storage of signature images are evaluated and documented.

### TASK-104 — Make touch and mobile editing usable

- **Status:** In progress. Pointer drawing, highlighting and erasing were
  tested with simulated touch in mobile Chrome, including rotated/cropped
  output. A selected library signature can be placed by tapping the page;
  mobile Chrome verified save/reopen, rotated/cropped placement and existing
  signature-field priority, while desktop Chrome verified drag and selection
  ([BUG-236](BUG.md#bug-236-tapping-the-page-does-not-place-a-library-signature)).
  The Sign options sheet can hide its close button while scrolling
  ([BUG-237](BUG.md#bug-237-the-mobile-sign-options-close-button-scrolls-out-of-view)).
  Real iOS/Android tests and other mobile tasks remain open. While a
  drawing tool is active, page-area pinch and scrolling are unavailable.
- **Priority / effort:** P1 / high. **Related:** [BUG-108](BUG.md#bug-108-drawing-highlighting-and-erasing-ignore-touch-drags).
  **Review points:** #4, #12–#20.
- **Next step:** Keep the mobile options close control visible while scrolling,
  then test the touch workflows on a real phone and tablet.
- **Acceptance:** On iOS and Android devices a user can draw, highlight, erase,
  place a signature, edit a line with visible Done and Cancel, fill a form
  field, fit the page to width, reorder pages and download. Tablet widths get a
  usable layout, and coarse-pointer targets are at least 44 px.

### TASK-105 — Give floating overlays a page identity

- **Status:** In progress. Text, images and signatures track their page and
  grouped saves preserve it; Chrome verified search navigation, two-page text
  and images, reorder, undo/redo and recovery. Legacy entries without page
  identity require explicit assignment; malformed signature page identity is
  preserved and blocks saving. Delayed-edit UI integration remains unverified.
- **Priority / effort:** P1 / medium. **Related:** [BUG-109](BUG.md#bug-109-floating-overlays-have-no-page-identity).
  **Review points:** #63.
- **First step:** Try to reproduce a wrong-page commit by creating an overlay and
  navigating through search, undo or a page operation.
- **Acceptance:** Overlays record their page, render only there and commit to
  it. One page-change helper serves every navigation path. Tests cover search
  navigation, undo and redo, and page operations with pending overlays.

### TASK-106 — Make form and text input behave predictably

- **Status:** In progress. Text and single-choice fields use recoverable drafts
  and commit as one history entry; composition and rapid button interactions
  have regressions. Chrome verified ordinary, protected and real signed recovery.
  Form edits refresh changed thumbnails, including shared fields; Chrome observed
  two redraws in a 12-page fixture and verified undo/redo. Snapshot budgets and
  unsafe states fall back to a full rebuild; browser testing of that fallback
  remains open. Multi-select editing preserves values, appearances and encrypted recovery
  in tested paths; a real IME-device check remains open. Grouped editing keeps
  independently painted segments and rejects unsupported low-level replacements
  ([BUG-171](BUG.md#bug-171-grouped-text-edits-can-lose-later-paint-styles));
  tested ActualText spans retain their extraction and paint order
  ([BUG-172](BUG.md#bug-172-actualtext-spans-can-hide-adjacent-text-or-change-paint-order)).
  Tested form flattening now preserves supported multi-stream page content for
  Poppler and pdf-lib. Editor parsing can differ for nonconforming tokens split
  between streams ([BUG-233](BUG.md#bug-233-page-content-split-inside-a-string-can-be-read-incorrectly)).
  Form flattening now preserves tested text and button appearances and refuses
  stale or unsupported appearances without changing the document
  ([BUG-230](BUG.md#bug-230-flattening-form-fields-can-discard-values-and-appearances)).
  Chrome also verified editing and flattening the CC0 form, independent
  inspection of the download, and undo restoring its fields and values.
  OCR now requests structured words from Tesseract and applies captured-page
  results through an undoable transaction; stale edits and unsupported page
  geometries are rejected ([BUG-221](BUG.md#bug-221-ocr-drops-words-returned-by-the-current-tesseract-engine),
  [BUG-222](BUG.md#bug-222-ocr-results-can-be-applied-to-the-wrong-page)).
  OCR insertion isolates tested page graphics state, avoids font-name conflicts
  and preserves inherited resources; multiple content streams, non-ASCII OCR
  words and precise word-width fitting remain unsupported
  ([BUG-224](BUG.md#bug-224-ocr-text-inherits-page-transforms-and-conflicting-fonts)).
- **Priority / effort:** P1 / medium. **Review points:** #3, #11, #59.
- **First step:** Commit form values on blur or Enter as one history entry, and
  ignore Enter while an IME composition is active.
- **Acceptance:** One form edit is one undo step without a full thumbnail
  rebuild; choice fields offer their options; IME input does not commit early.
  Checkbox and radio edits use the field's own on-state, update sibling widgets
  and keep existing appearances; an independent reader shows the same values.

### TASK-107 — Close PDF interoperability gaps

- **Status:** In progress. CID font advances now honor PDF `/W` and `/DW`
  metrics in tested fixtures, independently checked with Poppler. Unsupported
  image codecs display labelled placeholders while retaining source bytes.
  Inline image boundaries are verified for supported filters; unsupported
  inline formats are rejected. Tested default-hidden layers stay hidden across
  rendering, search and editing; complex View rules and hidden soft masks are
  rejected. Hidden/NoView flags, appearance matrix placement and `/AS`-selected
  appearance states are honored in tested paths; other annotation and
  extraction requirements remain open. Tested RC4-128, AES-128 and AES-256
  encrypted documents with compressed catalog/page objects now unlock and save;
  tested encrypted streams also resolve indirect `/Length` entries stored in
  object streams after authentication. Referenced object streams share a 32 MiB
  decode budget; other encrypted structures remain to be verified. Search can
  find text in tested nested Form XObjects in content-stream order; Poppler
  `pdftotext -raw` confirmed tested interleaved and repeated Form cases. Form
  matches are read-only and replacement refuses before changing the document.
  A closed, single-layer `/ActualText` span across a Form yields its logical
  replacement text; nested or unclosed spans are rejected. Search retains
  clipped text but constrains or suppresses Form highlights when their geometry
  cannot be shown safely. Direct and indirect Form Matrix/BBox geometry is
  rendered in the tested cases. Complex clipping, visual reading order and
  `/ActualText` geometry remain open. Tested text clipping and graphics-state
  transitions now follow the independent Poppler fixtures
  ([BUG-162](BUG.md#bug-162-text-rendering-ignores-some-valid-clipping-paths));
  tested isolated Alpha/Luminosity soft masks now preserve existing backgrounds;
  complex mask configurations remain unsupported
  ([BUG-165](BUG.md#bug-165-soft-masks-do-not-reliably-limit-painted-content)).
  Text clipping modes 4–7 support tested embedded simple TrueType outlines;
  complex fonts and ambiguous contours are rejected while text extraction
  remains available ([BUG-166](BUG.md#bug-166-text-clipping-modes-are-rendered-without-the-requested-clip)).
  Text stroke modes 1–2 use tested fill/stroke state, with unsupported
  transforms, Type3 glyphs and hairlines rejected
  ([BUG-168](BUG.md#bug-168-text-stroke-rendering-modes-are-drawn-as-fills)).
  A failed page render clears stale visual/editing state without discarding
  tested unsaved work ([BUG-167](BUG.md#bug-167-a-failed-page-render-can-leave-the-previous-page-visible)).
  Render status and the search panel now share a non-overlapping layout so retry
  remains clickable at tested mobile, tablet and desktop widths
  ([BUG-235](BUG.md#bug-235-search-can-cover-the-page-render-retry-control)).
- **Priority / effort:** P2 / high. **Review points:** #51, #55, #57, #58, #60, #61.
  Related to TASK-05 and [BUG-009](BUG.md#bug-009-extracting-or-splitting-pages-loses-acroform-structure).
- **First step:** Show a labelled placeholder for CCITT, JBIG2 and JPX images
  while keeping their streams unchanged; add an encrypted object-stream fixture.
- **Acceptance:** Encrypted PDF 1.5+ files with object streams open. Extraction
  does not pull in unselected pages and keeps applicable catalog entries.
  Default-off layers stay hidden. Annotation appearances follow the
  specification's placement rules. Unsupported fonts and image codecs are
  reported instead of rendered as noise.

### TASK-108 — Make the interface coherent and discoverable

- **Status:** In progress. Pages now exposes merge, current-page download,
  split and remove actions; desktop and simulated-mobile browser checks passed.
  Pending edit/form extraction and other visual, theme and user-study criteria
  remain open. Protected extraction retains supported passwords or rejects.
- **Priority / effort:** P2 / medium to high. **Review points:** #31–#37.
  Related to TASK-07 and TASK-12.
- **First step:** Expose the existing merge, split and remove-page handlers in
  the Pages panel, and give Insert tools a visible active state.
- **Acceptance:** Every implemented page operation has an entry point. Panels
  share semantic colour tokens and primitives. Dark mode follows the operating
  system and covers all overlays. Copy avoids PDF internals. First-run hints and
  a shortcut reference exist, and a TASK-12 walkthrough confirms the changes.

### TASK-109 — Strengthen test infrastructure and add end-to-end tests

- **Status:** Implemented and verified for the listed test-infrastructure scope.
  Vitest collects `.test.tsx`, and `npm test` in CI
  requires OpenSSL, qpdf and pdfsig instead of silently skipping their checks.
  Istanbul reports all production source files with enforced global thresholds;
  the measured baseline and ratchet are in [TEST_COVERAGE.md](docs/TEST_COVERAGE.md).
  A static-build Playwright suite covers the requested journeys and is included
  in the GitHub Actions workflow; a hosted run remains unverified.
- **Priority / effort:** P1 / medium. **Review points:** #84–#87, #91.
  Related to TASK-08 and TASK-09.
- **First step:** Report coverage at today's baseline, and add a shared helper
  that fails in CI when a required external tool is missing.
- **Acceptance:** Coverage is reported with ratcheting thresholds. Component
  tests in `.tsx` files are collected. Tests needing openssl, qpdf or pdfsig run
  or fail explicitly in CI and clean up temporary files. An end-to-end suite
  covers upload, edit, save, reopen, signing and a mobile layout on the static
  build.
- **Verification:** In an isolated subpath build, Chrome passed all eight
  scenarios, including supported cross-run replacement, rotated highlights and
  failed-render recovery. Poppler verified exported text and a temporary self-signed
  signature; the signature test does not establish certificate trust. See
  [the E2E instructions](tests/e2e/README.md) for prerequisites and commands.

### TASK-110 — Settle licensing, repository hygiene and the offline PWA

- **Status:** In progress. Added attribution, security reporting guidance and a
  font inventory with local license files and hashes, and aligned package name
  and license metadata. A reproducible inventory records the installed
  production packages' declared licenses; exact font release sources and
  dependency-license obligations remain partly unverified. The JP, KR and TC
  Regular assets were rebuilt from pinned official Noto CJK sources; their old
  binaries identified themselves as Thin despite the filenames. Unreferenced legacy assets
  were removed; the final subpath build, worker/base-path checks and offline
  Chrome editing passed. A scoped offline app shell is generated
  at build time and a subpath build was exercised offline in Chrome. Install
  prompts, other browsers and remaining repository hygiene remain open.
  The default English OCR worker, runtime and model are now bundled and cached;
  a fresh offline Chrome session recognized and saved a synthetic scan
  ([BUG-231](BUG.md#bug-231-ocr-cannot-initialize-offline)). The initial cache
  requires the prior online visit and roughly 47 MB of uncompressed assets.
- **Priority / effort:** P1 for attribution, SECURITY.md and clone instructions;
  P2 for the rest / medium. **Review points:** #38, #83, #93, #95–#97, #99,
  #100. Related to TASK-09 and [BUG-014](BUG.md#bug-014-the-documented-node-minimum-is-incompatible-with-the-locked-nextjs-version).
- **First step:** Add NOTICE and SECURITY.md, and point clone instructions at
  this repository.
- **Acceptance:** Upstream attribution and third-party licences are documented.
  Unused dependencies and public files are removed after build and test checks.
  Package metadata, engines and storage names identify Paperloom. Bundled fonts
  have a provenance manifest. A web manifest and service worker make the static
  build installable and usable offline, verified in a browser.

## Verification and status

Follow-up browser checks placed a synthetic visual signature and signed a PDF
with a synthetic self-signed RSA identity. Poppler independently rendered the
visual signature and reported the digital signature valid but its issuer
untrusted. This does not establish trusted-chain or revocation verification;
see [the audit](docs/UX_E2E_AUDIT.md) for remaining limits.
Synthetic image drag and replacement, with Undo/Redo, were also checked; Poppler
rendered the saved replacement at the expected position. Physical pointer and
touch interactions and broader document coverage remain unverified.
The follow-up device inventory found no accessible physical Android device;
native Chrome file-dialog control timed out before file selection could be
verified. A focused engine test verified explicit leaf pinning and tamper
handling, but the editor supplies no trust anchors and CA-chain/signing-time
validation is not implemented. External OpenSSL chain validation was only a
tooling control. See the audit before scheduling device or trust work.

### Remaining E2E acceptance work

- **Physical touch (TASK-104 / BUG-108):** Connect and authorize an actual
  device, record its model, OS and browser, then test drawing, highlighting,
  erasing, image manipulation, panel scrolling and dismissal. Verify saved
  output and distinguish touch behavior from simulated browser input.
- **Native file selection (TASK-109):** With the operating-system picker
  accessible, select a synthetic valid PDF and verify editor load; also check
  cancellation and invalid-file feedback without overwriting user documents.
- **GUI PDF reader (TASK-107):** Open Paperloom-generated synthetic form,
  image and signature PDFs in an independent graphical reader; record reader
  version, visible result and any field-value discrepancies.
- **Certificate trust (TASK-01):** Define and implement the intended CA-chain,
  signing-time and revocation policy before claiming a trusted-chain E2E pass.
  Test trusted, untrusted, expired and tampered fixtures without modifying the
  user's system trust store. Current pinned-leaf checks are narrower evidence.

These are open acceptance items, not failures newly reproduced in the latest
follow-up. Test against a stable, identified revision and record any remaining
environment limits in [the audit](docs/UX_E2E_AUDIT.md).

Tasks are proposals unless their status records completed work. The original
review was static; later task-specific verification is recorded with the task.
Reproduce the relevant issue before changing it, verify the
original scenario after a fix, and update the corresponding BUG.md status only
when its acceptance evidence is available.

The 2026-10-30 follow-up, including a 10-persona heuristic review and the
remaining end-to-end test matrix, is in [docs/UX_E2E_AUDIT.md](docs/UX_E2E_AUDIT.md).
The subsequent isolated-browser pass reproduced BUG-002, BUG-006–008 and
BUG-017; see the audit for successful checks and untested paths. Subsequent
TASK-02 work addressed BUG-002, with remaining limitations recorded above.
