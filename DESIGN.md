---
name: Ai4LCRM
description: A customized, responsive CRM application with advanced imports and campaign syncing.
colors:
  primary: "#01ACDB"
  primary-hover: "#0098c3"
  primary-muted: "#DEF1F7"
  accent: "#F98908"
  bg-app: "#EFF7F9"
  bg-surface: "#DEF1F7"
  bg-card: "#FFFFFF"
  border: "#CCD3DA"
  text-primary: "#22262B"
  text-secondary: "#717D8A"
  text-muted: "#8FA0B0"
  success: "#22c55e"
  warning: "#F98908"
  danger: "#ef4444"
  info: "#01ACDB"
typography:
  display:
    fontFamily: "var(--font-outfit), sans-serif"
    fontWeight: 600
  body:
    fontFamily: "var(--font-plus-jakarta-sans), sans-serif"
    fontWeight: 400
rounded:
  sm: "8px"
  md: "14px"
  lg: "20px"
  full: "9999px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "10px 20px"
---

# Design System: Ai4LCRM

## 1. Overview

**Creative North Star: "The Neon Sanctuary"**

This system fuses a clean, responsive layout with a deep slate-indigo background and highly calibrated vibrant neon highlights. It provides a premium dark-mode feeling by default (and matching light-mode) using glassmorphic overlay cards, sharp spacing, and high-legibility typography. 

This system rejects low-contrast grey text, SaaS card grid clichés, and unnecessary heavy borders. It focuses strictly on data legibility, ensuring the CRM interfaces feel fast, lightweight, and precise.

**Key Characteristics:**
*   Vibrant, high-contrast primary indicators (Royal Indigo + Electric Pink).
*   Glassmorphic overlay cards with fine border strokes and heavy backing blur.
*   Spacious, responsive layout spacing utilizing an 8px base scale.
*   High typography contrast between headers (`Outfit`) and body (`Plus Jakarta Sans`).

## 2. Colors

Colors are defined using CSS Custom Variables based on HSL color space. The frontmatter uses hex representations for tool compatibility, but the system code utilizes dynamic HSL variables centered around a hue seed.

### Primary
*   **Royal Indigo** (hsl(242, 75%, 52%) / `#473bf0`): The signature brand color, used for high-value CTAs, primary active buttons, and selected sidebar items.
*   **Indigo Hover** (hsl(242, 75%, 45%)): Used for button hover states.
*   **Indigo Muted** (hsl(242, 85%, 93%)): Soft background tint for active labels or highlights.

### Accent
*   **Electric Pink** (hsl(320, 80%, 55%) / `#ec4899`): Used sparingly to highlight special actions (e.g. active sync indicators, critical stats, or campaign updates).

### Neutral
*   **App Background** (hsl(242, 25%, 6%) / `#0b0b14`): Deep slate-indigo backdrop.
*   **Surface Panel** (hsl(242, 20%, 9%) / `#10101f`): Used for structural panels like the main navigation sidebar.
*   **Card Background** (hsl(242, 20%, 11%) / `#141426`): Backdrop color for content containers and modular panels.
*   **Border** (hsl(242, 12%, 18%) / `#202035`): Crisp, low-weight lines to demarcate lists and panels.
*   **Text Primary** (hsl(242, 20%, 92%) / `#f1f1f7`): High-contrast light text for headings and fields.
*   **Text Secondary** (hsl(242, 12%, 70%) / `#b2b2ca`): Muted text for descriptions and inactive states.

### Named Rules
**The 10% Accent Rule.** The primary Royal Indigo and Electric Pink colors must be reserved for interactive states, validation status, and active selection. They must never compose more than 10% of any single viewport surface to preserve their high-contrast impact.

## 3. Typography

**Display Font:** Outfit (sans-serif)
**Body Font:** Plus Jakarta Sans (sans-serif)

**Character:** A pairing that balances geometric structure with humanistic warmth. `Outfit` brings sharp, clean vertical rhythm to headers, while `Plus Jakarta Sans` provides high legibility and soft, open counters for dense client tables.

### Hierarchy
*   **Display** (600, 2rem to 2.5rem, 1.2): Used for primary dashboard metrics and page-level title headings.
*   **Headline** (600, 1.5rem, 1.3): Section level titles and dialog titles.
*   **Title** (500, 1.1rem, 1.4): Table headers, contact card names, card grouping headers.
*   **Body** (400, 0.95rem, 1.6): Default reading size for tables, notes text, notes timelines. Max line length: 70ch.
*   **Label** (500, 0.8rem, 1.2): Badges, statuses, input field label titles.

### Named Rules
**The No-Condensed Rule.** Body text must always maintain a letter-spacing of `normal` or slightly positive (`0.01em` to `0.02em`) to ensure readability on small screen sizes. Condensed letter-spacing is strictly prohibited.

## 4. Elevation

The system relies on tonal layering and fine borders rather than heavy, muddy shadows. A subtle glassmorphic blur separates overlay elements from the backdrop.

### Shadow Vocabulary
*   **Ambient Low** (`0 2px 8px -2px rgba(0, 0, 0, 0.3)`): Used on static cards and items.
*   **Ambient High** (`0 16px 40px -8px rgba(0, 0, 0, 0.6)`): Used exclusively on active drawers and dropdown modals.
*   **Glass Shadow** (`0 8px 32px 0 rgba(0, 0, 0, 0.4)`): Backdrop-shadow for main content drawers.

### Named Rules
**The Blur-Separated Rule.** Modals and sliding drawers must use `backdrop-filter: blur(16px)` and a translucent border (`rgba(255, 255, 255, 0.06)`) rather than dark drop shadows to float over background content.

## 5. Components

### Buttons
*   **Shape:** Curved (14px radius)
*   **Primary:** Royal Indigo background, white text. Internal padding `10px 20px`.
*   **Hover / Focus:** Shift to Indigo Hover background. When keyboard-focused, show a `2px` focus outline of `hsl(242, 60%, 45%)`.
*   **Secondary / Ghost:** Translucent background (`rgba(255,255,255,0.05)`), border `1px solid var(--border)`.

### Cards / Containers
*   **Corner Style:** Curved (14px radius).
*   **Background**: Card Background color or glass-panel background (`rgba(15, 15, 25, 0.7)`).
*   **Border**: Fine boundary line (`1px` solid `var(--border)`).
*   **Padding**: Spacing scale Medium (`16px`) or Large (`24px`).

### Inputs / Fields
*   **Style**: Solid background (`var(--bg-surface)`), border `1px` solid `var(--border)`, radius `8px`.
*   **Focus**: Glow focus outline, border transitions to `var(--border-focus)`.
*   **Error**: Warning states transition border to Danger (`#ef4444`) with soft danger text notice below.

## 6. Do's and Don'ts

### Do:
*   **Do** verify text contrast reaches a minimum ratio of 4.5:1 on all surfaces, including text in tables and placeholders.
*   **Do** use `text-wrap: balance` on headers to ensure even, visually pleasing line breaks.
*   **Do** keep card outlines to 1px thickness and avoid thick side-stripe accents.

### Don't:
*   **Don't** use low contrast grey copy for secondary notes or subtext.
*   **Don't** create nested cards inside cards.
*   **Don't** use neon gradient text fills combined with glassmorphism.
*   **Don't** put numbered section markers (e.g. `01 / 02 / 03`) on standard dashboard sections.
