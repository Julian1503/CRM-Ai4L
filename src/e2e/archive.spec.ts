import { expect, test } from '@playwright/test'

/**
 * Archive, restore and remove, end to end, on a segment.
 *
 * Signed in, against the configured Supabase project — see smoke.spec.ts for setup.
 *
 * Removing is a soft delete, so every run leaves one removed segment in the database,
 * hidden from the application. Its name carries the `e2e-archive-` prefix and a
 * timestamp, which is how to find these rows if they ever need looking at.
 */

const EMAIL = process.env.E2E_EMAIL
const PASSWORD = process.env.E2E_PASSWORD

test.describe('archive and remove', () => {
  test.skip(
    !EMAIL || !PASSWORD,
    'Set E2E_EMAIL and E2E_PASSWORD (and a configured Supabase project) to run the signed-in specs.'
  )

  test('a segment goes to the archive, comes back, and is removed for good', async ({ page }, testInfo) => {
    const name = `e2e-archive-${testInfo.project.name}-${Date.now()}`

    // The fixture is made through the API, which shares the signed-in session: the
    // behaviour under test is archiving, not the segment builder.
    const created = await page.request.post('/api/segments', { data: { name, definition: {} } })
    expect(created.ok()).toBe(true)
    const segmentId: string = (await created.json()).segment.id

    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Dashboard overview', level: 1 })).toBeVisible({
      timeout: 120_000,
    })

    // 1. Archive from the segment drawer: it closes and the segment leaves the list.
    await page.getByTestId('nav-item-campaigns').click()
    await expect(page.getByRole('heading', { name: 'Segments and campaigns', level: 1 })).toBeVisible()
    await page.getByTestId(`open-segment-${segmentId}`).click()
    await page.getByTestId('segment-archive').click()
    await expect(page.getByTestId('segment-drawer')).toBeHidden()
    await expect(page.getByTestId(`open-segment-${segmentId}`)).toHaveCount(0)

    // 2. It is in the archive, and restoring takes it out again.
    await page.getByTestId('nav-item-archive').click()
    await expect(page.getByRole('heading', { name: 'Archive', level: 1 })).toBeVisible()
    await page.getByTestId('archive-tab-segments').click()
    await expect(page.getByText(name)).toBeVisible()
    await page.getByTestId(`archived-segment-${segmentId}-restore`).click()
    await expect(page.getByText(name)).toHaveCount(0)

    // 3. Archived again, then removed: asked first, then gone from the archive too.
    const archived = await page.request.patch(`/api/segments/${segmentId}`, { data: { archived: true } })
    expect(archived.ok()).toBe(true)

    await page.getByTestId('archive-tab-contacts').click()
    await page.getByTestId('archive-tab-segments').click()
    await page.getByTestId(`archived-segment-${segmentId}-remove`).click()
    await expect(page.getByTestId('confirm-dialog')).toContainText('Nothing is deleted')
    await page.getByTestId('confirm-dialog-confirm').click()
    await expect(page.getByTestId('confirm-dialog')).toBeHidden()
    await expect(page.getByText(name)).toHaveCount(0)

    // 4. The application no longer knows it, and cannot bring it back.
    expect((await page.request.get(`/api/segments/${segmentId}`)).status()).toBe(404)
    const restore = await page.request.patch(`/api/segments/${segmentId}`, { data: { archived: false } })
    expect(restore.status()).toBe(404)
  })
})
