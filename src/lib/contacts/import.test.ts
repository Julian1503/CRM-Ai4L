import type { MappedContactRow } from '@/lib/excelParser'

import { importContacts, toImportPayload } from './import'

function validRow(overrides: Partial<NonNullable<MappedContactRow['data']>> = {}): MappedContactRow {
  return {
    isValid: true,
    data: {
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      isCustomer: false,
      subscribedToNewsletter: true,
      ...overrides,
    },
  }
}

describe('toImportPayload', () => {
  it('drops invalid rows', () => {
    const rows: MappedContactRow[] = [
      validRow(),
      { isValid: false, errors: ['Email address is required'] },
    ]

    expect(toImportPayload(rows)).toHaveLength(1)
  })

  it('converts camelCase fields to the snake_case shape the RPC expects', () => {
    const [row] = toImportPayload([
      validRow({
        preferredName: 'Ada L',
        mobileNumber: '0400000000',
        workPhone: '0299999999',
        organisationName: 'Analytical Engines',
        jobTypeName: 'Electrician',
        isCustomer: true,
        subscribedToNewsletter: false,
      }),
    ])

    expect(row).toMatchObject({
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada@example.com',
      preferred_name: 'Ada L',
      mobile_number: '0400000000',
      work_phone: '0299999999',
      organisation_name: 'Analytical Engines',
      job_type_name: 'Electrician',
      is_customer: true,
      subscribed_to_newsletter: false,
    })
  })

  it('omits absent optional fields so the RPC does not overwrite existing values with null', () => {
    const [row] = toImportPayload([validRow()])

    expect(row).not.toHaveProperty('preferred_name')
    expect(row).not.toHaveProperty('organisation_name')
    expect(row).not.toHaveProperty('job_type_name')
    expect(row).not.toHaveProperty('state')
  })

  it('always sends is_customer, since the spreadsheet is authoritative for it', () => {
    const [row] = toImportPayload([validRow()])

    expect(row.is_customer).toBe(false)
  })

  it('omits a consent the spreadsheet had no column for', () => {
    // The RPC reads an absent key as "say nothing": grant it to a new contact, leave an
    // existing one's alone. Sending `false` instead would make a re-import of the same
    // file look like every contact in it had just withdrawn consent.
    const [row] = toImportPayload([
      validRow({ subscribedToNewsletter: undefined, subscribedToPrograms: undefined }),
    ])

    expect(row).not.toHaveProperty('subscribed_to_newsletter')
    expect(row).not.toHaveProperty('subscribed_to_programs')
  })

  it('sends a consent the spreadsheet did carry, including a withdrawal', () => {
    const [row] = toImportPayload([
      validRow({ subscribedToNewsletter: false, subscribedToPrograms: true }),
    ])

    expect(row.subscribed_to_newsletter).toBe(false)
    expect(row.subscribed_to_programs).toBe(true)
  })

  it('folds a spelled-out state into the code the segment filter uses', () => {
    // The importer is the only place this can be fixed: a contact stored as
    // "New South Wales" never matches a segment filtering on NSW, so it silently
    // drops out of every state-based campaign.
    const [payload] = toImportPayload([
      validRow({ state: 'New South Wales' }),
    ])

    expect(payload.state).toBe('NSW')
  })

  it('keeps a state it cannot fold, rather than dropping the value', () => {
    const [payload] = toImportPayload([validRow({ state: 'Texas' })])

    expect(payload.state).toBe('Texas')
  })

  it('returns an empty array when nothing is valid', () => {
    expect(toImportPayload([{ isValid: false, errors: ['bad'] }])).toEqual([])
  })
})

describe('importContacts', () => {
  function mockDb(response: { data?: unknown; error?: unknown }) {
    return { rpc: jest.fn().mockResolvedValue(response) }
  }

  it('calls the import_contacts RPC with the mapped payload', async () => {
    const db = mockDb({ data: { inserted: 1, updated: 0, skipped: 0, total: 1 }, error: null })

    const result = await importContacts(db as never, [validRow()])

    expect(db.rpc).toHaveBeenCalledWith('import_contacts', {
      payload: [
        expect.objectContaining({ email: 'ada@example.com', first_name: 'Ada' }),
      ],
    })
    expect(result).toEqual({ inserted: 1, updated: 0, skipped: 0, total: 1 })
  })

  it('does not hit the database when there are no valid rows', async () => {
    const db = mockDb({ data: null, error: null })

    const result = await importContacts(db as never, [{ isValid: false, errors: ['bad'] }])

    expect(db.rpc).not.toHaveBeenCalled()
    expect(result).toEqual({
      inserted: 0,
      updated: 0,
      skipped: 1,
      archived_collisions: 0,
      total: 1,
    })
  })

  it('surfaces a descriptive error when the RPC fails', async () => {
    const db = mockDb({ data: null, error: { message: 'permission denied for table contacts' } })

    await expect(importContacts(db as never, [validRow()])).rejects.toThrow(
      /permission denied for table contacts/
    )
  })

  it('errors when the RPC returns no result payload', async () => {
    const db = mockDb({ data: null, error: null })

    await expect(importContacts(db as never, [validRow()])).rejects.toThrow(/no result/i)
  })
})
