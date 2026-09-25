import { buildContactCsv, isExportFormat, toExportRows } from './export'

const row = {
  id: 'c1',
  first_name: 'Ada',
  last_name: 'Lovelace',
  preferred_name: null,
  email: 'ada@example.com',
  mobile_number: '0400000000',
  work_phone: null,
  address: null,
  suburb: 'Redfern',
  state: 'NSW',
  postcode: '2016',
  country: 'Australia',
  organisation_id: 'o1',
  job_type_id: 'j1',
  department: null,
  position: 'Analyst',
  notes: null,
  is_customer: true,
  status: 'customer',
  subscribed_to_newsletter: true,
  subscribed_to_programs: false,
  deleted_at: null,
  archive_reason: null,
  created_at: '2026-01-01T00:00:00.000Z',
  organisation: { name: 'Analytical Engines' },
  job_type: { name: 'Electrician' },
}

describe('isExportFormat', () => {
  it.each(['emailoctopus', 'full'])('accepts %s', (format) => {
    expect(isExportFormat(format)).toBe(true)
  })

  it.each(['', 'xlsx', 'FULL', undefined, null])('rejects %p', (format) => {
    expect(isExportFormat(format)).toBe(false)
  })
})

describe('toExportRows', () => {
  it('flattens the joined organisation and job type to names', () => {
    const [flat] = toExportRows([row as never])

    expect(flat.organisation).toBe('Analytical Engines')
    expect(flat.job_type).toBe('Electrician')
  })

  it('renders a missing join as an empty string, not "null"', () => {
    const [flat] = toExportRows([{ ...row, organisation: null, job_type: null } as never])

    expect(flat.organisation).toBe('')
    expect(flat.job_type).toBe('')
  })

  it('renders booleans as Yes/No for a human-readable export', () => {
    const [flat] = toExportRows([row as never])

    expect(flat.subscribed_to_newsletter).toBe('Yes')
    // Rendered independently: the two consents are separate permissions, and an export
    // that collapsed them would hand the client a file they cannot act on.
    expect(flat.subscribed_to_programs).toBe('No')
  })
})

describe('buildContactCsv', () => {
  describe('emailoctopus format', () => {
    it('emits exactly the columns EmailOctopus imports', () => {
      const csv = buildContactCsv([row as never], 'emailoctopus')
      const [header] = csv.split('\r\n')

      expect(header).toBe('EmailAddress,FirstName,LastName')
    })

    it('does not leak internal identifiers to a third-party tool', () => {
      const csv = buildContactCsv([row as never], 'emailoctopus')

      expect(csv).not.toContain('c1')
      expect(csv).not.toContain('o1')
      expect(csv).not.toContain('Analyst')
    })

    it('puts the email first, which is the field EmailOctopus keys on', () => {
      const csv = buildContactCsv([row as never], 'emailoctopus')
      const [, firstRow] = csv.split('\r\n')

      expect(firstRow.startsWith('ada@example.com')).toBe(true)
    })
  })

  describe('full format', () => {
    it('includes the segmentation fields', () => {
      const [header] = buildContactCsv([row as never], 'full').split('\r\n')

      expect(header).toContain('Job Type')
      expect(header).toContain('State')
      expect(header).toContain('Status')
      expect(header).toContain('Organisation')
    })

    it('omits the soft-delete bookkeeping column', () => {
      const [header] = buildContactCsv([row as never], 'full').split('\r\n')

      expect(header).not.toContain('deleted_at')
    })
  })

  it('escapes a formula payload in exported data', () => {
    // End-to-end check that the CSV escaping is actually wired into the export.
    const malicious = { ...row, first_name: '=cmd|calc' }
    const csv = buildContactCsv([malicious as never], 'full')

    expect(csv).toContain(`'=cmd|calc`)
    expect(csv).not.toContain(',=cmd|calc')
  })

  it('emits a header-only document for an empty result', () => {
    const csv = buildContactCsv([], 'emailoctopus')

    expect(csv).toBe('EmailAddress,FirstName,LastName')
  })
})
