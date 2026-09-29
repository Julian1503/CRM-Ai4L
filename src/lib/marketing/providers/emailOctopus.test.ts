/**
 * @jest-environment node
 *
 * Node, not jsdom: jest.setup.ts installs a minimal Response stand-in when the global
 * is missing (as it is under jsdom), and that stand-in has no `ok` or `clone`. Real
 * Response semantics matter here — the adapter branches on status codes.
 */
import {
  EMAILOCTOPUS_CAPABILITIES,
  automationProbeEmail,
  createEmailOctopusProvider,
  emailOctopusContactId,
  verifyAutomation,
} from './emailOctopus'

function response(
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function provider(fetchImpl: jest.Mock) {
  return createEmailOctopusProvider({
    apiKey: 'eo-key',
    listId: 'list-1',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
}

describe('EmailOctopus capabilities', () => {
  // These are load-bearing facts, not documentation. The UI and the send pipeline both
  // branch on them, so pinning them stops a hopeful refactor from assuming otherwise.
  it('declares that campaigns cannot be created via API', () => {
    expect(EMAILOCTOPUS_CAPABILITIES.canCreateCampaign).toBe(false)
  })

  it('declares that there is no broadcast send', () => {
    expect(EMAILOCTOPUS_CAPABILITIES.canSendBroadcast).toBe(false)
    expect(EMAILOCTOPUS_CAPABILITIES.sendGranularity).toBe('per-contact')
  })

  it('declares that the body cannot be supplied through the API', () => {
    // The reason AI-generated copy can only be merge fields, not an HTML body.
    expect(EMAILOCTOPUS_CAPABILITIES.canSupplyBody).toBe(false)
    expect(EMAILOCTOPUS_CAPABILITIES.requiresPreAuthoredTemplate).toBe(true)
  })

  it('does not claim per-send reporting it cannot deliver', () => {
    expect(EMAILOCTOPUS_CAPABILITIES.perSendReporting).toBe('unknown')
  })

  it('records that repeat sends depend on a provider-side setting', () => {
    // Which is why deduplication lives in campaign_sends rather than being trusted
    // to the provider.
    expect(EMAILOCTOPUS_CAPABILITIES.repeatSendRequiresProviderSetting).toBe(true)
  })

  it('records the documented rate limit', () => {
    expect(EMAILOCTOPUS_CAPABILITIES.rateLimit).toEqual({
      capacity: 100,
      refillPerSecond: 10,
    })
  })
})

describe('setContactFields', () => {
  it('upserts personalisation fields onto the contact', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(200, { id: 'c1' }))

    const result = await provider(fetchImpl).setContactFields('a@example.com', {
      FirstName: 'Ada',
      OfferHeadline: 'Free consultation',
    })

    expect(result.ok).toBe(true)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.emailoctopus.com/lists/list-1/contacts')
    expect(init.headers.Authorization).toBe('Bearer eo-key')
    expect(JSON.parse(init.body).fields.OfferHeadline).toBe('Free consultation')
  })

  it('reports a failure without throwing', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(422, { detail: 'Invalid field' }))

    const result = await provider(fetchImpl).setContactFields('a@example.com', {})

    expect(result).toMatchObject({ ok: false, error: 'Invalid field', retryable: false })
  })
})

describe('triggerSend', () => {
  const params = {
    campaignHandle: 'auto-1',
    email: 'a@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
  }

  it('queues the contact into the automation', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(200, { id: 'queued-1' }))

    const result = await provider(fetchImpl).triggerSend(params)

    expect(result).toEqual({ ok: true, reference: 'queued-1' })
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://api.emailoctopus.com/automations/auto-1/queue'
    )
    expect(fetchImpl.mock.calls[0][1].method).toBe('POST')
  })

  it('url-encodes the automation id', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(200))

    await provider(fetchImpl).triggerSend({ ...params, campaignHandle: 'a/../b' })

    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://api.emailoctopus.com/automations/a%2F..%2Fb/queue'
    )
  })

  it('refuses clearly when no automation is configured', async () => {
    // The most likely misconfiguration, given a campaign cannot be created via API.
    const fetchImpl = jest.fn()

    const result = await provider(fetchImpl).triggerSend({ ...params, campaignHandle: '' })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/Started via API/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('marks a 429 retryable and passes the backoff through', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(response(429, { detail: 'Too many requests' }, { 'retry-after': '4' }))

    const result = await provider(fetchImpl).triggerSend(params)

    expect(result).toMatchObject({ ok: false, retryable: true, retryAfterMs: 4000 })
  })

  it('marks a 5xx on the queue call ambiguous, never retryable', async () => {
    // The queue call is not idempotent: a 5xx may follow acceptance (audit H3).
    const fetchImpl = jest.fn().mockResolvedValue(response(503))

    const result = await provider(fetchImpl).triggerSend(params)

    expect(result).toMatchObject({ ok: false, retryable: false, ambiguous: true })
  })

  it('marks a network failure or timeout ambiguous rather than throwing', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))

    const result = await provider(fetchImpl).triggerSend(params)

    expect(result).toMatchObject({ ok: false, retryable: false, ambiguous: true })
    expect((result as { error: string }).error).toMatch(/may or may not have been queued/)
  })

  it('bounds the queue call with a timeout', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response(null, { status: 204 }))

    await provider(fetchImpl).triggerSend(params)

    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })

  it('marks a 4xx non-retryable', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(400, { detail: 'Bad contact' }))

    const result = await provider(fetchImpl).triggerSend(params)

    expect(result).toMatchObject({ ok: false, retryable: false, error: 'Bad contact' })
  })

  it('still succeeds when the response carries no id', async () => {
    // 204 must carry a null body; passing '' makes the constructor throw.
    const fetchImpl = jest.fn().mockResolvedValue(new Response(null, { status: 204 }))

    const result = await provider(fetchImpl).triggerSend(params)

    // The queue endpoint answers empty, so the contact id is the only handle there is.
    expect(result).toEqual({
      ok: true,
      reference: emailOctopusContactId('a@example.com'),
    })
  })

  it('identifies the recipient by contact_id, not by email address', async () => {
    // The defect this pins: the v2 queue endpoint takes `contact_id` (an id, or the MD5
    // of the lowercased email). Posting `email_address` is rejected 422 for every
    // recipient, so a whole campaign failed without a single email going out.
    const fetchImpl = jest.fn().mockResolvedValue(response(200))

    await provider(fetchImpl).triggerSend({ ...params, email: ' Ada@Example.com ' })

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(body).toEqual({ contact_id: emailOctopusContactId('ada@example.com') })
    expect(body.email_address).toBeUndefined()
  })

  it('reports which field a 422 rejected', async () => {
    // "HTTP 422" tells an operator nothing; the pointer names what to fix.
    const fetchImpl = jest.fn().mockResolvedValue(
      response(422, {
        detail: 'The request was invalid.',
        errors: [{ pointer: '/contact_id', detail: 'This value should not be blank.' }],
      })
    )

    const result = await provider(fetchImpl).triggerSend(params)

    expect(result).toMatchObject({
      ok: false,
      retryable: false,
      error:
        'The request was invalid. (contact_id: This value should not be blank.)',
    })
  })
})

