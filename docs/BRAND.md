# Paperloom PDF identity

## Original design

This is original artwork created for Paperloom PDF, not a tracing or intentional imitation of an existing logo, mascot, or trademark. A squared page folds at its upper-right corner into two interlaced threads; alternating gaps convey a loom without a flower or PDF swoosh. Deep jade suggests precise, calm editing, while mint identifies active states in the dark interface. Original authorship is not a legal trademark-clearance opinion.

## Role palette

Existing token names are retained; `bloom` is a compatibility name for the CSS palette, not the visual identity. Neutral greys are unchanged.

| Role | Existing token | Light | Dark |
| --- | --- | --- | --- |
| Primary, white-label button | `--bloom-500` | #176B65 | #176B65 |
| Primary-hover, white-label button | `--bloom-600` | #125952 | #125952 |
| Primary-soft, selected control fill | `--bloom-100` | #E6F5F1 | #123B36 |
| Accent, foreground and focus | `--accent` | #176B65 | #68D5C5 |
| Ink, main interface text | `--text` | #0F172A | #F8FAFC |
| Surface, application background | `--surface` | #F1F3F5 | #030304 |
| Mark, transparent asset stroke | SVG only | #238C80 | #238C80 |

### Complete CSS token inventory

| Token | Light value | Dark value | Role |
| --- | --- | --- | --- |
| `--bloom-50` | #F1FAF7 | #F1FAF7 | Lightest jade tint |
| `--bloom-100` | #E6F5F1 | #123B36 | Theme-aware primary-soft |
| `--bloom-200` | #B9EBDF | #B9EBDF | Decorative separators |
| `--bloom-300` | #8FE0D1 | #8FE0D1 | Progress highlight |
| `--bloom-400` | #68D5C5 | #68D5C5 | Mint illustration highlight |
| `--bloom-500` | #176B65 | #176B65 | Primary button fill |
| `--bloom-600` | #125952 | #125952 | Primary hover / gradient end |
| `--bloom-700` | #0E4944 | #0E4944 | Hover gradient end |
| `--bloom-800` | #123B36 | #123B36 | Icon tile / deep jade |
| `--bloom-900` | #0B2926 | #0B2926 | Deepest jade |
| `--surface` | #F1F3F5 | #030304 | Application background |
| `--panel` | #FFFFFF | #0A0B0E | Header / sidebar background |
| `--panel-elevated` | #F8FAFC | #12141A | Raised controls |
| `--border` | #E2E8F0 | #1C1E26 | Neutral dividers |
| `--border-strong` | #CBD5E1 | #2A2D3A | Strong neutral dividers |
| `--text` | #0F172A | #F8FAFC | Main ink |
| `--text-muted` | #64748B | #8E95A5 | Existing secondary text |
| `--text-faint` | #94A3B8 | #525866 | Existing faint text |
| `--accent` | #176B65 | #68D5C5 | Brand text, outlines, focus |
| `--canvas-bg` | #EAEFF5 | #0B0C10 | Editor canvas backdrop (`.checkerboard`) |
| `--canvas-dot` | #CBD5E1 | #1E2330 | Editor canvas dot grid (`.checkerboard`) |
| `--ring-offset` | #FFFFFF | #0A0B0E | Focus separation halo |
| `--focus-ring` | #176B65 | #68D5C5 | Keyboard focus outline (`:focus-visible`) |
| `--scrim` | rgba(15, 23, 42, 0.45) | rgba(0, 0, 0, 0.85) | Modal backdrop |
| `--backdrop` | rgba(0, 0, 0, 0.5) | rgba(0, 0, 0, 0.7) | Drawer / mobile sheet backdrop (`.mobile-backdrop`) |
| `--contrast` | #000000 | #FFFFFF | Maximum-contrast neutral |
| `--on-accent` | #FFFFFF | #FFFFFF | Text on primary fills `--bloom-500/600/700` (not on mint `--accent`) |

### Semantic status tokens

Foregrounds meet 4.5:1 on `--panel`, `--surface`, `--panel-elevated` and their own soft fill in each theme. Success is green (hue about 142°), at least 25° away from the jade brand (about 171–176°), so it never reads as the brand colour.

