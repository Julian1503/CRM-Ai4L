import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type TestInfo } from '@playwright/test'

import { MAIN_VIEWS, openDashboard, openView } from './helpers/views'

/**
 * Automated accessibility checks (WCAG 2.1 A/AA rules in axe-core) on every main view
 * and on the contact drawer and its dialogs.
 *
 * Signed in, against the local Supabase stack — see smoke.spec.ts for setup.
 *
 * Fails on `serious` and `critical` violations. Colour contrast is the one exception:
 * the brand palette fails AA in places and changing it needs client sign-off
 * (docs/ACCESSIBILITY.md has the measurements and a proposed palette). Contrast
 * findings are still collected and attached to the report; set
 * A11Y_ENFORCE_CONTRAST=true to make them fail too, once the palette is decided.
 *
 * Full axe results for each page are attached as JSON, so the report lists the
 * moderate and minor findings as well.
 */

const EMAIL = process.env.E2E_EMAIL
const PASSWORD = process.env.E2E_PASSWORD
const ENFORCE_CONTRAST = process.env.A11Y_ENFORCE_CONTRAST === 'true'
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']
const BLOCKING_IMPACTS = new Set(['serious', 'critical'])

type AxeViolation = Awaited<ReturnType<AxeBuilder['analyze']>>['violations'][number]

function describe(violations: AxeViolation[]): string {
  return violations
    .map((violation) => {
      const targets = violation.nodes
        .slice(0, 5)
        .map((node) => `      ${node.target.join(' ')}`)
        .join('\n')
      return `  [${violation.impact}] ${violation.id}: ${violation.help} (${violation.nodes.length} node(s))\n${targets}`
    })
    .join('\n')
}

/** Runs axe on the page (or a part of it) and fails on blocking violations. */
async function expectAccessible(page: Page, testInfo: TestInfo, label: string, include?: string): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS)
  if (include) builder = builder.include(include)
  const results = await builder.analyze()

  await testInfo.attach(`axe-${label}.json`, { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' })

  const blocking = results.violations.filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ''))
  const contrast = blocking.filter((violation) => violation.id === 'color-contrast')
  const enforced = ENFORCE_CONTRAST ? blocking : blocking.filter((violation) => violation.id !== 'color-contrast')

  if (contrast.length > 0 && !ENFORCE_CONTRAST) {
    testInfo.annotations.push({
      type: 'a11y-contrast (not enforced)',
      description: `${label}: ${contrast[0].nodes.length} node(s) below AA contrast`,
    })
  }

  expect(enforced, `${label} has serious/critical accessibility violations:\n${describe(enforced)}`).toEqual([])
}

test.describe('accessibility', () => {
  test.skip(
    !EMAIL || !PASSWORD,
    'Set E2E_EMAIL and E2E_PASSWORD (and a configured Supabase project) to run the signed-in specs.'
  )

  // axe walks the whole DOM, and a realistic database makes some views large: the
  // campaigns view with ~170 segments and their campaigns took over a minute to analyse.
  // The budget is raised instead of narrowing what is checked.
  test.describe.configure({ timeout: 180_000 })

  // axe's verdicts do not depend on the engine; one browser keeps the run short.
  test.skip(({ browserName }) => browserName !== 'chromium', 'Accessibility rules are checked in Chromium only.')

  for (const view of MAIN_VIEWS) {
    test(`${view.heading} has no serious or critical violations`, async ({ page }, testInfo) => {
      await openDashboard(page)
      await openView(page, view)
      // Let lists and panels finish loading so axe sees the real content.
      await page.waitForLoadState('networkidle').catch(() => undefined)
      await expectAccessible(page, testInfo, view.id)
    })
  }

  test('the contact drawer and its discard dialog have no serious or critical violations', async ({ page }, testInfo) => {
    await openDashboard(page)

    await page.getByRole('button', { name: 'New Contact' }).click()
    const drawer = page.getByRole('dialog', { name: 'New Contact' })
    await expect(drawer).toBeVisible()
    await expectAccessible(page, testInfo, 'contact-drawer', '[aria-labelledby="contact-drawer-title"]')

    // An edit, then closing: the unsaved-changes question.
    await drawer.getByRole('textbox', { name: 'Notes' }).fill('Checked by the accessibility spec')
    await page.getByRole('button', { name: 'Close contact editor' }).click()
    await expect(page.getByTestId('confirm-dialog')).toContainText('Discard your changes?')
    await expectAccessible(page, testInfo, 'discard-dialog', '[data-testid="confirm-dialog"]')

    await page.getByRole('button', { name: 'Discard changes' }).click()
    await expect(drawer).toBeHidden()
  })

  test('the content brief form has no serious or critical violations', async ({ page }, testInfo) => {
    await openDashboard(page)
    await openView(page, MAIN_VIEWS.find((view) => view.id === 'content')!)
    await expect(page.getByRole('heading', { name: 'New content brief' })).toBeVisible()
    // Submitting empty shows every validation message, which axe should see too.
    await page.getByRole('button', { name: 'Create and generate' }).click()
    await expectAccessible(page, testInfo, 'content-brief-errors', 'form')
  })
})
