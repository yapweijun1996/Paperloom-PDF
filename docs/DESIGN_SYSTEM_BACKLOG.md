# SSOT design system backlog

Generated 2026-11-02 from a 23-persona read-only review of the UI. Batches are ordered by dependency; each ships as its own commit to main with tsc, vitest, eslint, build and e2e green. TASK-108 in task.md tracks the acceptance criteria.


I re-checked these claims in the repo:
- `useEditorSession` (zustand) has no importers.
- Only `@radix-ui/react-dialog` and `react-tooltip` are imported. Dropdown-menu, popover, select, slider and tabs are installed but unused.
- `.bloom-btn-primary` has no users.
- No `prefers-color-scheme` rule exists anywhere in `src`.
- `data-theme="dark"` is set inside 3 components, and `tests/e2e/render-failure.spec.mjs:91` finds the Find panel by that attribute.
- `.github/workflows/ci.yml` and 25 e2e specs exist, so the MEMORY note that says "no CI, e2e" is out of date.
- There are 10 `window.alert/confirm` calls.
- The tool-icon gradient ids are fixed strings, and each icon is drawn in two places (`ToolsSidebar.tsx:107`, `:184`).
- The keyboard map has keys `a` and `l` that `TOOLS[].shortcut` does not list.

Every batch is one or more commits to main. Before each push, run the full CI check locally (tsc, vitest, eslint and e2e). This matters because a push to main deploys straight to Pages.

## Batch 0 — Guardrails and process (no UI change)
- **Run a CI-equivalent check locally before every push** (P0, S) — a push to main auto-deploys to GitHub Pages, so a red push breaks the live editor. — `.github/workflows/deploy-pages.yml:3-6,36,77`; `ci.yml:36-40` — 23 (1)
- **Agree the freeze list** (P1, S) — no changes to engine code; to document and content colours (ink defaults, swatches, canvas ctx, cursor SVGs, export SVG); to the `zLayers` scale; to the theme storage key; or to signature-lock behaviour (commits 5e5f67e, 14601cc, e4cd513). The signature dialogs only get restyled. — `src/engine/**`, `layout.tsx:32`, `page.tsx:5869-5877`, `export-formats.ts:186` — 23, 3, 21 (3)
- **Stop e2e tests from depending on styling hooks before any panel moves** (P0, S) — the Find panel is located through `[data-theme="dark"]`, and some specs locate elements through `.signature-touch-panel` or `locator('..')`. Switch them to role, label or `data-*` hooks first. — `render-failure.spec.mjs:91,93`; `signature-touch-targets.spec.mjs:47,72,113,125…`; `signature-placement.spec.mjs:179-199` — 10 (1)
- **Pull the className AST walker out of the zLayers guard into a shared test helper** (P1, S) — the colour, primitive and dialog guards all need the same branch expansion. — `zLayers.guard.test.ts:10-47,82-90` — 9, 1, 3, 7, 8, 17, 22, 23 (8)

## Batch 1 — Remove duplicate values inside globals.css
- **Point `.checkerboard` at `--checker-a/b`, `.mobile-backdrop` at `--scrim`, and `.bloom-btn-primary` text at `--contrast`/`--on-accent`; delete their `[data-theme=dark]` copies** (P1, S) — the file that owns the tokens should not hard-code its own values, and the hex values have already drifted from the tokens. — `globals.css:166-178,191,221-227` vs `:28-31,49-53` — 1, 5, 6, 7, 8, 9, 11, 13, 16, 17, 23 (11)
- **Use one naming scheme for colour utilities** (P1, S) — `@theme` generates aliases nobody uses (`text-app-text`, `border-border`, `bloom-brand`, `canvas-bg`), while hand-written `.bg-panel`/`.text-app` utilities duplicate it. Keep one and delete the other. Either keep `.bloom-btn-primary` for the Button primitive or remove it. — `globals.css:57-80` vs `:180-198` — 8, 7 (2)
- **Fix the shared tool-icon gradient ids with `useId()`** (P1, S) — this is a real rendering bug. Each icon is drawn twice, so ids are duplicated, and if the first copy is hidden the visible icon renders with no fill. — `EditorToolIcons.tsx:15,49,89,…`; `ToolsSidebar.tsx:107,184` — 21 (1)

