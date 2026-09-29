/**
 * @jest-environment node
 */
const mockSave = jest.fn()
const mockOutbox = jest.fn()

jest.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: async () => ({}) }))
jest.mock('@/lib/marketing/providers/credentials', () => ({ loadEmailOctopusCredentials: async () => ({ apiKey: 'k', listId: 'l' }) }))
jest.mock('@/lib/consent/outbox', () => ({ processConsentOutbox: (...args: unknown[]) => mockOutbox(...args) }))
jest.mock('./providerSync', () => ({ preferencesOrigin: () => 'https://crm.example.com' }))
jest.mock('./save', () => ({
  ...jest.requireActual('./save'),
  saveContact: (...args: unknown[]) => mockSave(...args),
}))

import { handleContactSave } from './saveHandler'

const body = { firstName: 'Ada', lastName: 'L', email: 'ada@example.com' }

function request(payload: unknown) {
  return new Request('https://crm.example.com/api/contacts', { method: 'POST', body: JSON.stringify(payload) })
}

describe('handleContactSave (H8)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSave.mockResolvedValue({ kind: 'saved', contact: { id: 'c1', revision: 2 } })
    mockOutbox.mockResolvedValue({ claimed: 1, synced: 1, failed: 0 })
  })

  it('creates without a revision and pushes any consent change straight away', async () => {
    const response = await handleContactSave(request(body), null, 'https://crm.example.com')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ contact: { id: 'c1', revision: 2 }, providerSync: 'done' })
    expect(mockSave).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: null, expectedRevision: null }))
    expect(mockOutbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ contactId: 'c1' }))
  })

  it('requires the edited revision for an update', async () => {
    expect((await handleContactSave(request(body), 'c1', 'o')).status).toBe(400)
    expect(mockSave).not.toHaveBeenCalled()
  })

  it('passes the edited revision through', async () => {
    await handleContactSave(request({ ...body, expectedRevision: 7 }), 'c1', 'o')
    expect(mockSave).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'c1', expectedRevision: 7 }))
  })

  it.each([
    [{ kind: 'invalid', message: 'Unknown service' }, 400],
    [{ kind: 'conflict', message: 'Someone else changed this contact' }, 409],
    [{ kind: 'not_found' }, 404],
  ])('maps %o to %s', async (result, status) => {
    mockSave.mockResolvedValue(result)
    expect((await handleContactSave(request({ ...body, expectedRevision: 1 }), 'c1', 'o')).status).toBe(status)
  })

  it('rejects a malformed body before touching the database', async () => {
    expect((await handleContactSave(request({ firstName: 'Ada' }), null, 'o')).status).toBe(400)
    expect(mockSave).not.toHaveBeenCalled()
  })

  it('reports the provider push as pending when it cannot run now', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    mockOutbox.mockRejectedValue(new Error('provider down'))

    await expect((await handleContactSave(request(body), null, 'o')).json()).resolves.toMatchObject({ providerSync: 'pending' })
  })

  it('says nothing changed when the save itself fails', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    mockSave.mockRejectedValue(new Error('relation contacts is locked'))

    const response = await handleContactSave(request(body), null, 'o')

    expect(response.status).toBe(500)
    expect((await response.json()).error).toMatch(/Nothing was changed/)
  })
})
