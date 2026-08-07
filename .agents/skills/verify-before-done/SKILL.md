---
name: verify-before-done
description: A final checklist and verification step for UI/UX changes before marking a task as done. Trigger when finishing a UI task or asked to do a final check.
---

# Verify Before Done Skill

This skill enforces a final, rigorous quality assurance check on any React Native UI/UX changes made. It acts as a gatekeeper to ensure that UI modifications meet the project's standards and do not violate strict constraints before a task is considered complete.

## Verification Checklist

Before finalizing any changes, verify the following:

### 1. UI/UX Quality
- [ ] **Simplicity:** Is the design simple, professional, and appropriate for support workers?
- [ ] **Touch Targets:** Are all interactive elements at least 44x44 points?
- [ ] **Spacing:** Are margins, padding, and gaps consistent and utilizing design tokens where possible?
- [ ] **Hierarchy:** Is the most critical information immediately visible?
- [ ] **States:** Are loading, empty, and error states handled correctly without breaking the layout?

### 2. Constraint Compliance
- [ ] **No business logic changes:** Handlers, hooks, reducers, selectors, and validation are untouched.
- [ ] **No backend / API changes:** Endpoints, request/response shapes, and data models are untouched.
- [ ] **No auth flow changes:** Session, token, sign-in, and permission logic are untouched.
- [ ] **No navigation changes:** Route names, params, and navigation triggers are untouched.
- [ ] **No new dependencies:** No new packages added; only existing components/tokens used.
- [ ] **Tokens over hardcoded values:** Colors, spacing, and typography use existing theme tokens where an equivalent exists.

### 3. Stability
- [ ] **Safe Areas:** Does the content respect screen safe areas (not cut off by notches or home indicators)?
- [ ] **Overflow:** Can the user scroll to reach all content if the screen size is small or text is scaled up?

## Execution
1. Perform a thorough review of the diff/changes.
2. Output the checklist, explicitly checking off each item based on your review.
3. If any item fails, STOP. Re-evaluate and fix the issue before declaring the task complete.
4. If all items pass, provide a final confirmation that the UI is polished and constraints have been maintained.
