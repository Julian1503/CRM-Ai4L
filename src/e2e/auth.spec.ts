import { expect, test } from '@playwright/test'

/**
 * Authentication gate behaviour.
 *
 * Everything here exercises the *unauthenticated* paths, which are the
 * security-critical ones and need no Supabase project to verify. Signed-in journeys
 * live in smoke.spec.ts and skip until credentials exist.
 */

/**
 * True when the login page is rendering its "Supabase not configured" notice.
 *
 * Asserts the page actually rendered first. Without that check a *broken* login page
 * looks identical to a configured one — the config notice simply is not there — so a
 * runtime error silently turns into a skipped test. That is exactly how a 'use server'
 * export violation survived several phases here.
 */
async function isConfigNoticeShown(page: import('@playwright/test').Page): Promise<boolean> {
  await expect(page.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible()

  return page
    .getByTestId('config-error')
    .isVisible()
    .catch(() => false)
}

test.describe('unauthenticated access', () => {
  test('redirects the dashboard to /login', async ({ page }) => {
    await page.goto('/')

    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible()
  })

  test('remembers the intended destination', async ({ page }) => {
    await page.goto('/contacts?state=NSW')

    const url = new URL(page.url())
    expect(url.pathname).toBe('/login')
    expect(url.searchParams.get('next')).toBe('/contacts?state=NSW')
  })

  // Open-redirect probes. These need the rendered form, so they skip while Supabase
  // is unconfigured. The sanitiser itself is covered exhaustively by
  // src/lib/auth/redirect.test.ts (15 attack vectors).
  test.describe('next parameter sanitisation', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/login')
      const configMissing = await isConfigNoticeShown(page)
      test.skip(configMissing, 'Supabase not configured, so the login form is not rendered')
    })

    test('never forwards an off-site next parameter', async ({ page }) => {
      await page.goto('/login?next=https://evil.example.com/harvest')

      await expect(page.locator('input[name="next"]')).toHaveValue('/')
    })

    test('never forwards a protocol-relative next parameter', async ({ page }) => {
      await page.goto('/login?next=//evil.example.com')

      await expect(page.locator('input[name="next"]')).toHaveValue('/')
    })

    test('preserves a legitimate relative destination', async ({ page }) => {
      await page.goto('/login?next=/contacts%3Fstate%3DNSW')

      await expect(page.locator('input[name="next"]')).toHaveValue('/contacts?state=NSW')
    })
  })

  test('answers API routes with 401 rather than redirecting', async ({ request }) => {
    const response = await request.get('/api/locations/autocomplete?text=sydney', {
      maxRedirects: 0,
    })

    expect(response.status()).toBe(401)
    expect(await response.json()).toMatchObject({ error: expect.any(String) })
  })

  test('protects the contact export, which returns the whole database', async ({
    request,
  }) => {
    const response = await request.get('/api/contacts/export?format=full', {
      maxRedirects: 0,
    })

    expect(response.status()).toBe(401)
    // A redirect here would hand an anonymous caller an HTML page instead of a
    // refusal, and a 200 would hand them the client list.
    expect(await response.text()).not.toContain('EmailAddress')
  })

  test('protects the contact list, including the archive view', async ({ request }) => {
    expect((await request.get('/api/contacts', { maxRedirects: 0 })).status()).toBe(401)
    expect(
      (await request.get('/api/contacts?includeArchived=true', { maxRedirects: 0 })).status()
    ).toBe(401)
  })

  test('protects contact archival', async ({ request }) => {
    const response = await request.delete('/api/contacts/some-id', { maxRedirects: 0 })

    expect(response.status()).toBe(401)
  })

  test('protects contact restoration', async ({ request }) => {
    const response = await request.post('/api/contacts/some-id', {
      data: {},
      maxRedirects: 0,
    })

    expect(response.status()).toBe(401)
  })

  test('protects segment listing and creation', async ({ request }) => {
    expect((await request.get('/api/segments', { maxRedirects: 0 })).status()).toBe(401)
    expect(
      (await request.post('/api/segments', { data: { name: 'x' }, maxRedirects: 0 })).status()
    ).toBe(401)
  })

  test('protects the segment preview, which counts real contacts', async ({ request }) => {
    const response = await request.post('/api/segments/preview', {
      data: { definition: {} },
      maxRedirects: 0,
    })

    expect(response.status()).toBe(401)
  })

  test('protects campaign listing and creation', async ({ request }) => {
    expect((await request.get('/api/campaigns', { maxRedirects: 0 })).status()).toBe(401)
    expect(
      (await request.post('/api/campaigns', { data: { name: 'x' }, maxRedirects: 0 })).status()
    ).toBe(401)
  })

  test('protects campaign approval', async ({ request }) => {
    // Approval authorises irreversible sending.
    const response = await request.post('/api/campaigns/some-id/approve', {
      data: {},
      maxRedirects: 0,
    })

    expect(response.status()).toBe(401)
  })

  test('protects campaign sending', async ({ request }) => {
    // The one endpoint that queues mail which cannot be recalled.
    const response = await request.post('/api/campaigns/some-id/send', {
      data: {},
      maxRedirects: 0,
    })

    expect(response.status()).toBe(401)
  })

  test('protects the emailoctopus sync route, which acts on behalf of a user', async ({
    request,
  }) => {
    const response = await request.post('/api/integrations/emailoctopus/sync', {
      data: {},
      maxRedirects: 0,
    })

    expect(response.status()).toBe(401)
  })

  test('protects the operational health aggregate', async ({ request }) => {
    const response = await request.get('/api/operations/summary', { maxRedirects: 0 })

    expect(response.status()).toBe(401)
  })

  test('lets the emailoctopus webhook through to its own signature check', async ({
    request,
  }) => {
    const response = await request.post('/api/integrations/emailoctopus/webhook', {
      data: { nonsense: true },
      maxRedirects: 0,
    })

    // Both the proxy and the handler answer 401, so the status alone proves nothing.
    // The *message* is the discriminator: "Invalid signature" can only come from the
    // handler, which means the request reached it rather than being gated upstream.
    expect(response.status()).toBe(401)
    expect(await response.json()).toMatchObject({ error: 'Invalid signature.' })
  })

  test('rejects an unsigned webhook rather than trusting it', async ({ request }) => {
    // The handler writes with the service-role key, bypassing RLS. Without the
    // signature check, anyone with the URL could inject or unsubscribe contacts.
    const response = await request.post('/api/integrations/emailoctopus/webhook', {
      data: {
        event: 'contact.subscribed',
        contact: { email_address: 'attacker@evil.example.com' },
      },
      maxRedirects: 0,
    })

    expect(response.status()).toBe(401)
  })

  test('lets a lead reach the booking page without an account', async ({ page }) => {
    // Leads are not CRM users. Gating this behind /login would make every campaign
    // link a dead end.
    await page.goto('/book/some-token')

    expect(new URL(page.url()).pathname).toBe('/book/some-token')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  })

  test('shows one message for an unrecognised booking token', async ({ page }) => {
    // Distinguishing "expired" from "not found" would let someone probe for valid
    // tokens.
    await page.goto('/book/definitely-not-a-real-token')

    await expect(page.getByText(/no longer valid/i)).toBeVisible()
  })

  test('does not gate the booking checkout endpoint behind a session', async ({
    request,
  }) => {
    const response = await request.post('/api/booking/create-session', {
      data: {},
      maxRedirects: 0,
    })

    // Any status but 401 proves it reached the handler; the token is the credential.
    expect(response.status()).not.toBe(401)
    expect([400, 404, 410, 503]).toContain(response.status())
  })

  test('rejects an unsigned Stripe webhook', async ({ request }) => {
    const response = await request.post('/api/stripe/webhook', {
      data: { id: 'evt_1', type: 'checkout.session.completed' },
      maxRedirects: 0,
    })

    expect(response.status()).toBe(401)
  })

  test('rejects an unsigned Calendly webhook', async ({ request }) => {
    // Without this an attacker could mark arbitrary consultations as booked.
    const response = await request.post('/api/calendly/webhook', {
      data: { event: 'invitee.created', payload: { uri: 'x' } },
      maxRedirects: 0,
    })

    expect(response.status()).toBe(401)
    expect(await response.json()).toMatchObject({ error: 'Invalid signature.' })
  })

  test('serves static assets without redirecting them to /login', async ({ request }) => {
    // A matcher that catches assets breaks CSS and JS on the login page itself.
    const response = await request.get('/robots.txt', { maxRedirects: 0 })

    expect(response.status()).toBe(200)
    expect(await response.text()).toContain('Disallow: /')
  })
})

test.describe('login page', () => {
  test('rejects an empty submission client-side without calling the server', async ({
    page,
  }) => {
    await page.goto('/login')

    const configMissing = await isConfigNoticeShown(page)
    test.skip(configMissing, 'Supabase not configured, so no form is rendered')

    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page.getByText('Enter your email address.')).toBeVisible()
    await expect(page.getByText('Enter your password.')).toBeVisible()
  })

  test('states plainly when sign-in is unavailable', async ({ page }) => {
    await page.goto('/login')

    const configMissing = await isConfigNoticeShown(page)
    test.skip(!configMissing, 'Supabase is configured, so the form renders instead')

    // The gate fails closed. It must say why rather than silently looping.
    await expect(page.getByTestId('config-error')).toContainText('Supabase is not configured')
  })
})

test.describe('security headers', () => {
  test('sets the baseline hardening headers', async ({ request }) => {
    const response = await request.get('/login')
    const headers = response.headers()

    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
    expect(headers['permissions-policy']).toContain('camera=()')
    expect(headers['x-robots-tag']).toContain('noindex')
  })
})
