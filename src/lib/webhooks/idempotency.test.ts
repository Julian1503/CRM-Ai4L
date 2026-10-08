/** @jest-environment node */
import { createHash } from 'node:crypto'

import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { claimWebhookEvent, completeWebhookEvent, deriveEventId } from './idempotency'

function db(result: unknown) {
  const mock = createDbMock(createQueryBuilderMock())
  mock.rpc.mockResolvedValue(result)
  return mock
}

describe('deriveEventId', () => {
  it('prefers the provider id, trimmed', () => {
    expect(deriveEventId('{}', '  evt_1  ')).toBe('evt_1')
  })

  it('falls back to a hash of the payload, so a genuine retry gets the same id', () => {
    const payload = '{"a":1}'
    const expected = `sha256:${createHash('sha256').update(payload, 'utf8').digest('hex')}`

    expect(deriveEventId(payload)).toBe(expected)
    expect(deriveEventId(payload, '   ')).toBe(expected)
    expect(deriveEventId(payload, null)).toBe(expected)
    expect(deriveEventId('{"a":2}')).not.toBe(expected)
  })
})

describe('claimWebhookEvent', () => {
  it('passes provider, id and type to claim_webhook_event', async () => {
    const mock = db({ data: [{ outcome: 'claimed', claim_token: 't1' }], error: null })

    await expect(claimWebhookEvent(mock as never, 'stripe', 'evt_1', 'checkout.session.completed')).resolves.toEqual({
      outcome: 'claimed',
      token: 't1',
    })
    expect(mock.rpc).toHaveBeenCalledWith('claim_webhook_event', {
      p_provider: 'stripe',
      p_event_id: 'evt_1',
      p_event_type: 'checkout.session.completed',
    })
  })

  it.each([
    [{ outcome: 'completed', claim_token: null }, { outcome: 'completed' }],
    [[{ outcome: 'in_progress', claim_token: null }], { outcome: 'in_progress' }],
  ])('maps %p', async (data, expected) => {
    await expect(claimWebhookEvent(db({ data, error: null }) as never, 'calendly', 'e', null)).resolves.toEqual(expected)
  })

  it('refuses a claim without a token or an unknown outcome', async () => {
    await expect(claimWebhookEvent(db({ data: [{ outcome: 'claimed', claim_token: null }], error: null }) as never, 'x', 'e', null)).rejects.toThrow(
      /unexpected claim result/
    )
    await expect(claimWebhookEvent(db({ data: [], error: null }) as never, 'x', 'e', null)).rejects.toThrow(/unexpected/)
    await expect(claimWebhookEvent(db({ data: null, error: null }) as never, 'x', 'e', null)).rejects.toThrow(/unexpected/)
  })

  it('surfaces a database error, so the provider retries', async () => {
    await expect(claimWebhookEvent(db({ data: null, error: { message: 'down' } }) as never, 'x', 'e', null)).rejects.toThrow(
      'Could not record webhook event: down'
    )
  })
})

describe('completeWebhookEvent', () => {
  const claim = { provider: 'stripe', eventId: 'evt_1', token: 't1' }

  it('records the outcome with the claim token', async () => {
    const mock = db({ data: true, error: null })

    await completeWebhookEvent(mock as never, claim, 'failed_retryable', 'boom')

    expect(mock.rpc).toHaveBeenCalledWith('complete_webhook_event', {
      p_provider: 'stripe',
      p_event_id: 'evt_1',
      p_token: 't1',
      p_status: 'failed_retryable',
      p_error: 'boom',
    })
  })

  it('defaults the error to null', async () => {
    const mock = db({ data: true, error: null })
    await completeWebhookEvent(mock as never, claim, 'completed')
    expect(mock.rpc.mock.calls[0][1]).toMatchObject({ p_error: null })
  })

  it('logs instead of throwing when the outcome cannot be recorded: the lease expires into a retry', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(completeWebhookEvent(db({ data: null, error: { message: 'down' } }) as never, claim, 'completed')).resolves.toBeUndefined()
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('stripe/evt_1: down'))
    } finally {
      spy.mockRestore()
    }
  })
})