## Batch 2 — Semantic token layer
- **Add `danger`/`warning`/`success`/`info` tokens (bg/fg/border), defined in `:root` and dark, exposed through `@theme`** (P0, S) — there is no theme-aware slot for status colours today. Success must look different from the jade brand colour. — `globals.css:3-80` has none; red-400/emerald/amber are scattered (`PasswordDialog.tsx:68`, `SecurityPanel.tsx:362-373`, `ExportPanel.tsx:427`) — 1, 2, 4, 5, 7, 8, 12, 13, 17, 22 (10)
- **Add `--focus-ring` and `--on-accent` tokens; finish the dark bloom ramp** (P1, S) — dark mode redefines only `--bloom-100`. — `globals.css:36-55` — 1, 4, 15 (3)
- **Fix the contrast of `--text-faint`, `--text-muted` on `--surface`, and input borders** (P1, S) — these fail WCAG 1.4.3 (text contrast) and 1.4.11 (UI component contrast). — `globals.css:21-26,46`; `ThumbnailsSidebar.tsx:254,265,292` — 4 (1)
- **Add a token test: every token is defined in both themes and mapped in `@theme`, and listed fg/bg pairs meet contrast** (P1, S) — `globals.css` light/dark blocks — 9, 4 (2)
- **Add type, radius and elevation scale tokens and a CJK font fallback** (P2, M) — text sizes are arbitrary pixel values (`text-[10px]` ×102, `[11px]` ×76, `[9px]`, `[10.5px]`), radius has 7 sizes and shadow has 7 sizes. The font stack has no CJK fallback. — `globals.css:139` font stack has no CJK — 7, 8, 19, 6 (4)

## Batch 3 — Dark mode follows the OS (its own commit)
- **Add a "system" mode: when the user has no stored choice, follow `prefers-color-scheme` and listen for changes. The inline boot script, `resolveInitialTheme` and `ThemeProvider` should share one resolver** (P1, S) — this is required by TASK-108 acceptance. — `layout.tsx:28,32`; `initialTheme.ts:4`; `ThemeProvider.tsx:22,53` — 1, 5, 18, 20, 23 (5)
- **Add `viewport.themeColor` for light and dark, and take the manifest colours from the brand tokens** (P2, S) — `layout.tsx:8-20` sets no themeColor; `scripts/prepare-pwa.mjs:22` hard-codes `#ffffff` — 20 (1)

## Batch 4 — Ratchet tests and visual safety net
- **Add a per-file count of raw palette classes (zinc/red/amber/emerald/orange/blue, `bg-white`/`text-black`, `bg-black/N` scrims, `data-theme=` set inside components, `z-[N]`). The count may only fall** (P0, M) — it only scans className strings, so content colours stay out. — about 408–440 raw palette hits — 1, 2, 3, 5, 7, 8, 9, 13, 16, 17, 22, 23 (12)
- **Add a `globals.css` guard: no hex or rgba outside the token blocks** (P1, S) — 9 (1)
- **Add light and dark Playwright projects, screenshot baselines of the chrome (canvas masked) for overlays still to migrate, and a computed-colour check that each overlay's background tracks `--panel`** (P1, M) — no spec uses `toHaveScreenshot` today, and `playwright.config.mjs:7-29` has no projects. — 5, 10, 13, 23, 3 (5)

