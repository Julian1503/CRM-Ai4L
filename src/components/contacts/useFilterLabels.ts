'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

import type { OrganisationOption } from '@/components/contacts/OrganisationPicker'
import type { TagOption } from '@/components/contacts/TagPicker'
import { getSupabaseClient, hasSupabaseConfig } from '@/lib/supabaseClient'

/**
 * The URL carries tag and organisation filters as ids (stable, short, shareable); the
 * chips show names. Names chosen in a picker are remembered; ids that arrive in a URL
 * (a reload, a shared link) are looked up once. An id that no longer exists shows as
 * "Unknown tag" rather than disappearing silently.
 */
export function useFilterLabels(tagIds: string[], organisationId: string | null) {
  const [tagNames, setTagNames] = useState<Record<string, string>>({})
  const [organisationNames, setOrganisationNames] = useState<Record<string, string>>({})

  const missingTagKey = useMemo(() => tagIds.filter((id) => !(id in tagNames)).join(','), [tagIds, tagNames])
  const missingOrganisation = organisationId && !(organisationId in organisationNames) ? organisationId : null

  useEffect(() => {
    if (!missingTagKey || !hasSupabaseConfig) return
    const missing = missingTagKey.split(',')
    let cancelled = false
    void Promise.resolve(getSupabaseClient().from('tags').select('id, name').in('id', missing)).then(({ data }) => {
      if (cancelled) return
      const found = Object.fromEntries(((data ?? []) as TagOption[]).map((tag) => [tag.id, tag.name]))
      setTagNames((current) => ({
        ...current,
        ...Object.fromEntries(missing.map((id) => [id, found[id] ?? 'Unknown tag'])),
      }))
    })
    return () => {
      cancelled = true
    }
  }, [missingTagKey])

  useEffect(() => {
    if (!missingOrganisation || !hasSupabaseConfig) return
    let cancelled = false
    void Promise.resolve(
      getSupabaseClient().from('organisations').select('id, name').eq('id', missingOrganisation).maybeSingle()
    ).then(({ data }) => {
      if (cancelled) return
      const name = (data as { name?: string } | null)?.name ?? 'Unknown organisation'
      setOrganisationNames((current) => ({ ...current, [missingOrganisation]: name }))
    })
    return () => {
      cancelled = true
    }
  }, [missingOrganisation])

  const tags = useMemo<TagOption[]>(() => tagIds.map((id) => ({ id, name: tagNames[id] ?? '…' })), [tagIds, tagNames])
  const organisation = useMemo<OrganisationOption | null>(
    () => (organisationId ? ({ id: organisationId, name: organisationNames[organisationId] ?? '…' } as OrganisationOption) : null),
    [organisationId, organisationNames]
  )

  const rememberTags = useCallback((chosen: TagOption[]) => {
    if (chosen.length === 0) return
    setTagNames((current) => ({ ...current, ...Object.fromEntries(chosen.map((tag) => [tag.id, tag.name])) }))
  }, [])

  const rememberOrganisation = useCallback((chosen: OrganisationOption | null) => {
    if (!chosen) return
    setOrganisationNames((current) => ({ ...current, [chosen.id]: chosen.name }))
  }, [])

  return { tags, organisation, rememberTags, rememberOrganisation }
}
