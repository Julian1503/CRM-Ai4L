/**
 * @jest-environment node
 */
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { applyNewsletterEvent, parseNewsletterBatch, parseNewsletterEvent } from './newsletter'

const created = {
  id: 'evt-1',
  type: 'contact.created',
  list_id: 'list-1',
  contact_id: 'eo-1',
  contact_email_address: 'Grace@Example.com',
  contact_status: 'subscribed',
  contact_fields: { FirstName: 'Grace', LastName: 'Hopper' },
  occurred_at: '2026-08-09T10:15:00Z',
}

describe('parseNewsletterEvent', () => {
  it('reads a contact.created event as a subscription', () => {
    expect(parseNewsletterEvent(created)).toEqual({
      ok: true,
      event: {
        id: 'evt-1',
        providerType: 'contact.created',
        type: 'subscribed',
        email: 'grace@example.com',
        firstName: 'Grace',
        lastName: 'Hopper',
        externalId: 'eo-1',
        occurredAt: '2026-08-09T10:15:00Z',
      },
    })
  })

  it('normalises the email to lowercase', () => {
    const result = parseNewsletterEvent(created)

    expect(result.ok && result.event.email).toBe('grace@example.com')
  })

  it('reads a contact.unsubscribed event', () => {
    const result = parseNewsletterEvent({
      type: 'contact.unsubscribed',
      contact_email_address: 'a@example.com',
    })

    expect(result.ok && result.event.type).toBe('unsubscribed')
  })

  it('treats a contact.deleted event as an unsubscribe, not a CRM deletion', () => {
    // Removal from the EmailOctopus list ends the subscription; the CRM record stays.
    const result = parseNewsletterEvent({
      type: 'contact.deleted',
      contact_email_address: 'a@example.com',
    })

    expect(result.ok && result.event.type).toBe('unsubscribed')
  })

  it('follows contact_status on an update rather than the event name', () => {
    const result = parseNewsletterEvent({
      type: 'contact.updated',
      contact_email_address: 'a@example.com',
      contact_status: 'unsubscribed',
    })

    expect(result.ok && result.event.type).toBe('unsubscribed')
  })

  it('assumes a creation with no status is a subscriber', () => {
    // contact_status is documented as optional, and dropping the event would revive the
    // silent-discard bug this module exists to fix.
    const result = parseNewsletterEvent({
      type: 'contact.created',
      contact_email_address: 'a@example.com',
    })

    expect(result.ok && result.event.type).toBe('subscribed')
  })

  it('tolerates a missing name', () => {
    const result = parseNewsletterEvent({
      type: 'contact.created',
      contact_email_address: 'a@example.com',
    })

    expect(result.ok && result.event.firstName).toBe('')
  })

  it.each([
    ['an engagement event', { type: 'contact.opened', contact_email_address: 'a@b.co' }],
    ['a bounce', { type: 'contact.bounced', contact_email_address: 'a@b.co' }],
    [
      'an unconfirmed double opt-in',
      { type: 'contact.created', contact_email_address: 'a@b.co', contact_status: 'pending' },
    ],
    [
      'an update carrying no subscription state',
      { type: 'contact.updated', contact_email_address: 'a@b.co' },
    ],
  ])('ignores %s', (_label, payload) => {
    const result = parseNewsletterEvent(payload)

    expect(result).toEqual({ ok: false, reason: 'ignored' })
  })

  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['an array', []],
    ['no type', { contact_email_address: 'a@b.co' }],
    ['no email', { type: 'contact.created' }],
    ['blank email', { type: 'contact.created', contact_email_address: '  ' }],
    ['malformed email', { type: 'contact.created', contact_email_address: 'not-email' }],
  ])('rejects %s as invalid', (_label, payload) => {
    const result = parseNewsletterEvent(payload)

    expect(result).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('parseNewsletterBatch', () => {
  it('reads the array envelope EmailOctopus actually sends', () => {
    const batch = parseNewsletterBatch([created])

    expect(batch?.events).toHaveLength(1)
    expect(batch?.events[0].email).toBe('grace@example.com')
  })

  it('tolerates a single event object outside an array', () => {
    const batch = parseNewsletterBatch(created)

    expect(batch?.events).toHaveLength(1)
  })

  it('orders a batch by occurred_at so the newest state wins', () => {
    // Events are buffered for about a minute, so a subscribe and a later unsubscribe
    // for the same address can arrive in one delivery, in any order.
    const batch = parseNewsletterBatch([
      {
        type: 'contact.unsubscribed',
        contact_email_address: 'a@b.co',
        occurred_at: '2026-08-09T11:05:00Z',
      },
      {
        type: 'contact.created',
        contact_email_address: 'a@b.co',
        contact_status: 'subscribed',
        occurred_at: '2026-08-09T11:00:00Z',
      },
    ])

    expect(batch?.events.map((event) => event.type)).toEqual(['subscribed', 'unsubscribed'])
  })

  it('counts unhandled and malformed events without discarding the good ones', () => {
    // Rejecting the whole delivery over one bad row would make EmailOctopus redeliver
    // the other 999 events for ten days and never get past the same poison event.
    const batch = parseNewsletterBatch([
      created,
      { type: 'contact.opened', contact_email_address: 'a@b.co' },
      { type: 'contact.created' },
    ])

    expect(batch).toMatchObject({ ignored: 1, invalid: 1 })
    expect(batch?.events).toHaveLength(1)
  })

  it('accepts an empty delivery', () => {
    expect(parseNewsletterBatch([])).toEqual({ events: [], ignored: 0, invalid: 0 })
  })

  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['a number', 7],
  ])('rejects %s as an unusable envelope', (_label, payload) => {
    expect(parseNewsletterBatch(payload)).toBeNull()
  })
})

