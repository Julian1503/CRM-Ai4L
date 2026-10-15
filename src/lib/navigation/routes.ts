/**
 * The CRM's workspaces as real routes (UX plan P1.1), and the translation from the old
 * single-page `/?view=<x>` addresses.
 *
 * Old links are still out there — newsletter review emails, the social OAuth callback,
 * links into the Content Studio — so `/` keeps accepting `?view=` and redirects to the
 * route it names, carrying every other parameter across unchanged.
 */

export const ACTIVE_VIEWS = ['contacts', 'archive', 'campaigns', 'content', 'bookings', 'imports', 'integrations', 'settings'] as const

export type ActiveView = (typeof ACTIVE_VIEWS)[number]

export const DEFAULT_VIEW: ActiveView = 'contacts'

/** The path of each workspace. */
export const VIEW_ROUTES: Readonly<Record<ActiveView, string>> = {
  contacts: '/contacts',
  archive: '/archive',
  campaigns: '/campaigns',
  content: '/content',
  bookings: '/bookings',
  imports: '/imports',
  integrations: '/integrations',
  settings: '/settings',
}

export function isActiveView(value: unknown): value is ActiveView {
  return typeof value === 'string' && (ACTIVE_VIEWS as readonly string[]).includes(value)
}

/** The workspace a pathname belongs to (sub-paths included), or null outside the CRM shell. */
export function viewForPath(pathname: string | null | undefined): ActiveView | null {
  if (!pathname) return null
  return (
    ACTIVE_VIEWS.find((view) => pathname === VIEW_ROUTES[view] || pathname.startsWith(`${VIEW_ROUTES[view]}/`)) ?? null
  )
}

type SearchParamsInput = URLSearchParams | Record<string, string | string[] | undefined>

function toSearchParams(input: SearchParamsInput): URLSearchParams {
  if (input instanceof URLSearchParams) return new URLSearchParams(input)

  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue
    for (const entry of Array.isArray(value) ? value : [value]) params.append(key, entry)
  }
  return params
}

/**
 * Where `/` sends a request: the route `?view=` names (an unknown or missing view means
 * contacts), with every other parameter preserved — `?view=campaigns&campaign=1` becomes
 * `/campaigns?campaign=1`, `?view=settings&social=connected` becomes
 * `/settings?social=connected`.
 */
export function legacyRedirectTarget(input: SearchParamsInput): string {
  const params = toSearchParams(input)
  const requested = params.get('view')
  const view = isActiveView(requested) ? requested : DEFAULT_VIEW
  params.delete('view')

  const query = params.toString()
  return query ? `${VIEW_ROUTES[view]}?${query}` : VIEW_ROUTES[view]
}