## Batch 5 — Shared primitives in `src/app/editor/ui/`, no call-site changes (one commit per primitive group)
- **Dialog on Radix: Overlay uses `--scrim` and `Z_LAYERS`; Title and Description; focus trap, Escape and focus return; content mounts only while open. Add ConfirmDialog on top of it** (P0, M) — there are 4 dialog patterns today (Radix; the hand-made div in `PasswordDialog.tsx:36`; the hand-rolled trap in `ExportPanel.tsx:104-122,202-210`; the inline modals at `page.tsx:7527,7552`), and the scrims differ. — 2, 3, 4, 12, 13, 14, 15, 16, 17 (9)
- **Button and IconButton with variant (primary/secondary/ghost/danger), size and loading. IconButton requires `aria-label`, has a 24px minimum (44px on coarse pointers), and shows a visible tooltip** (P1, M) — about 172 copy-pasted `<button>` class strings; primary buttons currently come in orange, emerald and jade. — `LinkPopover.tsx:90`, `PropertiesSidebar.tsx:1518`, `SignatureCreateDialog.tsx:461` vs `CertificateImportDialog.tsx:176` — 2, 3, 4, 6, 7, 14, 17, 19 (8)
- **Field, TextInput, Select, NumberInput, ColorField, RangeField and SecretInput** (P1, M) — Field wires labels with `useId`/`htmlFor` and sets `aria-invalid`/`describedby`. SecretInput sets `autoComplete`, turns off spellcheck, and adds a secret textarea variant for PEM. Field builds on `FormDraftInput`. — `PropertiesSidebar.tsx:457-470,587-597`; `UnassignedOverlays.tsx:32`; `CertificateImportDialog.tsx:164-194`; `autoComplete` appears nowhere — 2, 3, 12, 17, 22 (5)
- **Notice/FieldError with tone set by the semantic tokens and role=status or role=alert** (P2, S) — `FieldRenameNotice`/`PdfConformanceNotice` do the same job, and errors use five different red styles. — 2, 12, 22 (3)
- **MobileSheet/Drawer with backdrop, `role=dialog`, safe-area padding and an elevation token; also turn on `viewportFit: 'cover'`** (P1, M) — the sheet markup is copy-pasted in `PropertiesSidebar.tsx:311-325`, `SecurityPanel.tsx:169-173` and `ThumbnailsSidebar.tsx:217-226`, and no viewport export exists. — 6, 17 (2)
- **Every primitive gets a happy-dom test that covers role, Escape, focus and variant classes, and checks that `title`/`aria-label`/`data-*` are passed through (selector contract). Variant classes come from static maps** (P1, M) — follow the `UnsavedChangesDialog.test.ts` pattern. — 9, 10, 11 (3)
- **Unused Radix packages: either wrap select/popover/dropdown-menu as primitives or remove them** (P2, S) — `package.json:29-35` — 2 (1)
- **Docs: `ui/README.md`, a "Building editor UI" section in `CONTRIBUTING.md`, and a components and states section in `BRAND.md`** (P1, S) — 16, 1, 23 (3)
- **After the primitives land, add a guard that counts native `<button>`/`<input>`/`<select>` and `type=password` outside `ui/`. The count may only fall** (P2, S) — 9, 12, 22 (3)

## Batch 6 — Overlay migrations (one component per commit; write a characterization test first)
Status (Batch C): done except the mobile-sheet item. PasswordDialog moved in Batch B. Added `TextArea` (secret mode), `useConfirm` and `Notice live`. `document-link.ts` keeps its injected `confirm` on purpose: it is a synchronous security gate before opening an external application link, with its own tests. SecurityPanel stays `w-72` (288px); the properties sidebar is `w-64`, so no 319px panel width exists to match.
- **PasswordDialog: move to Dialog + SecretInput (`current-password`) + Notice** (P1, S) — it has no `role` or `aria-modal`. — `PasswordDialog.tsx:36-68` — 4, 12, 13, 15, 16 (5)
- **FindReplacePanel: remove the in-component `data-theme="dark"` and use tokens** (P1, S) — `FindReplacePanel.tsx:51,78` — 1, 5, 13 (3)
- **ExportPanel: move to Dialog and tokens; drop its own focus trap** (P1, M) — `ExportPanel.tsx:202-218,333,403-427` — 1, 5, 13, 16 (4)
- **LinkPopover: use tokens and the jade accent instead of orange and zinc-100** (P1, S) — `LinkPopover.tsx:70,75,90,106-122` — 5, 7, 13 (3)
- **CertificateImportDialog and SignatureCreateDialog: tokens and Dialog, restyle only** (P2, M) — `CertificateImportDialog.tsx:131-207`; `SignatureCreateDialog.tsx:236,244` — 1, 5, 12, 13 (4)
- **page.tsx inline watermark modals, toasts and error banner: move out into components that use Dialog/Notice** (P1, S) — `page.tsx:7489-7552` — 3, 6, 17 (3)
- **Replace `window.alert/confirm` (10 calls) with ConfirmDialog or inline disabled states, and use one wording for delete-page** (P1, M) — `page.tsx:5629-6308`; `ThumbnailsSidebar.tsx:438-442` — 14 (1)
- **SecurityPanel redaction: style every irreversible action as danger and add a confirm step for page and marks redaction** (P2, M) — `SecurityPanel.tsx:150-156,350-373` — 12 (1)
- **Mobile sheets (PropertiesSidebar, SecurityPanel, ThumbnailsSidebar) onto MobileSheet; 44px close targets** (P1, S) — 6 (1)

