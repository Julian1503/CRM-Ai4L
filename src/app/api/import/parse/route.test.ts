/**
 * @jest-environment node
 */
const mockGetSession = jest.fn()
const mockParseExcelBuffer = jest.fn()

jest.mock('@/lib/auth/dal', () => ({ getSession: () => mockGetSession() }))
jest.mock('@/lib/excelParser', () => ({
  parseExcelBuffer: (buffer: Buffer) => mockParseExcelBuffer(buffer),
}))

import { POST } from './route'

/**
 * A request double.
 *
 * `NextRequest` cannot carry a multipart body in this environment, and the route only
 * ever calls `formData()`, so supplying that directly tests the handler rather than the
 * platform's multipart parser.
 */
function uploadRequest(file: unknown) {
  const form = { get: (key: string) => (key === 'file' ? file : null) }

  return {
    formData: async () => form,
  } as unknown as Parameters<typeof POST>[0]
}

function spreadsheet(sizeBytes = 1024) {
  return {
    size: sizeBytes,
    arrayBuffer: async () => new ArrayBuffer(8),
  }
}

describe('POST /api/import/parse', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSession.mockResolvedValue({ userId: 'u1', email: 'admin@example.com' })
    mockParseExcelBuffer.mockReturnValue({
      headers: ['First name', 'Email'],
      rows: [{ 'First name': 'Ada', Email: 'ada@example.com' }],
    })
  })

  it('refuses an unauthenticated upload before parsing anything', async () => {
    mockGetSession.mockResolvedValue(null)

    const response = await POST(uploadRequest(spreadsheet()))

    expect(response.status).toBe(401)
    expect(mockParseExcelBuffer).not.toHaveBeenCalled()
  })

  it('returns the parsed headers and rows', async () => {
    const response = await POST(uploadRequest(spreadsheet()))

    expect(response.status).toBe(200)
    expect((await response.json()).headers).toEqual(['First name', 'Email'])
  })

  it('rejects a request with no file', async () => {
    const response = await POST(uploadRequest(null))

    expect(response.status).toBe(400)
    expect(mockParseExcelBuffer).not.toHaveBeenCalled()
  })

  it('rejects a text field posing as the file', async () => {
    const response = await POST(uploadRequest('not-a-file'))

    expect(response.status).toBe(400)
  })

  describe('upload ceiling', () => {
    it('refuses a file over the limit without reading it into memory', async () => {
      // The point of the check is that it happens before arrayBuffer(), so a hostile
      // upload cannot exhaust memory in the parser.
      const oversized = {
        size: 10 * 1024 * 1024 + 1,
        arrayBuffer: jest.fn(),
      }

      const response = await POST(uploadRequest(oversized))

      expect(response.status).toBe(413)
      expect(oversized.arrayBuffer).not.toHaveBeenCalled()
      expect(mockParseExcelBuffer).not.toHaveBeenCalled()
    })

    it('accepts a file exactly on the limit', async () => {
      const response = await POST(uploadRequest(spreadsheet(10 * 1024 * 1024)))

      expect(response.status).toBe(200)
    })
  })

  describe('failures', () => {
    it('reports a parser error as a 500 with its message', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {})
      mockParseExcelBuffer.mockImplementation(() => {
        throw new Error('Unsupported file format')
      })

      const response = await POST(uploadRequest(spreadsheet()))

      expect(response.status).toBe(500)
      expect((await response.json()).error).toBe('Unsupported file format')
    })

    it('falls back to a generic message when something non-Error is thrown', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {})
      mockParseExcelBuffer.mockImplementation(() => {
        throw 'boom'
      })

      const response = await POST(uploadRequest(spreadsheet()))

      expect((await response.json()).error).toBe('Failed to parse spreadsheet file')
    })
  })

  it.each([
    ['a successful parse', () => uploadRequest(spreadsheet())],
    ['a rejected upload', () => uploadRequest(null)],
  ])('never caches %s — the body is contact data', async (_case, build) => {
    const response = await POST(build())

    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })
})
