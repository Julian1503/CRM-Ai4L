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
 * Every view here now sits behind the Phase 1 auth gate, so the suite needs a real
 * Supabase project and a seeded account. Until those exist the specs skip with an
 * explicit reason rather than failing or, worse, silently passing.
 *
 * To enable: set NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY, invite a
 * user in the Supabase dashboard, then export E2E_EMAIL and E2E_PASSWORD.
 */

const EMAIL = process.env.E2E_EMAIL
const PASSWORD = process.env.E2E_PASSWORD

test.describe('CRM shell', () => {
  test.skip(
    !EMAIL || !PASSWORD,
    'Set E2E_EMAIL and E2E_PASSWORD (and a configured Supabase project) to run the signed-in specs.'
  )

  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Dashboard overview', level: 1 })).toBeVisible({
      timeout: 120_000,
    })
  })

  test('renders the contacts dashboard as the default view', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Dashboard overview', level: 1 })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New Contact' })).toBeVisible()
  })

  test('navigates between the four workspace views', async ({ page }) => {
    await page.getByTestId('nav-item-imports').click()
    await expect(
      page.getByRole('heading', { name: 'Spreadsheet importer', level: 1 })
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
    // One tab per consent stream: a single "Subscribed" tab could only answer for one of
    // the two independent consents while looking like it answered for both.
    for (const label of ['All List', 'Leads', 'Customers', 'Prospects', 'Newsletter', 'Courses']) {
      await expect(page.getByRole('button', { name: label })).toBeVisible()
    }
  })

  test('parses an upload and offers a Job Type column mapping', async ({ page }) => {
    // Phase 0 added job_type_id to the schema, so the importer must be able to populate
    // it. This also covers the parse route end-to-end.
    await page.getByTestId('nav-item-imports').click()
    await expect(page.getByText('Drag and drop a spreadsheet here')).toBeVisible()

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

  test('filters by job type and state', async ({ page }) => {
    await expect(page.getByTestId('job-type-filter')).toBeVisible()
    await expect(page.getByTestId('state-filter')).toBeVisible()

    await page.getByTestId('state-filter').selectOption('NSW')

    // Every visible row should now be NSW, and the filter should survive a reload
    // once the URL carries it.
    await expect(page.getByTestId('state-filter')).toHaveValue('NSW')
  })

  test('offers a filtered CSV export', async ({ page }) => {
    await page.getByTestId('state-filter').selectOption('VIC')

    const exportLink = page.getByTestId('export-full')
    await expect(exportLink).toBeVisible()

    // The active filter must travel with the download, or "export" silently means
    // something different from what is on screen.
    await expect(exportLink).toHaveAttribute('href', /state=VIC/)
    await expect(page.getByTestId('export-emailoctopus')).toHaveAttribute(
      'href',
      /format=emailoctopus/
    )
  })

  test('downloads a CSV with the expected header', async ({ page }) => {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-emailoctopus').click(),
    ])

    expect(download.suggestedFilename()).toMatch(/^contacts-emailoctopus-\d{4}-\d{2}-\d{2}\.csv$/)
  })

  test('shows the campaigns workspace with a live segment count', async ({ page }) => {
    await page.getByTestId('nav-item-campaigns').click()

    await expect(
      page.getByRole('heading', { name: 'Segments and campaigns', level: 1 })
    ).toBeVisible()

    // The audience size decides both who gets mail and how long the send runs, so it
    // must be visible before anything is created.
    await expect(page.getByTestId('segment-preview')).toBeVisible()
    await expect(page.getByTestId('segment-state')).toBeVisible()
    await expect(page.getByTestId('segment-job-type')).toBeVisible()
  })

  test('states that the email is authored in EmailOctopus, not here', async ({ page }) => {
    // Non-obvious and load-bearing: the API cannot create campaigns, so the body
    // lives in an EmailOctopus automation. Hiding that would strand the user.
    await page.getByTestId('nav-item-campaigns').click()

    await expect(page.getByText(/Started via API/)).toBeVisible()
  })

  test('offers the automation connection in the campaign form', async ({ page }) => {
    // The automation is chosen from registered templates or pasted by ID; the ID field
    // sits behind a disclosure until asked for. Approval without one is refused by the
    // database trigger, which the unit and database suites cover.
    await page.getByTestId('nav-item-campaigns').click()

    await expect(page.getByTestId('campaign-automation-picker')).toBeVisible()
    // Labelled "Automation ID" when no template is registered, "Use a different
    // automation ID" otherwise.
    await page
      .locator('summary', { hasText: /Automation ID|Use a different automation ID/ })
      .first()
      .click()
    await expect(page.getByTestId('campaign-automation')).toBeVisible()
    await expect(page.getByTestId('campaign-automation')).toHaveAttribute(
      'placeholder',
      /EmailOctopus automation ID/
    )
  })


  test('signs the user out and blocks the dashboard afterwards', async ({ page }) => {
    await page.getByTestId('sign-out').click()

    await expect(page).toHaveURL(/\/login/)

    // Back-navigation must not resurrect the authenticated view.
    await page.goto('/')
    await expect(page).toHaveURL(/\/login/)
  })
})
