import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'

/**
 * Contact saves through one transactional database call (audit H8).
 *
 * The browser used to write the organisation, the contact and its service links in
 * four separate requests. `save_contact()` does it atomically, validates every
 * reference first, and refuses to overwrite a revision the editor never saw.
 */

export type ContactSaveInput = {
  firstName: string
  lastName: string
  preferredName?: string
  email: string
  mobileNumber?: string
  workPhone?: string
  address?: string
  suburb?: string
  state?: string
  postcode?: string
  country?: string
  organisationName?: string
  jobTypeId?: string | null
  department?: string
  position?: string
  notes?: string
  status?: 'lead' | 'prospect' | 'customer'
  subscribedToNewsletter?: boolean
  subscribedToPrograms?: boolean
  servicesBought?: string[]
}

export type SaveContactResult =
  | { kind: 'saved'; contact: Record<string, unknown> }
  | { kind: 'invalid'; message: string }
  | { kind: 'conflict'; message: string }
  | { kind: 'not_found' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STATUSES = new Set(['lead', 'prospect', 'customer'])
const MAX_TEXT = 2000

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT) : undefined
}

/** Shape-checks an untrusted request body. Business rules are enforced in the database. */
export function parseContactSaveInput(
  body: Record<string, unknown>
): { ok: true; input: ContactSaveInput } | { ok: false; error: string } {
  const firstName = text(body.firstName)?.trim()
  const lastName = text(body.lastName)?.trim()
  const email = text(body.email)?.trim()

  if (!firstName) return { ok: false, error: 'First name is required.' }
  if (!lastName) return { ok: false, error: 'Last name is required.' }
  if (!email) return { ok: false, error: 'Email is required.' }

  const status = body.status ?? (body.isCustomer === true ? 'customer' : 'prospect')
  if (typeof status !== 'string' || !STATUSES.has(status)) {
    return { ok: false, error: 'Status must be lead, prospect or customer.' }
  }

  const jobTypeId = body.jobTypeId === '' || body.jobTypeId == null ? null : body.jobTypeId
  if (jobTypeId !== null && (typeof jobTypeId !== 'string' || !UUID.test(jobTypeId))) {
    return { ok: false, error: 'jobTypeId must be a UUID.' }
  }

  const services = body.servicesBought ?? []
  if (!Array.isArray(services) || !services.every((id) => typeof id === 'string' && UUID.test(id))) {
    return { ok: false, error: 'servicesBought must be a list of service ids.' }
  }

  for (const flag of ['subscribedToNewsletter', 'subscribedToPrograms'] as const) {
    if (body[flag] !== undefined && typeof body[flag] !== 'boolean') {
      return { ok: false, error: `${flag} must be true or false.` }
    }
  }

  return {
    ok: true,
    input: {
      firstName,
      lastName,
      email,
      preferredName: text(body.preferredName),
      mobileNumber: text(body.mobileNumber),
      workPhone: text(body.workPhone),
      address: text(body.address),
      suburb: text(body.suburb),
      state: text(body.state),
      postcode: text(body.postcode),
      country: text(body.country),
      organisationName: text(body.organisationName),
      jobTypeId,
      department: text(body.department),
      position: text(body.position),
      notes: text(body.notes),
      status: status as ContactSaveInput['status'],
      subscribedToNewsletter: body.subscribedToNewsletter as boolean | undefined,
      subscribedToPrograms: body.subscribedToPrograms as boolean | undefined,
      servicesBought: [...new Set(services as string[])],
    },
  }
}

function toRow(id: string | null, input: ContactSaveInput): Record<string, unknown> {
  return {
    id,
    first_name: input.firstName,
    last_name: input.lastName,
    preferred_name: input.preferredName ?? '',
    email: input.email,
    mobile_number: input.mobileNumber ?? '',
    work_phone: input.workPhone ?? '',
    address: input.address ?? '',
    suburb: input.suburb ?? '',
    state: input.state ?? '',
    postcode: input.postcode ?? '',
    country: input.country ?? '',
    organisation_name: input.organisationName ?? '',
    job_type_id: input.jobTypeId ?? null,
    department: input.department ?? '',
    position: input.position ?? '',
    notes: input.notes ?? '',
    status: input.status ?? 'prospect',
    subscribed_to_newsletter: input.subscribedToNewsletter ?? null,
    subscribed_to_programs: input.subscribedToPrograms ?? null,
  }
}

export async function saveContact(
  db: SupabaseClient<Database>,
  params: { id: string | null; input: ContactSaveInput; expectedRevision: number | null }
): Promise<SaveContactResult> {
  const rpc = db.rpc.bind(db) as unknown as (
    fn: 'save_contact',
    args: Record<string, unknown>
  ) => PromiseLike<{ data: Record<string, unknown> | null; error: { code?: string; message: string } | null }>

  const { data, error } = await rpc('save_contact', {
    p_contact: toRow(params.id, params.input),
    p_services: params.input.servicesBought ?? [],
    p_expected_revision: params.expectedRevision,
  })

  if (error?.code === 'CRM07') return { kind: 'invalid', message: error.message }
  if (error?.code === 'CRM06') return { kind: 'conflict', message: error.message }
  if (error?.code === 'P0002') return { kind: 'not_found' }
  if (error?.code === '23505') {
    return { kind: 'conflict', message: 'Another active contact already uses that email address.' }
  }
  if (error) throw new Error(error.message)
  if (!data) throw new Error('The contact save returned nothing.')

  return { kind: 'saved', contact: data }
}
