import { parsePublishRequest } from './validation'

const REVISION = '00000000-0000-4000-8000-00000000e001'
const ACCOUNT = '00000000-0000-4000-8000-000000000ac1'

describe('parsePublishRequest', () => {
  it('accepts a well-formed request and trims the key', () => {
    expect(parsePublishRequest({ revisionId: REVISION, accountId: ACCOUNT, idempotencyKey: '  key-12345678 ' })).toEqual({
      ok: true,
      value: { revisionId: REVISION, accountId: ACCOUNT, idempotencyKey: 'key-12345678' },
    })
  })

  it.each([
    [{ revisionId: 'x', accountId: ACCOUNT, idempotencyKey: 'key-12345678' }, 'revisionId'],
    [{ revisionId: REVISION, accountId: 7, idempotencyKey: 'key-12345678' }, 'accountId'],
    [{ revisionId: REVISION, accountId: ACCOUNT }, 'idempotencyKey'],
    [{ revisionId: REVISION, accountId: ACCOUNT, idempotencyKey: 'k'.repeat(201) }, 'idempotencyKey'],
  ])('refuses %j', (body, field) => {
    const result = parsePublishRequest(body)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toContain(field)
  })
})
