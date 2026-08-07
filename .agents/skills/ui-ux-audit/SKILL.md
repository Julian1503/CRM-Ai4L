---
name: ui-ux-audit
description: Audits a React Native/Expo mobile screen for UI/UX best practices, focusing on usability for support workers. Trigger when asked to review, audit, or check the UI/UX of a screen.
---

# UI/UX Audit Skill

This skill is designed to analyze React Native/Expo screens to ensure they meet strict UI/UX standards suitable for support workers, prioritizing clarity, simplicity, and professional design.

## Core Mandates
- **Visual Hierarchy:** Is the most important information immediately obvious? Are secondary details de-emphasized?
- **Spacing & Alignment:** Is there consistent use of margins, padding, and gaps? Does the layout feel balanced?
- **Mobile Usability:** Is the layout scrollable if it exceeds screen height? Are safe areas respected?
- **Touch Targets:** Are all interactive elements (buttons, links, toggles) easily tappable (minimum 44x44 points)?
- **State Management:** Are empty, loading, and error states gracefully handled and clearly communicated?
- **Accessibility:** Are sufficient contrasts maintained? 

## Strict Constraints
- **No business logic changes.** Do not modify state machines, validation rules, computed values, or side effects.
- **No backend / API changes.** Do not alter backend contracts, data models, request/response shapes, or API payloads.
- **No auth flow changes.** Do not touch sign-in, session, token, or permission logic.
- **No navigation changes.** Do not change route names, params, stack/tab structure, or navigation triggers.
- **No new dependencies.** Use only what is already installed in the project.

## Audit Output Format
When auditing a file, output a structured report:
1. **Strengths:** What is currently working well.
2. **Issues:** Bulleted list of UI/UX violations or areas for improvement.
3. **Recommendations:** Actionable steps to fix the issues using existing theme tokens and standard React Native components.

Do not write code directly unless requested; provide the audit report first.
