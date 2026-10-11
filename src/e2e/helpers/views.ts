import { expect, type Page } from '@playwright/test'

/**
 * The CRM's main views, the sidebar id that opens each one and the h1 that proves it
 * rendered. Shared by the accessibility and responsive specs.
 */
export const MAIN_VIEWS = [
  { id: 'contacts', heading: 'Dashboard overview' },
  { id: 'campaigns', heading: 'Segments and campaigns' },
  { id: 'content', heading: 'Content Studio' },
  { id: 'bookings', heading: 'Consultation bookings' },
  { id: 'imports', heading: 'Spreadsheet importer' },
  { id: 'integrations', heading: 'EmailOctopus campaigns' },
  { id: 'settings', heading: 'System settings' },
  { id: 'archive', heading: 'Archive' },
] as const

export type MainView = (typeof MAIN_VIEWS)[number]

/** Signed-in landing: the contacts dashboard loads a large list, hence the long wait. */
export async function openDashboard(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Dashboard overview', level: 1 })).toBeVisible({ timeout: 120_000 })
}

/**
 * Opens a view the way a person would at the current width: straight from the sidebar,
 * or through "More" where the mobile bar folds it away.
 */
export async function openView(page: Page, view: MainView): Promise<void> {
  const direct = page.getByTestId(`nav-item-${view.id}`)
  if (await direct.isVisible()) {
    await direct.click()
  } else {
    await page.getByTestId('nav-more').click()
    await page.getByTestId(`mobile-more-${view.id}`).click()
  }
  await expect(page.getByRole('heading', { name: view.heading, level: 1 })).toBeVisible({ timeout: 30_000 })
}
