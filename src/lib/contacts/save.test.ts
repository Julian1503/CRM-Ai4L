/**
 * @jest-environment node
 */
import { parseContactSaveInput, saveContact } from './save'

const SERVICE = '11111111-1111-4111-8111-111111111111'
const valid = { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' }

describe('parseContactSaveInput', () => {
  it('accepts a minimal contact and defaults the status', () => {
    const parsed = parseContactSaveInput(valid)
    expect(parsed).toMatchObject({ ok: true, input: { status: 'prospect', servicesBought: [], jobTypeId: null } })
  })

  it('maps the legacy isCustomer flag', () => {
    expect(parseContactSaveInput({ ...valid, isCustomer: true })).toMatchObject({ input: { status: 'customer' } })
  })

  it('de-duplicates service ids', () => {
    expect(parseContactSaveInput({ ...valid, servicesBought: [SERVICE, SERVICE] })).toMatchObject({
      input: { servicesBought: [SERVICE] },
    })
  })

  it.each([
    ['no first name', { ...valid, firstName: ' ' }],
    ['no last name', { ...valid, lastName: '' }],
    ['no email', { ...valid, email: undefined }],
    ['an archive status', { ...valid, status: 'archived' }],
    ['a malformed job type', { ...valid, jobTypeId: 'electrician' }],
    ['malformed services', { ...valid, servicesBought: ['x'] }],
    ['services that are not a list', { ...valid, servicesBought: SERVICE }],
    ['a non-boolean consent', { ...valid, subscribedToNewsletter: 'yes' }],
  ])('rejects %s', (_label, body) => {
    expect(parseContactSaveInput(body as Record<string, unknown>).ok).toBe(false)
  })
})

function db(result: { data?: unknown; error?: { code?: string; message: string } | null }) {
  const rpc = jest.fn(async () => ({ data: result.data ?? null, error: result.error ?? null }))
  return { client: { rpc } as never, rpc }
}

describe('saveContact', () => {
  const input = { ...valid, status: 'customer' as const, servicesBought: [SERVICE], subscribedToNewsletter: true }

  it('saves contact, organisation and services in one call', async () => {
    const { client, rpc } = db({ data: { id: 'c1', revision: 4 } })

    const result = await saveContact(client, { id: 'c1', input: { ...input, organisationName: 'Acme' }, expectedRevision: 3 })

    expect(result).toEqual({ kind: 'saved', contact: { id: 'c1', revision: 4 } })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('save_contact', {
      p_contact: expect.objectContaining({ id: 'c1', organisation_name: 'Acme', status: 'customer', subscribed_to_newsletter: true }),
      p_services: [SERVICE],
      p_expected_revision: 3,
    })
  })

  it.each([
    [{ code: 'CRM07', message: 'Unknown service x.' }, 'invalid'],
    [{ code: 'CRM06', message: 'Someone else changed this contact' }, 'conflict'],
    [{ code: 'P0002', message: 'Contact not found.' }, 'not_found'],
    [{ code: '23505', message: 'duplicate key' }, 'conflict'],
  ])('maps %o to %s', async (error, kind) => {
    const { client } = db({ error })
    expect((await saveContact(client, { id: 'c1', input, expectedRevision: 1 })).kind).toBe(kind)
  })

  it('surfaces anything else', async () => {
    const { client } = db({ error: { message: 'connection reset' } })
    await expect(saveContact(client, { id: null, input, expectedRevision: null })).rejects.toThrow('connection reset')
  })
})
