import { NextResponse, type NextRequest } from 'next/server'

import { getSession } from '@/lib/auth/dal'
import {
  EXPORT_MAX_ROWS,
  buildContactCsv,
  buildExportFilename,
  isExportFormat,
  type ExportFormat,
} from '@/lib/contacts/export'
import { MAX_SELECTED_IDS, parseContactFilters, parseContactIds } from '@/lib/contacts/query'
import {
  ContactExportLimitError,
  fetchContactsForExport,
} from '@/lib/contacts/repository'
import { CSV_BOM } from '@/lib/csv'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/**
 * Exports contacts as CSV.
 *
 * GET exports the current contact view: it reuses the same filter parsing as the contact
 * list, so "export" always means "export what I am looking at" rather than a separate,
 * drifting query path.
 *
 * POST exports an explicit row selection. It exists because a selection travels as a
 * list of ids, and a few hundred of those do not fit in a URL — the filters still come
 * from the query string, so a selected row that no longer matches the view is not
 * exported behind the user's back.
 */

/** Renders the CSV response for an already-authorised request. */
async function exportContacts(
  request: NextRequest,
  format: ExportFormat,
  ids: string[] | null
): Promise<NextResponse> {
  const filters = {
    ...parseContactFilters(request.nextUrl.searchParams),
    ...(ids === null ? {} : { ids }),
    // An export covers the whole filtered set, not one screen — but stays capped so a
    // single request cannot stream the entire table.
    page: 1,
    pageSize: EXPORT_MAX_ROWS,
  }

  const db = await createSupabaseServerClient()
  const { rows } = await fetchContactsForExport(db, filters, EXPORT_MAX_ROWS)

  const body = CSV_BOM + buildContactCsv(rows, format)
  const filename = buildExportFilename(format, new Date().toISOString())

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      // Contact data must never sit in a shared cache.
      'Cache-Control': 'private, no-store',
    },
  })
}

/** Maps a failed export onto a status code, keeping both entry points consistent. */
function exportErrorResponse(error: unknown): NextResponse {
  console.error('Contact export failed:', error)

  if (error instanceof ContactExportLimitError) {
    return NextResponse.json(
      { error: error.message, total: error.total, maxRows: error.maxRows },
      { status: 422 }
    )
  }

  return NextResponse.json(
    { error: error instanceof Error ? error.message : 'Export failed.' },
    { status: 500 }
  )
}

function unsupportedFormatResponse(): NextResponse {
  return NextResponse.json(
    { error: `Unsupported export format. Use one of: emailoctopus, full.` },
    { status: 400 }
  )
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // proxy.ts already gates this, but it is an optimistic check by design — the real
  // authorisation belongs next to the data.
  const session = await getSession()

  if (!session) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 })
  }

  const requestedFormat = request.nextUrl.searchParams.get('format') ?? 'full'

  if (!isExportFormat(requestedFormat)) {
    return unsupportedFormatResponse()
  }

  try {
    // `ids` in the query string is honoured for a small selection; parseContactFilters
    // reads it, so no extra handling is needed here.
    return await exportContacts(request, requestedFormat, null)
  } catch (error) {
    return exportErrorResponse(error)
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await getSession()

  if (!session) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 })
  }

  let form: FormData

  try {
    form = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Expected a form-encoded body.' }, { status: 400 })
  }

  const requestedFormat =
    form.get('format')?.toString() ?? request.nextUrl.searchParams.get('format') ?? 'full'

  if (!isExportFormat(requestedFormat)) {
    return unsupportedFormatResponse()
  }

  const rawIds = form.get('ids')

  if (typeof rawIds !== 'string') {
    return NextResponse.json(
      { error: 'Select at least one contact, or use the unfiltered export.' },
      { status: 400 }
    )
  }

  const ids = parseContactIds(rawIds) ?? []

  // Failing here rather than falling back to the filtered set: a selection that parses
  // to nothing must not silently turn into an export of every matching contact.
  if (ids.length === 0) {
    return NextResponse.json(
      { error: 'No valid contact was selected for export.' },
      { status: 400 }
    )
  }

  if (ids.length > MAX_SELECTED_IDS) {
    return NextResponse.json(
      { error: `Select at most ${MAX_SELECTED_IDS} contacts, or export the filtered view.` },
      { status: 422 }
    )
  }

  try {
    return await exportContacts(request, requestedFormat, ids)
  } catch (error) {
    return exportErrorResponse(error)
  }
}
