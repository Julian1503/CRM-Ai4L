# Accessibility

Target: WCAG 2.1 AA (PRODUCT.md). This page records how the CRM is checked, what the
current colour tokens measure, the palette proposed to close the contrast gap, and the
automated (axe) results.

## 1. How it is checked

| Check | Where | Runs |
| --- | --- | --- |
| axe-core, WCAG 2.0/2.1 A + AA rules | `src/e2e/accessibility.spec.ts` | Signed in, local Supabase stack, Chromium. Every main view (contacts, campaigns, Content Studio, bookings, importer, EmailOctopus, settings, archive), the contact drawer, its discard dialog and the content brief with validation errors. |
| Responsive smoke | `src/e2e/responsive.spec.ts` | 320, 768, 1024 and 1440 px: no horizontal page scroll on any main view; every view reachable from the nav (directly or through "More"). |
| Unit tests | Jest + Testing Library | Accessible names, focus on open/close, Escape, keyboard reordering, live regions. |

The axe spec fails on **serious** and **critical** violations. Colour contrast is the
one rule reported but not enforced, because fixing it means changing the brand palette
(section 3). Each page's full axe output is attached to the Playwright report as JSON.
Set `A11Y_ENFORCE_CONTRAST=true` to make contrast fail too, once the palette is decided.

```bash
# local stack, seeded test user (see smoke.spec.ts)
E2E_BROWSERS=chromium npx playwright test accessibility responsive
```

## 2. Measured contrast of the current tokens

WCAG 2.1 relative-luminance ratios, computed from the hex values in
`src/app/globals.css`. AA needs **4.5:1** for normal text, **3:1** for large text
(≥ 24 px, or ≥ 18.66 px bold) and for UI components and focus indicators (1.4.11).

| Token (as text) | on `--bg-card` #FFFFFF | on `--bg-app` #EFF7F9 | on `--bg-surface` #DEF1F7 | on `--bg-cream` #F6EEE4 |
| --- | --- | --- | --- | --- |
| `--primary` #01ACDB | **2.65** ✗ | **2.44** ✗ | **2.28** ✗ | **2.31** ✗ |
| `--primary-hover` #0098C3 | **3.34** ✗ (large only) | **3.08** ✗ (large only) | **2.87** ✗ | **2.91** ✗ |
| `--text-muted` #8FA0B0 | **2.68** ✗ | **2.47** ✗ | **2.30** ✗ | **2.34** ✗ |
| `--text-secondary` #717D8A | **4.20** ✗ (large only) | **3.87** ✗ (large only) | **3.60** ✗ (large only) | **3.65** ✗ (large only) |
| `--text-primary` #22262B | 15.22 ✓ | 14.01 ✓ | 13.06 ✓ | 13.24 ✓ |
| `--accent` / `--warning` #F98908 | **2.44** ✗ | **2.25** ✗ | **2.09** ✗ | **2.12** ✗ |
| `--success` #22C55E | **2.28** ✗ | **2.10** ✗ | **1.96** ✗ | **1.98** ✗ |
| `--danger` #EF4444 | **3.76** ✗ (large only) | **3.47** ✗ (large only) | **3.23** ✗ (large only) | **3.27** ✗ (large only) |

Text on filled controls:

| Pair | Ratio | |
| --- | --- | --- |
| White on `--primary` (every primary button) | **2.65** | ✗ |
| White on `--primary-hover` | **3.34** | ✗ (large only) |
| White on `--accent` (send / publish buttons) | **2.44** | ✗ |
| White on `--danger` (confirm-dialog destructive button) | **3.76** | ✗ (large only) |
| `--text-primary` on `--primary` | 5.74 | ✓ |

Non-text (1.4.11, needs 3:1):

| Element | Ratio | |
| --- | --- | --- |
| `--primary` focus outline on white | **2.65** | ✗ |
| `--border` #CCD3DA input border on white | **1.51** | ✗ — review: 1.4.11 applies if the border is the only cue that marks the field |
| `--border-focus` #82D6ED on white | **1.64** | ✗ |

