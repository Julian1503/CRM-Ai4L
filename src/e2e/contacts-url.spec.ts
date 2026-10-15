import { expect, test } from '@playwright/test'

import { openDashboard } from './helpers/views'

/**
 * Contacts keeps its search, filters, sort and page in the address (UX plan P5.1), so a
 * filtered list can be shared, survives a reload and follows Back/Forward.
 */

const EMAIL = process.env.E2E_EMAIL
const PASSWORD = process.env.E2E_PASSWORD

test.describe('contacts list address', () => {
  test.skip(!EMAIL || !PASSWORD, 'Set E2E_EMAIL and E2E_PASSWORD to run the signed-in specs.')

  test('a filtered list survives a reload and follows Back and Forward', async ({ page }) => {
    await openDashboard(page)
    await expect(page).toHaveURL(/\/contacts$/)

    await page.getByTestId('status-filter-customer').click()
    await expect(page).toHaveURL(/\/contacts\?status=customer$/)

    await page.getByTestId('state-filter').selectOption('NSW')
    await expect(page).toHaveURL(/status=customer/)
    await expect(page).toHaveURL(/state=NSW/)

    await page.reload()
    await expect(page.getByRole('heading', { name: 'Dashboard overview', level: 1 })).toBeVisible({ timeout: 120_000 })
    await expect(page.getByTestId('state-filter')).toHaveValue('NSW')
    await expect(page.getByTestId('status-filter-customer')).toHaveAttribute('aria-pressed', 'true')

    await page.goBack()
    await expect(page).toHaveURL(/\/contacts\?status=customer$/)
    await expect(page.getByTestId('state-filter')).toHaveValue('')

    await page.goForward()
    await expect(page).toHaveURL(/state=NSW/)
    await expect(page.getByTestId('state-filter')).toHaveValue('NSW')
  })

  test('the search box writes to the address once typing pauses', async ({ page }) => {
    await openDashboard(page)
    await page.getByPlaceholder(/search/i).fill('zz-no-such-contact')
    await expect(page).toHaveURL(/q=zz-no-such-contact/)

    await page.reload()
    await expect(page.getByPlaceholder(/search/i)).toHaveValue('zz-no-such-contact', { timeout: 120_000 })
  })

  test('an old single-page address still lands on its workspace', async ({ page }) => {
    await page.goto('/?view=imports')
    await expect(page).toHaveURL(/\/imports$/)
    await expect(page.getByRole('heading', { name: 'Spreadsheet importer', level: 1 })).toBeVisible({ timeout: 60_000 })
  })
})
