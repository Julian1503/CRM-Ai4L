import { redirect } from 'next/navigation'

import { legacyRedirectTarget } from '@/lib/navigation/routes'

/**
 * `/` is no longer a workspace: it sends the user to Contacts, or — for the old
 * single-page addresses still out in emails and OAuth callbacks (`/?view=campaigns&campaign=…`,
 * `/?view=settings&social=…`, `/?view=content&item=…`) — to the route the `view` names,
 * with every other parameter carried across.
 */
export default async function Root({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  redirect(legacyRedirectTarget(await searchParams))
}
