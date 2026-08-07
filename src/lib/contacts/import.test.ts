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

  it('always sends the boolean flags, since they are authoritative on import', () => {
    const [row] = toImportPayload([validRow()])

    expect(row.is_customer).toBe(false)
    expect(row.subscribed_to_newsletter).toBe(true)
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
    expect(result).toEqual({ inserted: 0, updated: 0, skipped: 1, total: 1 })
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
