# Editor UI primitives

Shared building blocks for editor chrome. Import from `src/app/editor/ui`
(the `index.ts` barrel). Colours come from the theme tokens in
`src/app/globals.css`; see `docs/BRAND.md` for the token tables and contrast
rules, and `docs/UI_LAYERS.md` for the stacking scale.

## Components

| Component | Purpose | Key props | Accessibility contract |
| --- | --- | --- | --- |
| `Dialog` | Modal dialog (Radix) | `open`, `onOpenChange`, `title`, `description` (both required), `icon`, `dismissible` (default `true`), `size` (`sm` \| `md` \| `lg`) | `role=dialog`, `aria-modal`, labelled by title and described by description; focus trap; focus returns to the element focused before opening; Escape and outside click close unless `dismissible={false}`; content mounts only while open. Overlay uses `bg-scrim` at `Z_LAYERS.modalBackdrop`, content at `Z_LAYERS.modal`. |
| `DialogFooter` | Right-aligned action row | `div` props | Put it inside the `form` when the dialog submits. |
| `ConfirmDialog` | Two-choice confirmation | `open`, `title`, `message`, `onConfirm`, `onCancel`, `confirmLabel`, `cancelLabel`, `tone` (`default` \| `danger`), `busy` | Cancel is first and receives focus; Escape/outside click call `onCancel`; `busy` disables both actions, shows a spinner on confirm and blocks dismissal. |
| `useConfirm` | Promise-based `window.confirm` replacement | returns `{ confirm, dialog }`; `confirm({ title, message, confirmLabel, cancelLabel, tone })` | Render `dialog` once. Resolves `true` on confirm, `false` on cancel, Escape, outside click, a newer request or unmount. Re-check any index or page key after the await. |
| `Button` | Text button | `variant` (`primary` \| `secondary` \| `ghost` \| `danger`), `size` (`sm` \| `md`), `loading`, native button props | Defaults to `type="button"`. `loading` shows a spinner, sets `aria-busy` and disables. 44px minimum height under `(pointer: coarse)`. `data-variant` is exposed. |
| `IconButton` | Icon-only button | `aria-label` (required by type), `icon`, `tooltip`, `tooltipSide`, `variant`, `size`, `loading` | Visible tooltip on hover and keyboard focus (defaults to `aria-label`), 24px minimum and 44px under a coarse pointer; icon is `aria-hidden`. |
| `Field` | Label, hint and error for one control | `label`, `hint`, `error`, `id` | Generates the control id with `useId` (or uses `id`), wires `htmlFor`, `aria-describedby` (hint, error) and `aria-invalid`; the error is `role=alert`. |
| `TextInput`, `NumberInput`, `Select` | Native controls styled with tokens | native props | Read their wiring from the surrounding `Field`; explicit props win. `NumberInput` is `type=number` with `inputMode="decimal"`. `Select` is a native `select`. |
| `TextArea` | Multi-line text control | native props, `secret` | Reads Field wiring like the other controls. `secret` sets `spellCheck=false`, `autoComplete="off"` and turns off autocapitalise and autocorrect, for pasted keys and certificates. |
| `SecretInput` | Password input | `autoComplete` (required: `current-password` \| `new-password` \| `one-time-code` \| `off`) | `type=password`, `spellCheck=false`, no autocapitalise or autocorrect. |
| `Notice` | Inline status message | `tone` (`info` \| `success` \| `warning` \| `danger`), `title`, `live` (default `true`) | `role=status`, or `role=alert` for `danger`; `live={false}` drops the role for a notice announced elsewhere. Uses the `-soft` fill with its foreground token. |
| `MobileSheet` | Bottom sheet (Radix) | `open`, `onOpenChange`, `title` (required), `description`, `closeLabel` | Portalled to `document.body`; `role=dialog`, `aria-modal`, focus trap and return; Escape, backdrop click and the 44px close button close it. `--backdrop` at `Z_LAYERS.drawerBackdrop`, panel at `Z_LAYERS.drawer`, safe-area bottom padding, body scrolls within `max-h-[85dvh]`. |

Every primitive passes `title`, `aria-*` and `data-*` attributes through to its
main element, so e2e selectors can rely on them.

## Rules

- Token classes only. No raw Tailwind palette classes (`bg-zinc-800`,
  `text-red-500`, `bg-white`, `bg-black/50`) and no hex colours anywhere in this
  folder. `ui-tokens.guard.test.ts` reads every string here, including variant
  maps, and fails on either.
- Variant and size maps are `const *_CLASSES` objects of static string
  literals. Never build class names from templates; Tailwind cannot see them.
  The same guard enforces this.
- `--on-accent` (white) is only valid on `bg-bloom-500/600/700` fills. Never
  pair it with `bg-accent` (mint in dark mode). The danger button is an outline
  on `bg-danger-soft`, because white on the dark-theme `--danger` fails contrast.
- Layers come from `Z_LAYERS` as inline `zIndex`. The Radix namespace in
  `Dialog.tsx` must stay named `Dialog` so `zLayers.guard.test.ts` checks it at
  the modal tiers; `MobileSheet.tsx` names it `Sheet` so it is checked at the
  drawer tiers.
- `IconButton` tooltips paint at the dropdown tier (200), below drawers and
  modals. Inside a `Dialog` or `MobileSheet`, use a labelled `Button` instead.
- Every primitive has a happy-dom test beside it covering role and name,
  keyboard (Escape, focus trap and return where relevant), disabled and loading,
  variants, and attribute pass-through. Add the same when adding a primitive.
