import type { TableContact } from '@/components/ContactTable'
import type { ContactStatus } from '@/lib/db/types'
import { getSupabaseClient, hasSupabaseConfig } from '@/lib/supabaseClient'

/**
 * Browser-side helpers shared by the CRM workspaces: the contact row shape the list API
 * returns, its mapping to the table's shape, and the reference lists that feed dropdowns.
 */

export type ServiceOption = { id: string; name: string }

export type DbContact = {
  id: string
  first_name: string | null
  last_name: string | null
  preferred_name: string | null
  email: string | null
  mobile_number: string | null
  work_phone: string | null
  address: string | null
  suburb: string | null
  state: string | null
  postcode: string | null
  country: string | null
  department: string | null
  position: string | null
  notes: string | null
  status?: ContactStatus | null
  is_customer: boolean | null
  subscribed_to_newsletter: boolean | null
  subscribed_to_programs: boolean | null
  job_type_id: string | null
  organisation: { name: string } | null
  tags?: { id: string; name: string }[] | null
  revision?: number
}

type ContactServiceJoin = { contact_id: string; service_id: string }

/**
 * Ceiling on the reference tables that feed dropdowns (services, job types). They load
 * whole rather than by page, but still bounded: PostgREST caps a read at 1000 rows and
 * reports nothing when it does, so an unbounded query silently returns a prefix.
 */
export const REFERENCE_LIMIT = 200

export function formatContactFromDatabase(contact: DbContact, contactServices: string[] = []): TableContact {
  return {
    id: contact.id,
    firstName: contact.first_name || '',
    lastName: contact.last_name || '',
    preferredName: contact.preferred_name || '',
    email: contact.email || '',
    mobileNumber: contact.mobile_number || '',
    workPhone: contact.work_phone || '',
    address: contact.address || '',
    suburb: contact.suburb || '',
    state: contact.state || '',
    postcode: contact.postcode || '',
    country: contact.country || '',
    department: contact.department || '',
    position: contact.position || '',
    notes: contact.notes || '',
    status:
      contact.status && contact.status !== 'archived'
        ? contact.status
        : (contact.is_customer ? 'customer' : 'prospect'),
    isCustomer: contact.status ? contact.status === 'customer' : Boolean(contact.is_customer),
    subscribedToNewsletter: Boolean(contact.subscribed_to_newsletter),
    subscribedToPrograms: Boolean(contact.subscribed_to_programs),
    jobTypeId: contact.job_type_id || null,
    organisation: contact.organisation || null,
    servicesBought: contactServices,
    tags: contact.tags ?? [],
    revision: contact.revision,
  }
}

/**
 * Job types for the dropdowns, through the catalogue API so every screen reads the same
 * list with the same rules.
 */
export async function fetchJobTypes(): Promise<ServiceOption[]> {
  const response = await fetch(`/api/job-types?pageSize=${REFERENCE_LIMIT}`)
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(body.error || `Could not load job types (HTTP ${response.status})`)
  }
  return ((body.jobTypes ?? []) as ServiceOption[]).map((jobType) => ({ id: jobType.id, name: jobType.name }))
}

/**
 * Service IDs for the contacts on screen, keyed by contact. Scoped to the given IDs
 * rather than reading the whole join table.
 */
export async function fetchServicesForContacts(contactIds: string[]): Promise<Map<string, string[]>> {
  const byContact = new Map<string, string[]>()

  if (contactIds.length === 0 || !hasSupabaseConfig) {
    return byContact
  }

  const { data, error } = await getSupabaseClient()
    .from('contact_services')
    .select('contact_id, service_id')
    .in('contact_id', contactIds)

  if (error) throw error

  for (const join of (data || []) as ContactServiceJoin[]) {
    byContact.set(join.contact_id, [...(byContact.get(join.contact_id) ?? []), join.service_id])
  }

  return byContact
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}