## Batch 7 — Remaining chrome migrations
- **Split PropertiesSidebar into one section component per tool (props unchanged, render test per section), then migrate each section to the primitives** (P1, M) — 1837 lines; each tool branch is at `:342-:1466` — 3, 13, 16, 18 (4)
- **Toolbar, ToolsSidebar and EmbeddedImageOverlay: `bg-[var(--border)]` becomes `bg-border`, `#3b82f6` becomes accent, add `aria-keyshortcuts`** (P2, S) — `Toolbar.tsx:105-226`; `EmbeddedImageOverlay.tsx:253-305` — 8, 15 (2)
- **Replace remaining `z-[N]` with `Z_LAYERS`, `text-[Npx]` with type tokens, and bare `outline-none` with the focus ring** (P2, M) — 2, 4, 7, 8, 15, 17, 19 (7)
- **Icon SSOT module and size scale; tool icons use currentColor/accent and `aria-hidden`; replace the inline SVG at `page.tsx:7430` with `PanelLeft`** (P2, M) — `EditorToolIcons.tsx:16-35` — 21 (1)
- **Floating controls and toasts: a bottom-offset scale tied to the tool strip and safe area** (P2, M) — `page.tsx:7427,7489`; `globals.css:97,128` — 6 (1)

## Batch 8 — State, keyboard and large-file splits
- **Delete the orphaned zustand store and the zustand dependency** (P1, S) — this was checked: nothing imports it. — `store/editorSession.ts` — 18 (1)
- **Make TOOLS the only source for shortcut keys; fold the duplicate undo/redo listener into `editorKeyboardAction`; add a shared `isEditableTarget` that covers SELECT and contenteditable** (P1, M) — `keyboard-actions.ts:70-75` vs `types.ts:23-30`; `page.tsx:3129,5811-5865` — 15 (1)
- **A `useEditorOverlays` hook owns which overlay is open, together with `usePanelLayout`** (P2, M) — `page.tsx:207,273,413,512,526,553,556` — 18 (1)
- **Feature hooks (draw, watermark, text style) feed the sidebar sections; stable callbacks plus `React.memo` on PropertiesSidebar and ThumbnailsSidebar** (P2, L) — `page.tsx:395-472,6191-6460` — 3, 11, 18 (3)
- **Move the page.tsx render tree last (EditorShell, CanvasViewport, a single ThumbnailsSidebar mount); pointer and IME handlers stay in place** (P2, L) — 7599 lines; mounted twice at `:7357`/`:7437` — 3, 11, 16 (3)
- **Shortcut reference panel opened with `?`, built from the registry** (P3, M) — this is a TASK-108 acceptance item. — 15 (1)
- **Update the TASK-108 status and docs in the same commit as each batch** (P3, S) — `task.md:918-931` — 13, 16, 23 (3)

## Out of scope / rejected
- Treating document and content colours (ink defaults, user swatches, canvas ctx overlays, 3D cursor SVGs, export SVG) as theme chrome: rejected.
- Deferred to separate backlogs: the full i18n strings module, locale number/date helpers, the copy SSOT, and the overflow and uppercase rules for CJK beyond the defaults built into the primitives. Not needed for TASK-108.
- PWA runtime work (service-worker update prompt, offline indicator, surfacing registration failures): a separate PWA task, not the design system.
- Performance extras (CSS size budget, `next/dynamic` lazy-loading beyond open-gated Dialog mounting, pulling high-frequency state out of EditorPage): defer until after migration and measure first.
- Drag-to-dismiss on the sheet handle: either drop the decorative handle in MobileSheet or defer.
- A guard test against a second state container: rejected as over-engineering once the orphaned store is deleted.
- Restructuring TASK-108 itself, and the user-study criterion: tracking and product work, not engineering batches.
- Moving the `.signature-touch-panel` CSS into a layer: P3, and only with signature e2e coverage, because it is under the freeze.
- A mass Button/Input migration of page.tsx before the overlay batches: rejected on sequencing.