| Token | Light value | Dark value | Role |
| --- | --- | --- | --- |
| `--danger` | #B91C1C | #F87171 | Errors, destructive actions |
| `--danger-soft` | #FEF2F2 | #450A0A | Error notice fill |
| `--warning` | #B45309 | #FBBF24 | Warnings, irreversible-step notices |
| `--warning-soft` | #FFFBEB | #451A03 | Warning notice fill |
| `--success` | #15803D | #4ADE80 | Success / verified state |
| `--success-soft` | #F0FDF4 | #052E16 | Success notice fill |
| `--info` | #1D4ED8 | #60A5FA | Neutral information |
| `--info-soft` | #EFF6FF | #172554 | Information notice fill |

### Tailwind aliases

These existing `@theme inline` aliases resolve the tokens above at the element's theme; no duplicate fixed coral palette remains.

| Token | Resolved value / role |
| --- | --- |
| `--color-bloom-50` | `--bloom-50` |
| `--color-bloom-100` | `--bloom-100` |
| `--color-bloom-200` | `--bloom-200` |
| `--color-bloom-300` | `--bloom-300` |
| `--color-bloom-400` | `--bloom-400` |
| `--color-bloom-500` | `--bloom-500` |
| `--color-bloom-600` | `--bloom-600` |
| `--color-bloom-700` | `--bloom-700` |
| `--color-bloom-800` | `--bloom-800` |
| `--color-bloom-900` | `--bloom-900` |
| `--color-canvas-bg` | `--canvas-bg` |
| `--color-surface` | `--surface` |
| `--color-panel` | `--panel` |
| `--color-panel-elevated` | `--panel-elevated` |
| `--color-border` | `--border` |
| `--color-border-strong` | `--border-strong` |
| `--color-app-muted` | `--text-muted` |
| `--color-app-faint` | `--text-faint` |
| `--color-accent` | `--accent` |
| `--color-contrast` | `--contrast` |
| `--color-on-accent` | `--on-accent` |
| `--color-focus-ring` | `--focus-ring` |
| `--color-scrim`, `--color-backdrop` | `--scrim`, `--backdrop` |
| `--color-danger`, `--color-danger-soft` | `--danger`, `--danger-soft` |
| `--color-warning`, `--color-warning-soft` | `--warning`, `--warning-soft` |
| `--color-success`, `--color-success-soft` | `--success`, `--success-soft` |
| `--color-info`, `--color-info-soft` | `--info`, `--info-soft` |

## Rules

- Components use theme tokens (`bg-panel`, `text-app-muted`, `border-app`, `text-danger`, `bg-success-soft`, ...), never raw Tailwind palette classes such as `bg-zinc-800`, `text-red-400`, `bg-white` or `bg-black/50`.
- Define a new colour as a token in both the light and dark blocks of `src/app/globals.css` (or add it to the theme-invariant allowlist), map it in `@theme inline`, and add it to the tables above. Outside the token blocks, `globals.css` references tokens only.
- `src/app/__tests__/design-tokens.test.ts` enforces token parity, `@theme` aliases and the contrast pairs. `src/app/__tests__/palette-classes.guard.test.ts` is a per-file ratchet on raw palette classes in `className` expressions: counts may only fall. After a migration, lower the baseline with `UPDATE_PALETTE_BASELINE=1 npx vitest run src/app/__tests__/palette-classes.guard.test.ts`.
- Document and content colours (ink defaults, user swatches, canvas drawing, cursor and export SVG) are not theme chrome and stay out of the token system.

## Contrast and interaction rules

