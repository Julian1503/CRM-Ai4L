---
name: accessibility-check
description: Checks and improves React Native/Expo components for accessibility (a11y) including screen readers, contrast, and touch targets. Trigger when auditing or improving accessibility.
---

# Accessibility Check Skill

This skill is dedicated to making React Native/Expo applications usable for everyone by enforcing accessibility (a11y) best practices without altering core business logic or introducing new dependencies.

## Accessibility Requirements
- **Touch Targets:** All pressable elements (`Pressable`, `TouchableOpacity`, `Button`) MUST have a minimum hit area of 44x44 points. Use `hitSlop` if visual design requires a smaller element.
- **Screen Readers:** 
  - Ensure interactive elements have meaningful `accessibilityLabel` and appropriate `accessibilityRole` (e.g., `'button'`, `'link'`).
  - Use `accessibilityState` to convey dynamic states (e.g., `{ disabled: true, expanded: false }`).
  - Use `accessibilityHint` only if the result of an action is not obvious from the label.
- **Visual Contrast:** (If applicable) Ensure text and background colors maintain sufficient contrast ratios.
- **Focus Order:** Ensure the logical reading order makes sense for assistive technologies.

## Strict Constraints
- **No Third-Party A11y Tools:** Use React Native's built-in accessibility API properties. Do not install external accessibility libraries.
- **Professionalism:** Ensure the accessibility descriptions remain simple, professional, and helpful for support workers. Never include sensitive participant details in labels or hints.
- **No business logic changes.** Add a11y props only — do not change handlers, state, or rendering conditions beyond what is required to wire `accessibilityState` correctly.
- **No backend / API, auth, or navigation changes.**
- **No new dependencies.**

## Execution Steps
1. **Audit:** Scan the target component for missing accessibility labels, roles, states, and small touch targets.
2. **Implement:** Add standard React Native accessibility props to the relevant components.
3. **Enhance Touch:** Add `hitSlop` to small buttons or adjust padding.
4. **Review:** Ensure no regressions were introduced to the component's visual layout or behavior.
