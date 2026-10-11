import { expect, test, type Page } from '@playwright/test'

/**
 * Spreadsheet import and contact tags, end to end, signed in, against the local stack.
 *
 * Every run imports two new contacts whose surname carries a unique marker and creates
 * one tag; nothing is deleted afterwards (contacts are never physically deleted), so the
 * marker (`E2e<timestamp>`) and the tag prefix (`e2e-tag-`) are how to find them.
 */

const EMAIL = process.env.E2E_EMAIL
const PASSWORD = process.env.E2E_PASSWORD

function csvFor(marker: string): string {
  return [
    'First Name,Last Name,Email',
    `Ada,${marker},ada-${marker.toLowerCase()}@example.test`,
    `Bob,${marker},bob-${marker.toLowerCase()}@example.test`,
  ].join('\n')
}

async function openDashboard(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Dashboard overview', level: 1 })).toBeVisible({ timeout: 120_000 })
}

/** Uploads, maps (the importer recognises these headers), previews and commits. */
async function importContacts(page: Page, marker: string) {
  await page.getByTestId('nav-item-imports').click()
  await expect(page.getByText('Spreadsheet importer')).toBeVisible()

  // Wait for the parse response itself, not a fixed delay: the dashboard's first loads
  // may still be running against a large local database.
  const parsed = page.waitForResponse(
    (response) => response.url().includes('/api/import/parse') && response.request().method() === 'POST',
    { timeout: 60_000 }
  )
  await page.getByTestId('excel-file-input').setInputFiles({
    name: `${marker}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from(csvFor(marker), 'utf8'),
  })
  expect((await parsed).ok()).toBe(true)

  await expect(page.getByTestId('mapping-select-email')).toHaveValue('Email')
  await expect(page.getByTestId('mapping-select-firstName')).toHaveValue('First Name')
  await expect(page.getByTestId('mapping-select-lastName')).toHaveValue('Last Name')

  await page.getByRole('button', { name: 'Preview Validation' }).click()
  const preview = page.getByTestId('import-change-preview')
  await expect(preview).toBeVisible()
  await expect(page.getByTestId('confirm-import')).toHaveText('Import 2 contacts', { timeout: 30_000 })
  await page.getByTestId('confirm-import').click()

  // Back on the dashboard, with the summary kept on screen.
  await expect(page.getByTestId('import-summary')).toContainText('2 added', { timeout: 30_000 })
}

/** The contact-list response for this search; the box waits for typing to pause first. */
function contactSearch(page: Page, q: string) {
  return page.waitForResponse(
    (response) => {
      const url = new URL(response.url())
      return url.pathname === '/api/contacts' && url.searchParams.get('q') === q
    },
    { timeout: 60_000 }
  )
}

async function searchFor(page: Page, marker: string) {
  const searched = contactSearch(page, marker)
  await page.getByPlaceholder(/search/i).fill(marker)
  expect((await searched).ok()).toBe(true)
  await expect(page.getByText(`Ada ${marker}`)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(`Bob ${marker}`)).toBeVisible()
}

test.describe('import and tags', () => {
  test.skip(!EMAIL || !PASSWORD, 'Set E2E_EMAIL and E2E_PASSWORD to run the signed-in specs.')

  test('a CSV is uploaded, mapped, previewed and committed, and the contacts appear', async ({ page }, testInfo) => {
    const marker = `E2e${testInfo.project.name.replace(/[^a-z]/gi, '')}${Date.now()}`

    await openDashboard(page)
    await importContacts(page, marker)
    await searchFor(page, marker)
    await expect(page.getByTestId('contacts-pagination')).toContainText('2')

    await page.getByTestId('import-summary').getByRole('button', { name: 'Dismiss' }).click()
    await expect(page.getByTestId('import-summary')).toBeHidden()
  })

  test('two contacts are bulk-tagged, and the tag filter finds them', async ({ page }, testInfo) => {
    const stamp = `${testInfo.project.name.replace(/[^a-z]/gi, '')}${Date.now()}`
    const marker = `E2eTag${stamp}`
    const tag = `e2e-tag-${stamp}`

    await openDashboard(page)
    await importContacts(page, marker)
    await searchFor(page, marker)

    await page.getByTestId('select-all-contacts').check()
    await page.getByRole('button', { name: 'Tag 2 selected' }).click()
    const picker = page.getByTestId('bulk-tag-picker-input')
    await picker.fill(tag)
    // Click the option itself: Enter picks the active suggestion, which can still be a
    // stale one from before the typed search returned.
    await page.getByRole('option', { name: new RegExp(`Create.*${tag}`) }).click()
    await expect(page.getByTestId('bulk-tag-picker').getByText(tag, { exact: true })).toBeVisible()
    // The suggestion list stays open for another pick and can overlap Apply, so Apply is
    // activated from the keyboard, as a keyboard user would.
    const apply = page.getByTestId('bulk-tag-apply')
    await apply.focus()
    await apply.press('Enter')
    await expect(page.getByTestId('bulk-tag-actions')).toContainText(/2 contacts/, { timeout: 30_000 })

    // Filter by the tag alone: exactly the two tagged contacts.
    await page.getByTestId('clear-selection').click()
    await page.getByPlaceholder(/search/i).fill('')
    const filter = page.getByTestId('tag-filter-input')
    await filter.fill(tag)
    await expect(page.getByRole('option', { name: tag, exact: true })).toBeVisible({ timeout: 30_000 })
    const filtered = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/contacts' && Boolean(new URL(response.url()).searchParams.get('tagIds')),
      { timeout: 60_000 }
    )
    await page.getByRole('option', { name: tag, exact: true }).click()
    await filter.press('Escape')
    expect((await filtered).ok()).toBe(true)

    await expect(page.getByText(`Ada ${marker}`)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(`Bob ${marker}`)).toBeVisible()
    await expect(page.getByTestId('contacts-pagination')).toContainText('2')
  })
})