describe('emailOctopusContactId', () => {
  it('is the MD5 of the lowercased, trimmed address', () => {
    // Documented as accepted in place of the contact id, which is what lets a send
    // queue a contact without first looking it up.
    expect(emailOctopusContactId('  OTTO@example.COM ')).toBe(
      emailOctopusContactId('otto@example.com')
    )
    expect(emailOctopusContactId('otto@example.com')).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('verifyAutomation', () => {
  // The two 404 bodies below are verbatim from the live API on 2026-08-31, probed with
  // a real automation id and a made-up one. The whole check rests on them differing.
  const JOURNEY_404 = {
    title: 'An error occurred.',
    detail: 'Journey not found.',
    status: 404,
  }
  const CONTACT_404 = {
    title: 'An error occurred.',
    detail: 'Contact not found.',
    status: 404,
  }

  function check(fetchImpl: jest.Mock, automationId = 'auto-1') {
    return verifyAutomation({
      apiKey: 'eo-key',
      automationId,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      probeEmail: 'probe@invalid.invalid',
    })
  }

  it('reads "Contact not found" as proof the automation exists', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(404, CONTACT_404))

    expect(await check(fetchImpl)).toEqual({ status: 'valid' })
  })

  it('reads "Journey not found" as an automation id EmailOctopus does not have', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(404, JOURNEY_404))

    expect(await check(fetchImpl)).toEqual({
      status: 'invalid',
      error: 'Journey not found.',
    })
  })

  it('probes with a contact that cannot exist, so checking never sends an email', async () => {
    // The load-bearing safety property: this is a real `queue` request, and a probe
    // address that resolved to a contact on the list would start the automation for
    // them. Verifying an id must never be a send.
    const fetchImpl = jest.fn().mockResolvedValue(response(404, CONTACT_404))

    await check(fetchImpl)

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.emailoctopus.com/automations/auto-1/queue')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      contact_id: emailOctopusContactId('probe@invalid.invalid'),
    })
  })

  it('generates a reserved-domain probe address when none is supplied', async () => {
    // `.invalid` is reserved by RFC 2606 and can never be a deliverable subscriber.
    const first = automationProbeEmail()

    expect(first).toMatch(/@invalid\.invalid$/)
    expect(first).not.toBe(automationProbeEmail())
  })

  it('does not call the API for a blank id', async () => {
    const fetchImpl = jest.fn()

    expect(await check(fetchImpl, '   ')).toEqual({
      status: 'invalid',
      error: 'No automation id.',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('separates a bad key from a bad automation id', async () => {
    // Both would otherwise read as "this automation does not exist", sending an
    // operator to change a setting that was correct.
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(response(401, { detail: 'Invalid API key.' }))

    expect(await check(fetchImpl)).toEqual({
      status: 'unauthorised',
      error: 'Invalid API key.',
    })
  })

  it('reports a rate-limited check as unknown rather than invalid', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(429, { detail: 'Slow down.' }))

    expect(await check(fetchImpl)).toEqual({ status: 'unknown', error: 'Slow down.' })
  })

  it('reports an unrecognised 404 as unknown rather than guessing', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(response(404, { detail: 'List not found.' }))

    expect(await check(fetchImpl)).toEqual({ status: 'unknown', error: 'List not found.' })
  })

  it('survives a network failure without throwing at the caller', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('socket hang up'))

    expect(await check(fetchImpl)).toEqual({ status: 'unknown', error: 'socket hang up' })
  })

  it('treats a 2xx as valid, since the automation was certainly found', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(200))

    expect(await check(fetchImpl)).toEqual({ status: 'valid' })
  })
})
