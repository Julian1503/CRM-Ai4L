import { expect, test } from '@playwright/test'

/**
 * Approved membership, end to end (audit C1).
 *
 * A correct password is not CRM access. These accounts exist in the local test stack
 * (scripts/seed-e2e.mjs): one verified account that was never approved — what public
 * signup used to produce — and one whose membership was disabled.
 *
 * Each test starts signed out: it must not inherit the operator's storage state.
 */

const PASSWORD = process.env.E2E_PASSWORD
const DENIED_ACCOUNTS = [
  ['a never-approved account', process.env.E2E_UNAPPROVED_EMAIL],
  ['a disabled member', process.env.E2E_DISABLED_EMAIL],
] as const

test.use({ storageState: { cookies: [], origins: [] } })

for (const [label, email] of DENIED_ACCOUNTS) {
  test.describe(`sign-in by ${label}`, () => {
    test.skip(
      !email || !PASSWORD,
      'Seed the local stack (scripts/seed-e2e.mjs) and set E2E_UNAPPROVED_EMAIL / E2E_DISABLED_EMAIL.'
    )

    test('is refused with an explanation and leaves no usable session', async ({ page }) => {
      await page.goto('/login')
      await page.getByLabel('Email address').fill(email!)
      await page.getByLabel('Password', { exact: true }).fill(PASSWORD!)
      await page.getByRole('button', { name: 'Sign in' }).click()

      await expect(page.getByText(/not approved for CRM access/)).toBeVisible()
      await expect(page).toHaveURL(/\/login/)

      // The dashboard and its data stay closed even after the attempt.
      await page.goto('/')
      await expect(page).toHaveURL(/\/login/)

      const api = await page.request.get('/api/contacts')
      expect([401, 403]).toContain(api.status())
    })
  })
}