describe('applyNewsletterEvent', () => {
  const event = {
    id: 'evt-1',
    providerType: 'contact.created',
    type: 'subscribed' as const,
    email: 'grace@example.com',
    firstName: 'Grace',
    lastName: 'Hopper',
    externalId: 'eo-1',
    occurredAt: '2026-08-09T10:15:00Z',
  }

  function dbReturning(...responses: unknown[]) {
    const builder = createQueryBuilderMock(responses)
    return { builder, db: createDbMock(builder) }
  }

  it('updates an existing active contact', async () => {
    const { builder, db } = dbReturning(
      { data: { id: 'c1', deleted_at: null }, error: null },
      { data: null, error: null }
    )

    const result = await applyNewsletterEvent(db as never, event)

    expect(result.action).toBe('updated')
    const update = builder.argsFor('update') as [Record<string, unknown>]
    expect(update[0].subscribed_to_newsletter).toBe(true)
  })

  it('creates a new lead when nobody matches — the core of the requirement', async () => {
    // The previous implementation ran a bare UPDATE, which matched zero rows and
    // returned 200, so every new website subscriber was silently discarded.
    const { builder, db } = dbReturning(
      { data: null, error: null },
      { data: null, error: null },
      { data: { id: 'c-new' }, error: null }
    )

    const result = await applyNewsletterEvent(db as never, event)

    expect(result.action).toBe('created')
    const insert = builder.argsFor('insert') as [Record<string, unknown>]
    expect(insert[0]).toMatchObject({
      email: 'grace@example.com',
      first_name: 'Grace',
      last_name: 'Hopper',
      subscribed_to_newsletter: true,
      status: 'lead',
      source: 'newsletter',
    })
  })

  it('does not create a contact for an unsubscribe of someone unknown', async () => {
    const { builder, db } = dbReturning({ data: null, error: null }, { data: null, error: null })

    const result = await applyNewsletterEvent(db as never, {
      ...event,
      type: 'unsubscribed',
    })

    expect(result.action).toBe('noop')
    expect(builder.allFor('insert')).toHaveLength(0)
  })

  it('leaves an archived contact archived rather than silently resurrecting it', async () => {
    // An external form must not be able to un-archive records the client
    // deliberately archived. A new lead is created and the collision is reported.
    const { builder, db } = dbReturning(
      { data: null, error: null },
      { data: { id: 'c-archived' }, error: null },
      { data: { id: 'c-new' }, error: null }
    )

    const result = await applyNewsletterEvent(db as never, event)

    expect(result.action).toBe('created')
    expect(result.archivedMatchExists).toBe(true)
    const update = builder.allFor('update')
    expect(update).toHaveLength(0)
  })

  it('records the unsubscribe against an existing contact', async () => {
    const { builder, db } = dbReturning(
      { data: { id: 'c1', deleted_at: null }, error: null },
      { data: null, error: null }
    )

    await applyNewsletterEvent(db as never, { ...event, type: 'unsubscribed' })

    const update = builder.argsFor('update') as [Record<string, unknown>]
    expect(update[0].subscribed_to_newsletter).toBe(false)
  })

  it('does not downgrade the status of an existing customer', async () => {
    const { builder, db } = dbReturning(
      { data: { id: 'c1', deleted_at: null }, error: null },
      { data: null, error: null }
    )

    await applyNewsletterEvent(db as never, event)

    // A newsletter signup must not turn a paying customer back into a lead.
    const update = builder.argsFor('update') as [Record<string, unknown>]
    expect(update[0]).not.toHaveProperty('status')
  })

  it('surfaces a lookup failure instead of pretending it succeeded', async () => {
    const { db } = dbReturning({ data: null, error: { message: 'connection reset' } })

    await expect(applyNewsletterEvent(db as never, event)).rejects.toThrow(/connection reset/)
  })

  it('surfaces an insert failure', async () => {
    const { db } = dbReturning(
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: { message: 'insert denied' } }
    )

    await expect(applyNewsletterEvent(db as never, event)).rejects.toThrow(/insert denied/)
  })
})
