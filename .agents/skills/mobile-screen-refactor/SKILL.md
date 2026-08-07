---
name: mobile-screen-refactor
description: Refactors a React Native/Expo screen to improve UI/UX layout, visual hierarchy, spacing, and alignment without changing logic. Trigger when asked to improve, redesign, or polish a mobile screen.
---

# Mobile Screen Refactor Skill

This skill provides a systematic approach to refactoring React Native/Expo screens for improved usability, readability, and aesthetics, specifically tailored for a professional app used by support workers.

## Refactoring Guidelines
- **Clean Structure:** Reorganize the component tree to clearly group related elements. Use explicit containers (`View`) to manage flexbox layouts effectively.
- **Spacing and Typography:** Ensure consistent padding, margins, and typography. The interface should feel uncluttered. 
- **Feedback & States:** Add or refine visual feedback for interactions (e.g., loading spinners, disabled states, error banners).
- **Safe Areas & Scrolling:** Wrap main content in `SafeAreaView` (or handle insets appropriately) and `ScrollView` or `FlatList` to prevent content from being cut off on smaller devices.

## Strict Constraints
- **No business logic changes.** Keep hooks, handlers, reducers, selectors, and validation untouched. Refactor JSX and styles only.
- **No backend / API changes.** Do not modify request shapes, response handling, or endpoint URLs.
- **No auth flow changes.** Leave session handling, login, and permission gates as-is.
- **No navigation changes.** Do not rename routes, change params, or alter `navigation.navigate` / `router.push` calls.
- **No new dependencies.** Use only React Native primitives and the project's existing component library and theme.

## Execution Steps
1. **Analyze:** Briefly assess the current layout and identify hardcoded values, cramped elements, or poor visual hierarchy.
2. **Refactor:** Apply React Native `StyleSheet` styles to improve the layout. Prioritize readability.
3. **Verify Constraints:** Ensure no state/logic/navigation code was accidentally modified during the refactor.
