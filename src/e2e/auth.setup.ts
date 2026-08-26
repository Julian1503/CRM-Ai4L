import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { expect, test as setup } from '@playwright/test'

const AUTH_STATE_PATH = 'test-results/.auth/user.json'

setup('authenticate the CRM operator once', async ({ page }) => {
  const email = process.env.E2E_EMAIL
  const password = process.env.E2E_PASSWORD

  if (!email || !password) {
    throw new Error('E2E_EMAIL and E2E_PASSWORD are required by the auth setup project.')
  }

  await page.goto('/login')
  await page.getByLabel('Email address').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()

  await expect(page.getByRole('heading', { name: 'Dashboard overview', level: 1 })).toBeVisible({
    timeout: 120_000,
  })

  await mkdir(dirname(AUTH_STATE_PATH), { recursive: true })
  await page.context().storageState({ path: AUTH_STATE_PATH })
})
