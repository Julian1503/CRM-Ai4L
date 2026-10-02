import { expect, test, type Page } from '@playwright/test'

import { FakeWorker, workerSecret } from './helpers/fakeWorker'

/**
 * Content Studio, end to end, signed in, against the local stack.
 *
 * The content engine is played by the test itself (helpers/fakeWorker.ts): it claims the
 * generation the UI queued and completes it with mock variants over the signed worker
 * protocol, so the UI's polling, the variant list and the review flow are exercised with
 * no AI or social provider involved. Requires CONTENT_STUDIO_ENABLED=true on the server
 * and the same CONTENT_WORKER_SECRET in the test environment.
 *
 * Every run leaves one content item behind (nothing is physically deleted); its title
 * carries the `e2e-content-` prefix and a timestamp.
 */

const EMAIL = process.env.E2E_EMAIL
const PASSWORD = process.env.E2E_PASSWORD
const SECRET = workerSecret()

async function openStudio(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Dashboard overview', level: 1 })).toBeVisible({ timeout: 120_000 })
  await page.getByTestId('nav-item-content').click()
  await expect(page.getByRole('heading', { name: 'Content Studio', level: 1 })).toBeVisible()
}

test.describe('Content Studio', () => {
  test.skip(!EMAIL || !PASSWORD, 'Set E2E_EMAIL and E2E_PASSWORD to run the signed-in specs.')

  test('brief, generation by the worker protocol, edit, approve, edit voids approval', async ({ page, request }, testInfo) => {
    test.skip(!SECRET, 'Set CONTENT_WORKER_SECRET (32+ characters, same as the server) so the test can play the content engine.')
    const title = `e2e-content-${testInfo.project.name}-${Date.now()}`

    await openStudio(page)
    await page.getByLabel('Title').fill(title)
    await page.getByLabel('Topic').fill('Automating invoices for accountants')
    await page.getByRole('button', { name: 'Create and generate' }).click()

    await expect(page.getByRole('heading', { name: title, level: 2 })).toBeVisible()
    const progress = page.getByRole('region', { name: 'Generation progress' })
    await expect(progress.getByText('Queued')).toBeVisible()

    const listed = await page.request.get(`/api/content-studio/items?search=${encodeURIComponent(title)}`)
    expect(listed.ok()).toBe(true)
    const itemId: string = (await listed.json()).items[0].id

    const worker = new FakeWorker(request, SECRET as string)
    const job = await worker.claimGeneration(itemId)
    await worker.completeGeneration(job, (channel) => `Mock ${channel} copy for ${title}.`)

    // The UI polls the job and reloads the item once it succeeds.
    const card = page.getByRole('article', { name: /^linkedin variant/ })
    await expect(card).toBeVisible({ timeout: 60_000 })
    await expect(card.getByText('Pending review')).toBeVisible()

    await card.getByRole('button', { name: 'Edit' }).click()
    await card.getByLabel('Body').fill('Edited by a person before approval.')
    await card.getByRole('button', { name: 'Save revision' }).click()
    await expect(card.getByText(/Revision 2/)).toBeVisible()

    await card.getByRole('button', { name: 'Approve revision 2' }).click()
    await expect(card.getByText('Approved', { exact: true })).toBeVisible()

    // Any edit is a new revision, and the approval belongs to the old one.
    await card.getByRole('button', { name: 'Edit' }).click()
    await card.getByLabel('Body').fill('Edited again after approval.')
    await card.getByRole('button', { name: 'Save revision' }).click()
    await expect(card.getByText(/Revision 3/)).toBeVisible()
    await expect(card.getByText('Pending review')).toBeVisible()

    // Keyboard: the reject dialog takes focus, keeps it, and gives it back on Escape.
    const reject = card.getByRole('button', { name: 'Reject' })
    await reject.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Reject this revision?' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('textbox')).toBeFocused()
    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press('Tab')
      expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true)
    }
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(reject).toBeFocused()
  })

  test('fits a phone screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/?view=content')

    await expect(page.getByRole('heading', { name: 'Content Studio', level: 1 })).toBeVisible({ timeout: 120_000 })
    await expect(page.getByRole('tablist', { name: 'Content Studio sections' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Create and generate' })).toBeVisible()

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)
  })
})
