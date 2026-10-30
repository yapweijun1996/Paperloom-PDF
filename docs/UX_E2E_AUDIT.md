# UX and end-to-end audit — 2026-10-30

## Scope and evidence

Local development build at commit `d7a2f90`, with pre-existing uncommitted
changes. This is a partial audit, not a complete end-to-end certification.
Ten simulated personas are analytical viewpoints, not interviews or feedback
from actual users. Existing findings and priorities remain in [BUG.md](../BUG.md)
and [task.md](../task.md). No production deployment was tested.

## Checks

The later targeted pass also ran against a changing, uncommitted local working
tree. Its results apply to the observed build and should be repeated after the
concurrent changes settle.

| Journey or check | Result | Evidence and limits |
| --- | --- | --- |
| Home page load | Pass | Local Chrome displayed the upload page. |
| Keyboard upload | Fail | First Tab focused Next.js Dev Tools; hidden file input and drop zone did not expose an upload control in the accessibility tree. [BUG-011](../BUG.md#bug-011-the-upload-entry-point-is-not-keyboard-accessible). |
| Mobile home layout | Partial pass | At 390 × 844 emulated touch viewport, document and body widths were 390px; no horizontal overflow and no console warnings/errors were observed. No physical device test. |
| Upload and editor journeys | Partial | Browser file-path upload was denied by tool configuration. A synthetic `File` and `DataTransfer` dispatched through the input change handler loaded two- and three-page PDFs in isolated Chrome contexts. This bypasses the native picker. |
| Encrypted PDF | Partial pass | Repository AES-128 fixture: wrong password produced `Incorrect password`; correct test password opened its one-page document. Cancel, recovery, and save of encrypted documents remain untested. |
| Search and replace | Fail | Four matches on two pages became two after one Replace; Undo stayed disabled; previous-page navigation stayed on page 2. See BUG-006–008. |
| Dirty close and recovery | Fail | Close returned home without confirmation; direct editor navigation returned to home without restoring the synthetic document. BUG-002. |
| Insert, rotate, undo, redo, save and reopen | Partial pass | Blank-page insertion changed 3 pages to 4; Undo and Redo restored 3 and 4. The PDF download Blob reopened in pdf-lib with 4 pages; after rotating page 2, its rotation was 90 degrees. Another two-page case reopened in Paperloom after insertion as 3 pages. OS download and content fidelity beyond page count and rotation remain untested. |
| Text export ranges | Mixed | Valid pages 1–2 produced an 80-byte Blob with both page texts. Reversed 3–1 produced a zero-byte Blob with a success message. BUG-017. |
| SVG export | Fail | Exported SVG Blob contained an embedded PNG and no text for the tested synthetic page; labelled `SVG Vector`. BUG-013. |
| PNG export | Fail | At DPR 2, a 300 × 400 pt page exported at 72 DPI decoded to 600 × 800 pixels; PNG signature was valid. BUG-018. |
| JPEG export | Fail | Retry produced a valid JPEG Blob but at 600 × 800 pixels for a 300 × 400 pt page at 72 DPI and DPR 2; same resolution mismatch as PNG (BUG-018). OS download and visual fidelity were not checked. |
| Image editing | Partial pass | Numeric resize, Undo/Redo and Paperloom reopen preserved a synthetic image's 240 × 240 pt dimensions. A separate synthetic pointer drag moved an image from X=100/Y=400 to X=150/Y=370 while preserving 160 × 160 pt; replacement with a blue PNG updated canvas and thumbnail, Undo restored red and Redo restored blue. Poppler 25.04.0 independently rendered the saved blue image at the expected location. Synthetic file and pointer events were used; native interaction, other readers and deletion remain untested. |
| Forms | Mixed | Retry with synthetic hierarchical text, checkbox and dropdown fields: edited text `Bob` and choice `Two` survived save and independent pdf-lib reading. Checked checkbox reopened as checked in Paperloom but pdf-lib read it unchecked; repeated output showed widget `/V /Yes` and `/AS /Yes`, with no parent `/V` (BUG-020). Other readers and field types remain untested. |
| Signatures | Partial pass | A typed visual signature was saved to the library, persisted after reload, and was placed using synthetic drag/drop. Poppler 25.04.0 rendered the downloaded signature; pdfsig reported no digital signature, as expected for a visual signature. Separately, a synthetic self-signed RSA PEM identity produced a signed PDF; pdfsig reported a valid SHA-256 detached signature covering the file, with an untrusted issuer as expected for a self-signed certificate. Native drag, OS download, trusted certificate chains, revocation and other viewers remain untested. |
| Mobile editor | Partial | At 390 × 844, pages panel opened and document width stayed 390px. Options and Export opened and closed; the export heading and action were within the viewport. In a three-page follow-up, the pages drawer scrolled to its bottom, the third thumbnail and drawer heading remained visible, and a synthetic click on the backdrop closed it. No console errors were observed in that pass. Export close was unnamed in the accessibility tree (BUG-019). Physical touch, focus return, other scroll positions and panels remain untested. |
| Browser console | Warning | Development compilation emitted a harfbuzzjs top-level-await target warning. The tested encrypted document opened; compatibility across browsers has not been established. |
| Native file picker | Incomplete | A synthetic PDF and a separate `127.0.0.1` Chrome origin were prepared. After activating the upload area, the computer-use bridge timed out while accessing the Chrome native window; selection and editor load were not verified. Escape returned to the page. No conclusion about the product picker is supported. |
| Physical touch device | Not tested | An authorized device inventory found no connected Android device; the available USB inventory was empty and Apple device tooling was unavailable. This does not prove no device exists; no physical touch interaction was observed. |
| GUI PDF reader | Not tested | Attempting to access macOS Preview through computer-use did not return a usable window. No Preview open/render result was observed. Prior Poppler CLI checks remain independent renderer evidence, not GUI reader testing. |
| Trusted certificate validation | Limited | The editor passes no trust anchors, and the engine supports pinned signer-leaf fingerprints rather than CA-chain or signing-time trust. The focused synthetic test passed for pinned, unpinned, unknown-revocation and tampered cases; an external OpenSSL temporary CA-chain check passed, but does not prove Paperloom validates chains. No system trust changes were made. |
| Existing unit/integration suite | Pass with limits | `npm test`: 114 files passed, 1,330 tests passed, 1 skipped. `qpdf` was unavailable, so external encryption assertions were skipped. Radix emitted dialog description warnings. |
| Browser boundaries | Pass | `npm run verify:browser-only` and `npm run verify:browser-core`. |
| PDF worker artifact | Limited | `npm run verify:pdf-worker` passed against existing `out/`, not a fresh build of this working tree. |
| Automated E2E suite | Not available | No project E2E script, configuration or suite was found in this checkout. |

## Ten simulated reviewer perspectives

| Persona | Priority and observation | Evidence status |
| --- | --- | --- |
| First-time keyboard user | Reach and activate upload with Tab, Enter and Space. | Browser-confirmed failure; BUG-011. |
| Screen-reader editor | Identify each tool and its selected state. | Chrome accessibility tree confirms unnamed desktop tool buttons; BUG-016; actual screen-reader interaction pending. |
| Keyboard page organizer | Select and reorder thumbnails without drag. | Static lead: [ThumbnailsSidebar.tsx](../src/app/editor/components/ThumbnailsSidebar.tsx#L342); browser verification pending. |
| Mobile touch user | Discover page actions and use sufficiently sized controls. | Static lead: thumbnail actions depend on hover; test touch and tablet before severity assignment. |
| Export user | Know which formats exist and whether SVG is vector. | Existing source finding BUG-013; output inspection pending. |
| Busy document editor | Replace one match, undo and navigate without surprises. | Browser reproduced BUG-006–008 in the tested scenario. |
| Privacy-conscious user | Avoid losing unsaved changes on close and understand recovery. | Browser reproduced dirty-close loss of recovery; clean-close remains untested. BUG-002. |
| Form-heavy office worker | Preserve fields when extracting, splitting or merging. | Existing source findings BUG-009–010; verify output in independent reader. |
| User of password-protected PDFs | Understand and operate the password prompt with keyboard and assistive technology. | Static lead: [PasswordDialog.tsx](../src/app/editor/components/PasswordDialog.tsx); verify focus, semantics and recovery. |
| Signature user | Distinguish verified, unknown and failed signatures. | BUG-001 and TASK-01 record prior scoped evidence; recheck current working tree and independent fixtures before release. |

## Additional verification leads

- Export panel: inspect dialog semantics, close-button name, field labels and
  focus restoration. Reversed range is confirmed in BUG-017. Source leads are
  in [ExportPanel.tsx](../src/app/editor/components/ExportPanel.tsx).
- Signature creation and certificate import tests emitted Radix warnings for
  missing dialog descriptions. Check actual accessibility tree and focus flow.
- Thumbnail delete/rotate controls use hover visibility; verify keyboard focus,
  touch discoverability and narrow viewports before classifying impact.

## Remaining end-to-end matrix

Record revision, viewport and expected/actual result, and check saved outputs
by reopening them. The checks above are bounded examples; remaining coverage includes:

1. Upload valid/invalid/encrypted PDF; password failure and recovery.
2. Select, edit text and images, annotate, undo/redo, save and reopen.
3. Search single/all replacement and page navigation; test dirty close/recovery.
4. Insert, reorder, delete, extract, split and merge pages with form fixtures.
5. Forms, signatures, security actions, export formats and page ranges.
6. Desktop and mobile panels, overlays, scrolling, keyboard focus and dismissal;
   test touch and assistive technology, and inspect console errors.
7. Fresh webpack build, worker/base-path checks and deployed smoke if requested.

Parts of these journeys remain untested except as recorded above or in the
individual bug or task. Do not interpret the unit-suite result as E2E coverage.
