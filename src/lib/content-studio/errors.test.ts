/** @jest-environment node */
import {
  ContentDbError,
  ContentHttpError,
  contentErrorResponse,
  errorResponse,
  featureDisabled,
  throwIfDbError,
} from './errors'

async function read(response: Response) {
  return { status: response.status, body: await response.json(), cache: response.headers.get('Cache-Control') }
}

describe('contentErrorResponse', () => {
  it.each([
    ['CRM06', 'stale_revision', 409],
    ['CRM07', 'asset_not_ready', 422],
    ['CRM01', null, 409],
    ['P0002', null, 404],
    ['22023', null, 400],
  ])('maps SQLSTATE %s (hint %s) to %i', async (code, hint, status) => {
    const result = await read(contentErrorResponse(new ContentDbError({ code, hint, message: 'Something specific.' })))

    expect(result.status).toBe(status)
    expect(result.body.error).toBe('Something specific.')
    expect(result.body.code).toBe(hint ?? undefined)
    expect(result.cache).toBe('private, no-store')
  })

  it('answers acting on an archived record as a 409 conflict with code archived', async () => {
    const result = await read(contentErrorResponse(new ContentDbError({ code: 'CRM07', hint: 'archived', message: 'Restore it first.' })))

    expect(result).toMatchObject({ status: 409, body: { error: 'Restore it first.', code: 'archived' } })
  })

  it.each([
    ['22P02', 400, 'A value has an invalid format.'],
    ['23514', 400, 'A value is not allowed here.'],
    ['23505', 409, 'This conflicts with an existing record.'],
  ])('answers raw PostgreSQL error %s with a generic message', async (code, status, message) => {
    const result = await read(
      contentErrorResponse(new ContentDbError({ code, message: 'duplicate key value violates unique constraint "x_key"' }))
    )

    expect(result).toMatchObject({ status, body: { error: message } })
  })

  it.each(['blocked_content', 'asset_not_pending'])('answers CRM07 %s as a 409 conflict with its code', async (hint) => {
    const result = await read(contentErrorResponse(new ContentDbError({ code: 'CRM07', hint, message: 'Refused.' })))

    expect(result).toMatchObject({ status: 409, body: { error: 'Refused.', code: hint } })
  })

  it('answers a permission error without the database message', async () => {
    const result = await read(contentErrorResponse(new ContentDbError({ code: '42501', message: 'internal detail' })))

    expect(result).toMatchObject({ status: 403, body: { error: 'You do not have permission to do that.' } })
  })

  it('ignores a hint that is prose rather than a code', async () => {
    const result = await read(
      contentErrorResponse(new ContentDbError({ code: 'CRM06', hint: 'Try reloading the page.', message: 'x' }))
    )

    expect(result.body).toEqual({ error: 'x' })
  })

  it('answers application errors with their own status and code', async () => {
    const result = await read(contentErrorResponse(new ContentHttpError(404, 'Item not found.', 'feature_disabled')))

    expect(result).toMatchObject({ status: 404, body: { error: 'Item not found.', code: 'feature_disabled' } })
  })

  it('hides unexpected errors behind the fallback message', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const unknownState = await read(contentErrorResponse(new ContentDbError({ code: 'XX000', message: 'secret' }), 'Nope.'))
      const plain = await read(contentErrorResponse(new Error('stack detail')))
      const odd = await read(contentErrorResponse('thrown string'))

      expect(unknownState).toMatchObject({ status: 500, body: { error: 'Nope.' } })
      expect(plain).toMatchObject({ status: 500, body: { error: 'Request failed.' } })
      expect(odd.status).toBe(500)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('helpers', () => {
  it('throwIfDbError throws only for an error', () => {
    expect(() => throwIfDbError(null)).not.toThrow()
    expect(() => throwIfDbError({ code: 'CRM06', message: 'm', hint: 'h' })).toThrow(ContentDbError)
  })

  it('ContentDbError tolerates missing code and hint', () => {
    const error = new ContentDbError({ message: 'm' })
    expect(error.sqlState).toBeNull()
    expect(error.hint).toBeNull()
  })

  it('featureDisabled is a 404 with the feature_disabled code', async () => {
    expect(await read(featureDisabled())).toMatchObject({ status: 404, body: { code: 'feature_disabled' } })
  })

  it('errorResponse omits an absent code', async () => {
    expect((await read(errorResponse(400, 'Bad.'))).body).toEqual({ error: 'Bad.' })
  })
})
