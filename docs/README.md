# Documentation

Paperloom PDF is a browser-based editor backed by a TypeScript PDF engine. See
the [project README](../README.md) for setup and the [contributing guide](../CONTRIBUTING.md)
for development commands and test prerequisites.

## Guides

| Document | Contents |
| --- | --- |
| [PDF engine](ENGINE.md) | Engine invariants, editing, document sessions, history, export, and tests. |
| [Signature transaction design](SIGNATURE_TRANSACTION_DESIGN.md) | Signing transactions, unfinished ownership work, and acceptance criteria. |
| [PDF worker](PDF_WORKER.md) | Worker architecture and verification. |
| [Editor UI layers](UI_LAYERS.md) | Canvas and overlay stacking boundaries. |
| [Brand](BRAND.md) | Visual identity, design tokens, assets, and release checks. |
| [PWA baseline](PWA_BASELINE.md) | Baseline inventory and PWA-related invariants. |
| [Security and privacy](SECURITY_PRIVACY.md) | Static-host CSP assessment and local signature-storage limitations. |
| [GitHub Pages guide](DEPLOY_PAGES.md) | Deployment and sub-path verification guidance; see the deployment finding below before relying on its automation instructions. |
| [UX and end-to-end audit](UX_E2E_AUDIT.md) | 2026-10-30 browser checks, simulated UX perspectives, and the remaining end-to-end matrix. |
| [Static persona code review](CODE_REVIEW_2026-10-30.md) | 2026-10-30 read-only review: 100 points from ten personas, each mapped to a bug or task. |

## Bugs and backlog

[BUG.md](../BUG.md) is the defect register and [task.md](../task.md) is the
prioritized backlog. New findings belong there;
[Review findings awaiting verification](#review-findings-awaiting-verification)
preserves the earlier review as recorded.

## Engine entry points

`src/engine/index.ts` is the broad compatibility and test API. Browser product
code in `src/app` and `src/lib` imports through `src/engine/browser-core.ts`, an
explicit allowlist of browser-facing APIs. Add exports to that boundary
deliberately when the product needs them.

## Review findings awaiting verification

The following items preserve a bounded code review recorded on 2026-10-27, before
commit `074675b`. They are investigation leads, not an exhaustive audit or a
certification of current behavior. Most were based on static inspection; the
review did not reproduce the security exploits, encrypted recovery, OCR, or
deployment scenarios. Code has changed since the review, so recheck each claim
and its impact against the current implementation before relying on it, changing
its status, or designing a fix. The order reflects the original review's
priorities, not a newly verified risk ranking.

### Security and data integrity

1. **Signature verification:** `src/engine/signatures/validation/validation-engine.ts` may downgrade failed CMS verification to unknown and then treat it as valid when the digest matches. Check that failed verification cannot become a valid result and that unknown remains distinguishable from success.
2. **Signature digest:** `src/engine/signatures/crypto/signature-verify.ts` may treat a missing CMS message digest as a match. Check that validation requires evidence binding the signature to the document bytes.
3. **Signature coverage:** the validation engine checks byte-range bounds, but the review did not establish that the gap is exactly the signature contents or that the signed revision covers the displayed document. Check the gap and report subsequent revisions or unsigned content.
4. **Certificate trust:** the validation engine can allow self-signed certificates, and the editor enables that option. Verify that the UI distinguishes cryptographic validity from trust in the signer's identity.
5. **Initial password encryption:** `src/engine/security/encryption/encrypt-pipeline.ts` may leave strings in stream dictionaries or standalone indirect objects unencrypted. Verify coverage of eligible PDF object shapes.
6. **Edits after applying encryption:** the encryption and save paths may lack the context needed to encrypt later edits. Verify that newly written objects remain protected after changes and subsequent saves.
7. **Action sanitization:** `src/engine/security/javascript/javascript-engine.ts` may omit dangerous actions reachable through `/Next`. Verify safe traversal and removal of chained actions.
8. **Attachment removal:** `src/engine/security/embedded-files/embedded-file-engine.ts` may miss `/AF` associations or direct file annotations. Verify removal of supported reachable attachment references and their contents.
9. **Public-key open and save:** `src/engine/security/public-key/public-key-engine.ts` may decrypt without retaining the state required for re-encryption. Check round-trip confidentiality and readability for API consumers; the original review did not establish an editor UI caller.
10. **Secure redaction:** `src/engine/security/redaction/redaction-engine.ts` leaves intersecting vector paths in place while removing redaction marks. Verify whether outlined text or graphics remain recoverable. The review did not establish an editor UI caller.
11. **Protected-document recovery:** `src/app/editor/page.tsx` stores recovery overlays in IndexedDB. Verify whether additions to an unlocked encrypted PDF can be recovered from local storage without its password.
12. **Encrypted autosave restoration:** the editor may skip an encrypted saved session and reopen the original upload. Verify recovery after reload and authentication, including pending overlay changes.

### Functionality and accessibility

13. **OCR output:** `src/lib/ocr/adapter.ts` reads `result.data.words`, while the review found that Tesseract 7 exposes words under blocks and disables blocks by default. Verify the requested output format and extraction of recognized words.
14. **OCR worker lifecycle:** the editor creates an OCR adapter for each action; verify that its worker is terminated on both success and failure.
15. **Recovery after download:** a previous recovery session may survive a newer download made before autosave completes. Verify that reload does not prefer stale recovery data.
16. **Fallback font names:** `src/engine/fonts/symbol-fallback.ts` may reuse existing `DingAug` or `SymAug` resources without confirming their font. Verify that collisions cannot change exported glyphs.
17. **Keyboard upload:** the home-page drop zone was observed as a clickable, non-focusable element. Verify that keyboard users can focus and activate a named upload control with Enter and Space.
18. **Pages deployment:** [the deployment guide](DEPLOY_PAGES.md) describes an Actions workflow and smoke job, while the reviewed checkout had no `.github` directory. Verify the deployment mechanism before following the guide.
19. **Node prerequisite:** the project README states Node 18 or newer, while the reviewed Next.js dependency declares Node 20.9 or newer. Verify the supported minimum and align the documentation with it.

### Original review limits

The review combined four bounded code reviews. It inspected the home page at
desktop and mobile viewport sizes and checked keyboard focus; the editor was
not exercised in that environment because the development page did not hydrate.
The review checked installed Tesseract defaults and the Next.js engine requirement,
but did not test other browsers or full accessibility. Later testing of other
editor workflows does not by itself resolve these findings. A knowledge-base
write was attempted during the review but was not confirmed.