- Use white text on primary `--bloom-500`, hover `--bloom-600`, and hover-gradient `--bloom-700`. Never put white text on mint. The WCAG relative-luminance calculation gives approximately 6.3:1 for white on primary and 8.2:1 on hover, above AA's 4.5:1 requirement for normal text.
- Use `text-accent` on `bg-bloom-100` for selected controls. The light and dark pairs exceed 4.5:1 by the same calculation. Do not substitute translucent primary fills for this paired text surface.
- Brand focus uses an opaque two-pixel `--accent` outline with two-pixel offset and a `--ring-offset` separation halo. Accent exceeds 3:1 against the theme's panel, elevated panel, and surface; the halo separates it from controls with fixed dark fills.
- Browser text selection uses the same opaque primary-soft / accent pair, including default dark mode. Decorative shadows may remain translucent; focus indicators must not rely on a translucent shadow alone.
- Existing semantic tool hues, PDF drawing/highlighter defaults, success/error colors, and neutral-grey text are outside this brand palette. This is not a whole-product accessibility audit; existing faint neutral text is unchanged.
- Ratios above are mathematical design estimates, not a rendered-browser audit. Test execution and visual verification were not performed during this identity task.

## Assets and usage

- `public/brand/paperloom-mark.svg`: transparent 64x64 mark, fixed jade stroke with no background; intended for light and dark neutral surfaces. Use at 16 CSS pixels or larger. At 16px its four-unit strokes become one pixel; inspect woven gaps at actual size before release.
- `public/brand/paperloom-logo.svg`: transparent 358x64 horizontal lockup. All lettering is custom vector paths; no fonts, external resources, or `<text>` are required. Use at 179px wide or larger. Ink switches with `prefers-color-scheme`; for an independently toggled application theme, prefer the mark beside live `BRAND_NAME` text, as the home page and toolbar do.
- `public/brand/paperloom-icon.svg`: 512x512 rounded-square deep-jade tile, mint mark, transparent outer corners. Geometry is centered by visible bounds with at least 80px horizontal and 80px vertical padding. Do not crop the tile or enlarge the mark inside it.
- Preserve aspect ratio, thread gaps, tile radius, and supplied colors. No rotation, stretching, flower embellishments, swooshes, gradients on the mark, or added effects. Reserve at least one mark-stroke width of clear space around standalone artwork.
- UI logo image alt text must equal `BRAND_NAME` (`Paperloom PDF`). The brand constant remains in `src/lib/brand.ts`.
- `NEXT_PUBLIC_BASE_PATH` is shared by `next.config.ts` and `BRAND_BASE_PATH` in `src/lib/brand.ts`; set it to a leading-slash deployment prefix (for example `/paperloom`) at build time. Empty means root hosting. One trailing slash is stripped. The previous code used root-only `/logo.png`; there was no existing base-path helper.
- The unreferenced `public/BloomPDF.png` and `public/logo.png` legacy assets were removed; the UI uses the current brand assets.
- Existing fixed-dark search, export, and signature-creation surfaces explicitly scope the dark palette even when the rest of the application uses light mode; their neutral backgrounds are unchanged.

## Manager raster-render handoff

Use **only `public/brand/paperloom-icon.svg`** as the source for all app-icon/favicon rasters below. Render the full 512x512 viewBox with its tile, colors, padding, and transparent outer corners; export sRGB PNG with alpha, not a screenshot. Do not rasterize the transparent mark or horizontal wordmark as an app icon.

| Destination | Exact output |
| --- | --- |
| `src/app/icon.png` | 512x512 PNG (Next file-convention icon) |
| `src/app/apple-icon.png` | 180x180 PNG (Next file-convention Apple icon) |
| `public/icon-512.png` | 512x512 PNG |
| `public/icon-192.png` | 192x192 PNG |
| `public/icon-32.png` | 32x32 PNG |
| `public/favicon.ico` | ICO containing 16x16, 32x32, and 48x48 renders |
| `src/app/favicon.ico` | Same multi-resolution ICO as `public/favicon.ico` |

Metadata uses the new SVG for icon/shortcut and the 180px Apple raster. Next's existing file-convention icons can take precedence, so regenerate both `src/app/icon.png` and `src/app/favicon.ico`, not only public assets. No binary was generated or changed in this task. The unreferenced old `public/logo.png` was removed.

## Release checks still required

Manager: execute the existing suite including `src/app/__tests__/brand-assets.test.ts`; build/export at root and with a deployment prefix; inspect home, toolbar, download/export controls, selected states, text selection and keyboard focus in both themes. Inspect the mark and favicon at 16px, tile masks, and the outlined wordmark at its minimum size. Raster quality, real browser contrast, visual legibility, and trademark clearance remain unverified.
