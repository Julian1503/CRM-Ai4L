import type { ContactRow, ContactStatus } from '@/lib/db/types'
import type { MappedContactRow } from '@/lib/excelParser'

// Test data builders. Every field has a deterministic default so a test only states
// what it actually cares about, and adding a schema column does not touch every test.

let sequence = 0

/** Deterministic per-call counter, reset via `resetFactorySequence()`. */
function next(): number {
  sequence += 1
  return sequence
}

export function resetFactorySequence(): void {
  sequence = 0
}

export function buildContactRow(overrides: Partial<ContactRow> = {}): ContactRow {
  const n = next()

  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    first_name: `First${n}`,
    last_name: `Last${n}`,
    preferred_name: null,
    email: `contact${n}@example.com`,
    mobile_number: null,
    work_phone: null,
    address: null,
    suburb: null,
    state: 'NSW',
    postcode: null,
    country: 'Australia',
    organisation_id: null,
    job_type_id: null,
    department: null,
    position: null,
    notes: null,
    is_customer: false,
    status: 'prospect' as ContactStatus,
    subscribed_to_newsletter: false,
    subscribed_to_programs: false,
    deleted_at: null,
    archive_reason: null,
    removed_at: null,
    removed_by: null,
    source: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

export function buildArchivedContactRow(overrides: Partial<ContactRow> = {}): ContactRow {
  return buildContactRow({
    status: 'archived',
    deleted_at: '2026-06-01T00:00:00.000Z',
    // The database never leaves an archived row without one; defaulting to the
    // operator's own decision keeps a fixture from implying an unsubscribe.
    archive_reason: 'manual',
    ...overrides,
  })
}

type MappedData = NonNullable<MappedContactRow['data']>

export function buildMappedRow(overrides: Partial<MappedData> = {}): MappedContactRow {
  const n = next()

  return {
    isValid: true,
    data: {
      firstName: `First${n}`,
      lastName: `Last${n}`,
      email: `import${n}@example.com`,
      isCustomer: false,
      subscribedToNewsletter: false,
      ...overrides,
    },
  }
}

export function buildInvalidMappedRow(errors: string[] = ['Email address is required']): MappedContactRow {
  return { isValid: false, errors }
}
