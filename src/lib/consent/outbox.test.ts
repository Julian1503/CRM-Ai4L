/**
 * @jest-environment node
 */
import { processConsentOutbox } from './outbox'

const mockSync = jest.fn()
jest.mock('@/lib/emailOctopus', () => ({
  syncContactToEmailOctopus: (...args: unknown[]) => mockSync(...args),
}))
jest.mock('@/lib/preferences/token', () => ({
  preferencesUrl: (origin: string, id: string) => `${origin}/preferences/${id}`,
}))

function claimed(overrides: Record<string, unknown> = {}) {
  return {
    outbox_id: 'o1',
    claim_token: 't1',
    contact_id: 'c1',
    state_version: 4,
    email: 'ada@example.com',
    first_name: 'Ada',
    last_name: 'L',
    newsletter: false,
    programs: false,
    ...overrides,
  }
}

function db(rows: unknown[], claimError: { message: string } | null = null) {
  const rpc = jest.fn(async (fn: string) => {
    if (fn === 'claim_consent_sync') return { data: claimError ? null : rows, error: claimError }
    return { data: true, error: null }
  })
  return { rpc } as unknown as { rpc: jest.Mock }
}

const credentials = { apiKey: 'k', listId: 'l' }

describe('processConsentOutbox', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSync.mockResolvedValue(undefined)
  })

  it('leaves the queue untouched when the provider is not configured', async () => {
    const client = db([claimed()])

    const result = await processConsentOutbox(client as never, { credentials: null, origin: null })

    expect(result).toMatchObject({ claimed: 0, notConfigured: true })
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('pushes a withdrawal as UNSUBSCRIBED, with consent fields and the preference link', async () => {
    const client = db([claimed()])

    await processConsentOutbox(client as never, { credentials, origin: 'https://crm.example.com' })

    expect(mockSync).toHaveBeenCalledWith('k', 'l', 'ada@example.com', 'Ada', 'L', 'UNSUBSCRIBED', {
      fields: { Newsletter: 'no', Courses: 'no', PrefsUrl: 'https://crm.example.com/preferences/c1' },
    })
  })

  it('settles the entry with the version it pushed, so older entries are covered', async () => {
    const client = db([claimed({ state_version: 9 })])

    await processConsentOutbox(client as never, { credentials, origin: null })

    expect(client.rpc).toHaveBeenCalledWith('complete_consent_sync', {
      p_outbox_id: 'o1',
      p_token: 't1',
      p_state_version: 9,
      p_ok: true,
      p_error: null,
    })
  })

  it('records a provider failure for backoff instead of losing the change', async () => {
    mockSync.mockRejectedValue(new Error('EmailOctopus API Error: 503'))
    const client = db([claimed()])

    const result = await processConsentOutbox(client as never, { credentials, origin: null })

    expect(result).toMatchObject({ claimed: 1, synced: 0, failed: 1 })
    expect(client.rpc).toHaveBeenCalledWith('complete_consent_sync', expect.objectContaining({
      p_ok: false,
      p_error: 'EmailOctopus API Error: 503',
    }))
  })

  it('skips the provider call for a contact with no email address, but settles the entry', async () => {
    const client = db([claimed({ email: null })])

    const result = await processConsentOutbox(client as never, { credentials, origin: null })

    expect(mockSync).not.toHaveBeenCalled()
    expect(result.synced).toBe(1)
  })

  it('keeps going when an entry cannot be settled, leaving it to lease recovery', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const client = db([claimed(), claimed({ outbox_id: 'o2', email: 'b@example.com' })])
    client.rpc.mockImplementation(async (fn: string) =>
      fn === 'claim_consent_sync'
        ? { data: [claimed(), claimed({ outbox_id: 'o2', email: 'b@example.com' })], error: null }
        : { data: null, error: { message: 'deadlock' } }
    )

    const result = await processConsentOutbox(client as never, { credentials, origin: null })

    expect(mockSync).toHaveBeenCalledTimes(2)
    expect(result.synced).toBe(2)
  })

  it('pushes a remaining consent as SUBSCRIBED', async () => {
    const client = db([claimed({ programs: true })])

    await processConsentOutbox(client as never, { credentials, origin: null })

    expect(mockSync).toHaveBeenCalledWith('k', 'l', 'ada@example.com', 'Ada', 'L', 'SUBSCRIBED', {
      fields: { Newsletter: 'no', Courses: 'yes' },
    })
  })

  it('can be scoped to one contact for an inline push', async () => {
    const client = db([])

    await processConsentOutbox(client as never, { credentials, origin: null, contactId: 'c7', limit: 1 })

    expect(client.rpc).toHaveBeenCalledWith('claim_consent_sync', { p_limit: 1, p_contact_id: 'c7' })
  })

  it('surfaces a claim failure', async () => {
    await expect(
      processConsentOutbox(db([], { message: 'boom' }) as never, { credentials, origin: null })
    ).rejects.toThrow(/boom/)
  })
})
