import type { ArchivedPage, ArchivedRecord } from './ArchivedRecordsList'

/**
 * Where each archive tab reads from.
 *
 * Segments and campaigns can be many, so their APIs page and filter server-side
 * (`?archived=true`). Templates and schedules are few by nature and their APIs return
 * everything with `?includeArchived=true`; the archived ones are picked and paged here.
 * Removed records never come back from any of them.
 */

export type ArchiveSource = {
  noun: string
  plural: string
  endpoint: (id: string) => string
  load: (page: number, pageSize: number) => Promise<ArchivedPage>
  emptyHint: string
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url)
  const body = await response.json().catch(() => ({}))

  if (!response.ok) throw new Error(body.error || `Request failed (HTTP ${response.status})`)

  return body
}

type Row = Record<string, unknown> & { id: string; name: string; archived_at: string | null }

function paged(url: string, key: string, toRecord: (row: Row) => ArchivedRecord) {
  return async (page: number, pageSize: number): Promise<ArchivedPage> => {
    const params = new URLSearchParams({ archived: 'true', page: String(page), pageSize: String(pageSize) })
    const body = await getJson(`${url}?${params.toString()}`)

    return {
      records: ((body[key] as Row[] | undefined) ?? []).map(toRecord),
      total: Number(body.total ?? 0),
    }
  }
}

function pickedArchived(url: string, key: string, toRecord: (row: Row) => ArchivedRecord) {
  return async (page: number, pageSize: number): Promise<ArchivedPage> => {
    const body = await getJson(`${url}?includeArchived=true`)
    const archived = ((body[key] as Row[] | undefined) ?? []).filter((row) => row.archived_at)
    const from = (page - 1) * pageSize

    return { records: archived.slice(from, from + pageSize).map(toRecord), total: archived.length }
  }
}

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  in_review: 'In review',
  failed: 'Failed',
  sent: 'Sent',
}

export const ARCHIVE_SOURCES: Record<'segments' | 'campaigns' | 'templates' | 'schedules', ArchiveSource> = {
  segments: {
    noun: 'segment',
    plural: 'segments',
    endpoint: (id) => `/api/segments/${id}`,
    load: paged('/api/segments', 'segments', (row) => ({
      id: row.id,
      name: row.name,
      archivedAt: row.archived_at,
      detail: (row.description as string | null) ?? null,
    })),
    emptyHint: 'Nothing archived. Segments you archive from the segment drawer appear here.',
  },
  campaigns: {
    noun: 'campaign',
    plural: 'campaigns',
    endpoint: (id) => `/api/campaigns/${id}`,
    load: paged('/api/campaigns', 'campaigns', (row) => {
      const segment = (row.segment as { name?: string } | null)?.name
      const status = STATUS_LABELS[String(row.status)] ?? String(row.status)

      return {
        id: row.id,
        name: row.name,
        archivedAt: row.archived_at,
        detail: segment ? `${status} · ${segment}` : status,
      }
    }),
    emptyHint: 'Nothing archived. Campaigns you archive from the campaign list appear here.',
  },
  templates: {
    noun: 'template',
    plural: 'templates',
    endpoint: (id) => `/api/templates/${id}`,
    load: pickedArchived('/api/templates', 'templates', (row) => ({
      id: row.id,
      name: row.name,
      archivedAt: row.archived_at,
      detail: (row.description as string | null) ?? (row.provider_automation_id as string | null) ?? null,
    })),
    emptyHint: 'Nothing archived. Archived email templates also stay listed under Settings.',
  },
  schedules: {
    noun: 'schedule',
    plural: 'schedules',
    endpoint: (id) => `/api/newsletter-schedules/${id}`,
    load: pickedArchived('/api/newsletter-schedules', 'schedules', (row) => ({
      id: row.id,
      name: row.name,
      archivedAt: row.archived_at,
      detail: `${String(row.frequency ?? '')}`.replace(/^./, (letter) => letter.toUpperCase()) || null,
    })),
    emptyHint: 'Nothing archived. Newsletter schedules you archive appear here.',
  },
}
