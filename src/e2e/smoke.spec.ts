import { join } from 'node:path'

import { expect, type Page, test } from '@playwright/test'

/**
 * Baseline behaviour of the CRM shell.
 *
 * `playwright.config.ts` has always pointed testDir at `src/e2e`, but the directory did
 * not exist, so `npm run test:e2e` collected zero tests and reported success. These
 * specs give the suite something real to assert and act as the regression net for the
 * Phase 2 decomposition of src/app/page.tsx.
 *
 * Every view here now sits behind the Phase 1 auth gate, so the suite needs a real
 * Supabase project and a seeded account. Until those exist the specs skip with an
 * explicit reason rather than failing or, worse, silently passing.
 *
 * To enable: set NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY, invite a
 * user in the Supabase dashboard, then export E2E_EMAIL and E2E_PASSWORD.
 */

const EMAIL = process.env.E2E_EMAIL
const PASSWORD = process.env.E2E_PASSWORD

async function signIn(page: Page): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Email address').fill(EMAIL!)
  await page.getByLabel('Password').fill(PASSWORD!)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'))
}

test.describe('CRM shell', () => {
  test.skip(
    !EMAIL || !PASSWORD,
    'Set E2E_EMAIL and E2E_PASSWORD (and a configured Supabase project) to run the signed-in specs.'
  )

  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test('renders the contacts dashboard as the default view', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Dashboard overview', level: 1 })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New Contact' })).toBeVisible()
  })

  test('navigates between the four workspace views', async ({ page }) => {
    await page.getByTestId('nav-item-imports').click()
    await expect(
      page.getByRole('heading', { name: 'Excel spreadsheet importer', level: 1 })
    ).toBeVisible()

    await page.getByTestId('nav-item-integrations').click()
    await expect(
      page.getByRole('heading', { name: 'EmailOctopus campaigns', level: 1 })
    ).toBeVisible()

    await page.getByTestId('nav-item-settings').click()
    await expect(page.getByRole('heading', { name: 'System settings', level: 1 })).toBeVisible()

    await page.getByTestId('nav-item-contacts').click()
    await expect(page.getByRole('heading', { name: 'Dashboard overview', level: 1 })).toBeVisible()
  })

  test('exposes the status filter controls', async ({ page }) => {
    for (const label of ['All List', 'Customers', 'Prospects', 'Subscribed']) {
      await expect(page.getByRole('button', { name: label })).toBeVisible()
    }
  })

  test('parses an upload and offers a Job Type column mapping', async ({ page }) => {
    // Phase 0 added job_type_id to the schema, so the importer must be able to populate
    // it. This also covers the parse route end-to-end.
    await page.getByTestId('nav-item-imports').click()
    await expect(page.getByText('Drag and drop XLS files here')).toBeVisible()

    await page
      .getByTestId('excel-file-input')
      .setInputFiles(join(__dirname, '../test/fixtures/contacts-sample.csv'))

    const jobTypeSelect = page.getByTestId('mapping-select-jobTypeName')
    await expect(jobTypeSelect).toBeVisible()

    // The "Job Type" header should have been auto-mapped by the header heuristic.
    await expect(jobTypeSelect).toHaveValue('Job Type')
    await expect(page.getByTestId('mapping-select-email')).toHaveValue('Email')
    await expect(page.getByTestId('mapping-select-organisationName')).toHaveValue('Company')
  })

  test('signs the user out and blocks the dashboard afterwards', async ({ page }) => {
    await page.getByTestId('sign-out').click()

    await expect(page).toHaveURL(/\/login/)

    // Back-navigation must not resurrect the authenticated view.
    await page.goto('/')
    await expect(page).toHaveURL(/\/login/)
  })
})
