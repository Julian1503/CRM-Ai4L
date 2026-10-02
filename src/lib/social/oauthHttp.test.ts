/** @jest-environment node */
import { NextRequest } from 'next/server'

import { appOrigin, callbackUrl, isSameOrigin, settingsRedirect } from './oauthHttp'

const request = (headers: Record<string, string> = {}) =>
  new NextRequest('http://internal:3000/api/social/oauth/meta/start', { method: 'POST', headers })

describe('oauthHttp', () => {
  it('prefers NEXT_PUBLIC_APP_URL for the registered callback, falling back to the request origin', () => {
    expect(callbackUrl(request(), 'meta', { NEXT_PUBLIC_APP_URL: 'https://crm.example.com/some/path' })).toBe(
      'https://crm.example.com/api/social/oauth/meta/callback'
    )
    expect(appOrigin(request(), { NEXT_PUBLIC_APP_URL: 'not a url' })).toBe('http://internal:3000')
    expect(appOrigin(request(), {})).toBe('http://internal:3000')
  })

  it('redirects to Settings with only short, non-sensitive parameters', () => {
    const response = settingsRedirect(request(), 'connected', { count: 2 }, {})
    const url = new URL(response.headers.get('location') ?? '')
    expect(response.status).toBe(303)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(Object.fromEntries(url.searchParams)).toEqual({ view: 'settings', social: 'connected', count: '2' })
  })

  it.each([
    [{}, true],
    [{ 'sec-fetch-site': 'cross-site' }, false],
    [{ origin: 'http://internal:3000' }, true],
    [{ origin: 'https://crm.example.com' }, true],
    [{ origin: 'https://evil.example' }, false],
  ])('same-origin check %j → %s', (headers, expected) => {
    expect(isSameOrigin(request(headers), { NEXT_PUBLIC_APP_URL: 'https://crm.example.com' })).toBe(expected)
  })
})
