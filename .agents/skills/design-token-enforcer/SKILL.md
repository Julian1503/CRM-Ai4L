---
name: design-token-enforcer
description: Replaces hardcoded styles in React Native components with existing theme or design tokens. Trigger when standardizing styles or cleaning up hardcoded values.
---

# Design Token Enforcer Skill

This skill standardizes React Native UI code by hunting down and replacing hardcoded style values (colors, spacing, typography) with the project's established design tokens and theme variables.

## Enforcement Rules
- **Color Consistency:** Replace hex codes, rgba, and named colors (e.g., `'red'`, `'#FF0000'`) with the appropriate semantic theme colors (e.g., `theme.colors.error`).
- **Spacing & Layout:** Replace hardcoded values only when a clear existing token equivalent exists. Do not force token usage for legitimate layout values such as flex, zIndex, opacity, icon sizes, or one-off technical dimensions (e.g., `theme.spacing.sm`, `theme.borderRadius.md`).
- **Typography:** Replace hardcoded `fontSize`, `fontWeight`, and `lineHeight` values with existing typography presets.

## Strict Constraints
- **Discover First:** Always inspect the project's shared constants, themes, or design system files (e.g., in `src/shared/design/` or `src/shared/components/`) to understand the available tokens before making changes.
- **No new tokens.** Do not invent new tokens or extend the theme. If no suitable token exists, leave the value alone and flag it.
- **No business logic changes.** Touch `StyleSheet` and style props only — never handlers, state, or data.
- **No backend / API, auth, or navigation changes.**
- **No new dependencies.**

## Execution Steps
1. **Locate Theme:** Identify where the design tokens or theme objects are exported in the project.
2. **Scan:** Identify all hardcoded `StyleSheet` or inline style values in the target file.
3. **Replace:** Carefully map each hardcoded value to its closest token equivalent and update the code.
4. **Maintain Simplicity:** Ensure the resulting code remains simple, legible, and professional for support worker interfaces.
