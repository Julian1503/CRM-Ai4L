import { join } from 'node:path'

import { expect, test } from '@playwright/test'

/**
 * Baseline behaviour of the CRM shell.
 *
 * `playwright.config.ts` has always pointed testDir at `src/e2e`, but the directory did
 * not exist, so `npm run test:e2e` collected zero tests and reported success. These
 * specs give the suite something real to assert and act as the regression net for the
 * Phase 2 decomposition of src/app/page.tsx.
 *
 * Deliberately asserts only what holds without a configured Supabase project, so it is
 * runnable on a clean checkout. Data-dependent flows arrive with auth in Phase 1.
 */

test.describe('CRM shell', () => {
  test('renders the contacts dashboard as the default view', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByRole('heading', { name: 'Dashboard overview', level: 1 })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New Contact' })).toBeVisible()
  })

  test('navigates between the four workspace views', async ({ page }) => {
    await page.goto('/')

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
    await page.goto('/')

    for (const label of ['All List', 'Customers', 'Prospects', 'Subscribed']) {
      await expect(page.getByRole('button', { name: label })).toBeVisible()
    }
  })

  test('parses an upload and offers a Job Type column mapping', async ({ page }) => {
    // Phase 0 added job_type_id to the schema, so the importer must be able to populate
    // it. This also covers the parse route end-to-end.
    await page.goto('/')
    await page.getByTestId('nav-item-imports').click()
    await expect(page.getByText('Drag and drop XLS files here')).toBeVisible()

    await page
      .getByTestId('excel-file-input')
      .setInputFiles(join(__dirname, '../test/fixtures/contacts-sample.csv'))

    // Mapping table renders once the file is parsed.
    const jobTypeSelect = page.getByTestId('mapping-select-jobTypeName')
    await expect(jobTypeSelect).toBeVisible()

    // The "Job Type" header should have been auto-mapped by the header heuristic.
    await expect(jobTypeSelect).toHaveValue('Job Type')
    await expect(page.getByTestId('mapping-select-email')).toHaveValue('Email')
    await expect(page.getByTestId('mapping-select-organisationName')).toHaveValue('Company')
  })

  test('surfaces a clear notice when the database is unreachable', async ({ page }) => {
    await page.goto('/')

    // Either connected (no banner) or a banner that names the problem — never a blank screen.
    const banner = page.getByText('Live database unavailable:')
    const table = page.getByRole('table')

    await expect(banner.or(table).first()).toBeVisible()
  })
})
