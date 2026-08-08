import { NextResponse, type NextRequest } from 'next/server'

import { getSession } from '@/lib/auth/dal'
import { parseExcelBuffer } from '@/lib/excelParser'

export const runtime = 'nodejs'

// Parsed spreadsheets are contact data; a shared cache must never retain them.
const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** Guard against a hostile upload exhausting memory in the parser. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await getSession()

  if (!session) {
    return NextResponse.json(
      { error: 'Authentication required.' },
      { status: 401, headers: NO_STORE }
    )
  }

  try {
    const formData = await request.formData()
    const file = formData.get('file')

    if (!file || typeof file === 'string') {
      return NextResponse.json(
        { error: 'No file uploaded' },
        { status: 400, headers: NO_STORE }
      )
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: `File exceeds the ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit.` },
        { status: 413, headers: NO_STORE }
      )
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const parsedData = parseExcelBuffer(buffer)

    return NextResponse.json(parsedData, { headers: NO_STORE })
  } catch (error: unknown) {
    console.error('Spreadsheet parse API error:', error)

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to parse spreadsheet file',
      },
      { status: 500, headers: NO_STORE }
    )
  }
}
