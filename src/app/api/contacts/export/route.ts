import { NextResponse, type NextRequest } from 'next/server'

import { getSession } from '@/lib/auth/dal'
import {
  EXPORT_MAX_ROWS,
  buildContactCsv,
  buildExportFilename,
  isExportFormat,
} from '@/lib/contacts/export'
import { parseContactFilters } from '@/lib/contacts/query'
import {
  ContactExportLimitError,
  fetchContactsForExport,
} from '@/lib/contacts/repository'
import { CSV_BOM } from '@/lib/csv'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/**
 * Exports the current contact view as CSV.
 *
 * Reuses the same filter parsing as the contact list, so "export" always means
 * "export what I am looking at" rather than a separate, drifting query path.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  // proxy.ts already gates this, but it is an optimistic check by design — the real
  // authorisation belongs next to the data.
  const session = await getSession()

  if (!session) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 })
  }

  const searchParams = request.nextUrl.searchParams
  const requestedFormat = searchParams.get('format') ?? 'full'

  if (!isExportFormat(requestedFormat)) {
    return NextResponse.json(
      { error: `Unsupported export format. Use one of: emailoctopus, full.` },
      { status: 400 }
    )
  }

  const filters = {
    ...parseContactFilters(searchParams),
    // An export covers the whole filtered set, not one screen — but stays capped so a
    // single request cannot stream the entire table.
    page: 1,
    pageSize: EXPORT_MAX_ROWS,
  }

  try {
    const db = await createSupabaseServerClient()
    const { rows } = await fetchContactsForExport(db, filters, EXPORT_MAX_ROWS)

    const body = CSV_BOM + buildContactCsv(rows, requestedFormat)
    const filename = buildExportFilename(requestedFormat, new Date().toISOString())

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        // Contact data must never sit in a shared cache.
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (error) {
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
}
