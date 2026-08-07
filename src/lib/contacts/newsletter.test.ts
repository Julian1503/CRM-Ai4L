/**
 * @jest-environment node
 */
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { applyNewsletterEvent, parseNewsletterEvent } from './newsletter'

const subscribed = {
  event: 'contact.subscribed',
  contact: {
    id: 'eo-1',
    email_address: 'Grace@Example.com',
    fields: { FirstName: 'Grace', LastName: 'Hopper' },
  },
}

describe('parseNewsletterEvent', () => {
  it('reads a subscribe event', () => {
    expect(parseNewsletterEvent(subscribed)).toEqual({
      ok: true,
      event: {
        type: 'subscribed',
        email: 'grace@example.com',
        firstName: 'Grace',
        lastName: 'Hopper',
        externalId: 'eo-1',
      },
    })
  })

  it('normalises the email to lowercase', () => {
    const result = parseNewsletterEvent(subscribed)

    expect(result.ok && result.event.email).toBe('grace@example.com')
  })

  it('reads an unsubscribe event', () => {
    const result = parseNewsletterEvent({
      event: 'contact.unsubscribed',
      contact: { email_address: 'a@example.com' },
    })

    expect(result.ok && result.event.type).toBe('unsubscribed')
  })

  it('tolerates a missing name', () => {
    const result = parseNewsletterEvent({
      event: 'contact.subscribed',
      contact: { email_address: 'a@example.com' },
    })

    expect(result.ok && result.event.firstName).toBe('')
  })

  it.each([
    ['unknown event type', { event: 'contact.bounced', contact: { email_address: 'a@b.co' } }],
  ])('ignores %s', (_label, payload) => {
    const result = parseNewsletterEvent(payload)

    expect(result).toEqual({ ok: false, reason: 'ignored' })
  })

  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['no event', { contact: { email_address: 'a@b.co' } }],
    ['no contact', { event: 'contact.subscribed' }],
    ['no email', { event: 'contact.subscribed', contact: {} }],
    ['blank email', { event: 'contact.subscribed', contact: { email_address: '  ' } }],
    ['malformed email', { event: 'contact.subscribed', contact: { email_address: 'not-email' } }],
  ])('rejects %s as invalid', (_label, payload) => {
    const result = parseNewsletterEvent(payload)

    expect(result).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('applyNewsletterEvent', () => {
  const event = {
    type: 'subscribed' as const,
    email: 'grace@example.com',
    firstName: 'Grace',
    lastName: 'Hopper',
    externalId: 'eo-1',
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
