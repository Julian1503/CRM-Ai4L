import { expect, test, type Page } from '@playwright/test'

import { MAIN_VIEWS, openDashboard, openView } from './helpers/views'

/**
 * Responsive smoke: at each breakpoint every main view renders without a horizontal
 * page scroll, and the navigation stays usable (every view is reachable, directly or
 * through "More" on the mobile bar).
 *
 * Signed in, against the local Supabase stack — see smoke.spec.ts for setup. Wide
 * tables may scroll inside their own container; only the page itself must not.
 */

const EMAIL = process.env.E2E_EMAIL
const PASSWORD = process.env.E2E_PASSWORD
const WIDTHS = [320, 768, 1024, 1440] as const
const HEIGHT = 900
/** Sub-pixel rounding can report one extra pixel without any visible scroll. */
const TOLERANCE_PX = 1

async function horizontalOverflow(page: Page): Promise<{ scrollWidth: number; clientWidth: number; offenders: string[] }> {
  return page.evaluate(() => {
    const root = document.documentElement
    const clientWidth = root.clientWidth
    // The widest elements poking past the viewport, to say what to fix.
    const offenders = Array.from(document.body.querySelectorAll<HTMLElement>('*'))
      .filter((element) => element.getBoundingClientRect().right > clientWidth + 1)
      .filter((element) => !element.closest('[data-allow-overflow]'))
      .slice(0, 5)
      .map((element) => `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).split(' ')[0]}` : ''}`)
    return { scrollWidth: root.scrollWidth, clientWidth, offenders }
  })
}

test.describe('responsive layout', () => {
  test.skip(
    !EMAIL || !PASSWORD,
    'Set E2E_EMAIL and E2E_PASSWORD (and a configured Supabase project) to run the signed-in specs.'
  )

  // Layout is a CSS question; one engine keeps four widths times eight views affordable.
  test.skip(({ browserName }) => browserName !== 'chromium', 'Responsive layout is checked in Chromium only.')

  for (const width of WIDTHS) {
    test(`every main view fits ${width}px without horizontal scroll`, async ({ page }) => {
      test.setTimeout(180_000)
      await page.setViewportSize({ width, height: HEIGHT })
      await openDashboard(page)

      for (const view of MAIN_VIEWS) {
        await openView(page, view)

        const heading = page.getByRole('heading', { name: view.heading, level: 1 })
        const box = await heading.boundingBox()
        expect(box, `${view.heading} heading has no box at ${width}px`).not.toBeNull()
        expect(box!.x, `${view.heading} heading starts off-screen at ${width}px`).toBeGreaterThanOrEqual(0)

        const { scrollWidth, clientWidth, offenders } = await horizontalOverflow(page)
        expect(
          scrollWidth,
          `${view.heading} scrolls horizontally at ${width}px (${scrollWidth} > ${clientWidth}); widest: ${offenders.join(', ')}`
        ).toBeLessThanOrEqual(clientWidth + TOLERANCE_PX)
      }

      // The nav itself: the way to the first view is on screen and inside the viewport.
      const contacts = page.getByTestId('nav-item-contacts')
      await expect(contacts).toBeVisible()
      const navBox = await contacts.boundingBox()
      expect(navBox!.x + navBox!.width).toBeLessThanOrEqual(width + TOLERANCE_PX)
    })
  }
})