Already compliant: the hard-coded status-pill text colours (#0B6B8A on info/primary-muted
5.17–6.03, #7A4405 on warning 7.2, #8A1C1C on danger 8.2, #146C35 on success 6.0) and the
inline error red #B42318 (6.57 on white).

`--text-muted` is used for placeholders, timestamps and helper text in about 35 rules,
and `color: var(--primary)` in about 70: links, active tabs, link-style buttons. Both
fail AA on every background in the app.

## 3. AA palette (applied 2026-10-28)

Same hues, darkened just enough to reach 4.5:1 on the darkest background each token
appears on (`--bg-surface` #DEF1F7). The bright brand cyan stays as a fill and accent
colour; text and focus use the darker variants. Approved and applied on 2026-10-28.

| New / changed token | Value | On white | On #DEF1F7 | White text on it |
| --- | --- | --- | --- | --- |
| `--primary-text` (links, active tabs, link buttons, focus ring) | `#017595` | 5.28 | 4.53 | 5.28 |
| `--primary-strong` (primary button fill) | `#017595` | — | — | 5.28 |
| `--primary-strong-hover` | `#015F79` | — | — | 7.21 |
| `--text-muted` | `#5B6E80` (was #8FA0B0) | 5.27 | 4.52 | — |
| `--text-secondary` | `#636D79` (was #717D8A) | 5.26 | 4.51 | — |
| `--accent-text` / `--warning-text` | `#A35904` | 5.27 | 4.52 | 5.27 |
| `--accent-strong` (send / publish button fill) | `#A35904` | — | — | 5.27 |
| `--success-text` | `#157C3B` | 5.28 | 4.53 | 5.28 |
| `--danger-strong` (destructive button fill, danger text) | `#D71212` | 5.27 | 4.53 | 5.27 |
| `--border-focus` | `#017595` | 5.28 (≥ 3:1 for 1.4.11) | 4.53 | — |

Kept as they are: `--primary` #01ACDB and `--accent` #F98908 for fills that carry no
text, decoration, the logo, active dots and illustrations; `--bg-*`; `--text-primary`.

Lower-churn alternative: keep the cyan button fills and switch their label to
`--text-primary` (5.74:1 on #01ACDB). That keeps the brand look but gives dark-on-cyan
buttons, which is a visible style change of its own.

How it was applied: rather than add `--primary-text` / `--primary-strong` and rewrite
~130 call sites, the existing tokens took the AA values (`--primary` #017595,
`--primary-hover` #015F79, `--accent` and `--warning` #A35904, `--success` #157C3B,
`--danger` #D71212 with `--danger-hover` #B10F0F, `--info` and `--border-focus` #017595,
and the two greys above). Every text, outline and filled button that used them is AA
with no per-file change. The bright originals live on as `--brand-cyan` #01ACDB and
`--brand-orange` #F98908, used only for marks that carry no text: the logo dot, the
active-nav dot, glows and the suggestion gradient. `A11Y_ENFORCE_CONTRAST=true` is set
in the CI integration job, so a contrast regression fails the build.

## 4. Changes this round (Tanda 3)

- `window.confirm` replaced with `ConfirmDialog` (focus on Cancel, Escape, focus
  returned) in the contact drawer (archive) and the archive (restore one, restore
  selected). `ConfirmDialog` gained a `neutral` tone for questions that lose nothing
  (restore, archive) and a `cancelLabel`. Outcomes are announced with the toast live
  region.
- Contact drawer: the Notes textarea has an accessible name (audit L1). The free-text
  State field used for countries other than Australia was also unnamed: the `State`
  label pointed at an id that only the Australian field had. Closing the drawer with
  unsaved edits (close button, Cancel, Escape, backdrop) now asks before discarding
  (UX P3.3).

## 5. axe results

First full run: Tanda 3, local Supabase stack, production build, Chromium, run serially.

| Check | Result |
| --- | --- |
| Contacts (dashboard), Content Studio, bookings, importer, EmailOctopus, settings, archive | No serious or critical violations. |
| Contact drawer, discard dialog, content brief with validation errors | No serious or critical violations. |
| Segments and campaigns | No result yet. axe did not finish inside the 60 s test budget because the DOM was very large (~170 segments plus their campaigns). The suite budget is now 180 s, with the whole page still checked; awaiting the re-run. |
| Responsive, 320 / 768 / 1024 / 1440 px | All views pass: no horizontal page scroll, and every view is reachable from the nav. |

Findings and owners:

| Finding | Status |
| --- | --- |
| Importer column-mapping `<select>` had no accessible name (`select-name`, critical) in `src/app/page.tsx` | Fixed by the page owner. |
| Contact drawer: Notes textarea and the non-Australian State field had no accessible name | Fixed (this round). |
| Archive failure reported twice (page toast plus the drawer dialog) | UX; with the page owner. |
| **Colour contrast** (`color-contrast`, serious) on most views: links, muted text, primary/accent buttons (section 2) | **Outstanding.** Reported but not enforced until the client approves a palette (section 3). Then set `A11Y_ENFORCE_CONTRAST=true` in CI. |
