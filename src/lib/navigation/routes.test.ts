/** @jest-environment node */
import { isActiveView, legacyRedirectTarget, VIEW_ROUTES, viewForPath } from './routes'

describe('viewForPath', () => {
  it('maps each route and its sub-paths to its workspace', () => {
    expect(viewForPath('/contacts')).toBe('contacts')
    expect(viewForPath('/settings')).toBe('settings')
    expect(viewForPath('/content/anything')).toBe('content')
  })

  it('is null outside the shell and for look-alike prefixes', () => {
    expect(viewForPath('/')).toBeNull()
    expect(viewForPath('/contactsx')).toBeNull()
    expect(viewForPath(null)).toBeNull()
    expect(viewForPath(undefined)).toBeNull()
  })
})

describe('legacyRedirectTarget', () => {
  it.each([
    [{ view: 'campaigns', campaign: 'c-1' }, '/campaigns?campaign=c-1'],
    [{ view: 'settings', social: 'connected', count: '2' }, '/settings?social=connected&count=2'],
    [{ view: 'content', item: 'i-1', studioSection: 'review' }, '/content?item=i-1&studioSection=review'],
    [{ view: 'settings', section: 'brand' }, '/settings?section=brand'],
    [{ view: 'imports' }, '/imports'],
    [{}, '/contacts'],
    [{ view: 'unknown', q: 'ada' }, '/contacts?q=ada'],
    [{ view: ['bookings', 'archive'] }, '/bookings'],
  ])('sends %p to %s', (params, target) => {
    expect(legacyRedirectTarget(params as never)).toBe(target)
  })

  it('accepts URLSearchParams, keeps repeated values and drops undefined', () => {
    expect(legacyRedirectTarget(new URLSearchParams('view=archive&a=1&a=2'))).toBe('/archive?a=1&a=2')
    expect(legacyRedirectTarget({ view: 'archive', gone: undefined })).toBe('/archive')
  })
})

describe('isActiveView / VIEW_ROUTES', () => {
  it('knows every workspace and nothing else', () => {
    expect(Object.keys(VIEW_ROUTES)).toHaveLength(8)
    expect(isActiveView('bookings')).toBe(true)
    expect(isActiveView('admin')).toBe(false)
    expect(isActiveView(3)).toBe(false)
  })
})
