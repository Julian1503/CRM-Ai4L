import {
  PUBLIC_PATHS,
  WEBHOOK_PATHS,
  isApiPath,
  isPublicPath,
  isWebhookPath,
} from './routes'

describe('auth/routes', () => {
  describe('isPublicPath', () => {
    it.each(PUBLIC_PATHS)('treats %s as public', (path) => {
      expect(isPublicPath(path)).toBe(true)
    })

    it('allows sub-paths of a public route', () => {
      expect(isPublicPath('/auth/callback/confirm')).toBe(true)
    })

    it.each(['/', '/contacts', '/settings', '/api/contacts/export'])(
      'treats %s as protected',
      (path) => {
        expect(isPublicPath(path)).toBe(false)
      }
    )

    it('does not let a prefix collision open a protected route', () => {
      // '/loginsomething' must not inherit '/login'.
      expect(isPublicPath('/loginsomething')).toBe(false)
      expect(isPublicPath('/login-admin')).toBe(false)
    })

    it('is not fooled by a public segment appearing later in the path', () => {
      expect(isPublicPath('/contacts/login')).toBe(false)
      expect(isPublicPath('/api/login')).toBe(false)
    })

    it('opens the lead-facing booking pages', () => {
      // Leads have no CRM account. The booking token is the credential instead.
      expect(isPublicPath('/book/abc123')).toBe(true)
      expect(isPublicPath('/book/abc123/scheduled')).toBe(true)
      expect(isPublicPath('/api/booking/create-session')).toBe(true)
    })

    it('does not let the short /book prefix open unrelated routes', () => {
      expect(isPublicPath('/bookkeeping')).toBe(false)
      expect(isPublicPath('/books')).toBe(false)
      expect(isPublicPath('/api/bookings')).toBe(false)
      expect(isPublicPath('/api/bookings/export')).toBe(false)
    })
  })

  describe('isWebhookPath', () => {
    it.each(WEBHOOK_PATHS)('exempts %s from the session gate', (path) => {
      expect(isWebhookPath(path)).toBe(true)
    })

    it('matches on exact path only, so a suffix cannot be used to bypass auth', () => {
      // A wildcard on '/webhook' would let any new route ending in /webhook
      // silently opt out of authentication. Allowlist is exact.
      expect(isWebhookPath('/api/contacts/webhook')).toBe(false)
      expect(isWebhookPath('/api/evil/webhook')).toBe(false)
    })

    it('does not exempt sub-paths of a webhook route', () => {
      expect(isWebhookPath('/api/integrations/emailoctopus/webhook/extra')).toBe(false)
    })

    it('ignores a trailing slash difference', () => {
      expect(isWebhookPath('/api/integrations/emailoctopus/webhook/')).toBe(true)
    })

    it('does not exempt the sync route, which acts on behalf of a user', () => {
      expect(isWebhookPath('/api/integrations/emailoctopus/sync')).toBe(false)
    })
  })

  describe('isApiPath', () => {
    it.each(['/api/contacts', '/api/import/parse'])('detects %s as an API route', (path) => {
      expect(isApiPath(path)).toBe(true)
    })

    it.each(['/', '/login', '/apiary'])('does not treat %s as an API route', (path) => {
      expect(isApiPath(path)).toBe(false)
    })
  })
})
