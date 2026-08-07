// Database types for the CRM schema.
//
// Hand-written to match supabase/migrations as of 20260807000000. Regenerate from the
// live schema once the migration is applied:
//
//   npm run db:types
//
// which runs: supabase gen types typescript --project-id <ref> --schema public
//
// Excluded from coverage (see jest.config.ts) — types only, no runtime behaviour.

export type ContactStatus = 'lead' | 'prospect' | 'customer' | 'archived'

export type ContactRow = {
  id: string
  first_name: string
  last_name: string
  preferred_name: string | null
  email: string
  mobile_number: string | null
  work_phone: string | null
  address: string | null
  suburb: string | null
  state: string | null
  postcode: string | null
  country: string | null
  organisation_id: string | null
  job_type_id: string | null
  department: string | null
  position: string | null
  notes: string | null
  /** @deprecated Superseded by `status`. Retained until a follow-up migration drops it. */
  is_customer: boolean
  status: ContactStatus
  subscribed_to_newsletter: boolean
  deleted_at: string | null
  created_at: string
}

export type OrganisationRow = {
  id: string
  name: string
  industry: string | null
  type: string | null
  size: string | null
  website: string | null
  created_at: string
}

export type JobTypeRow = {
  id: string
  name: string
  created_at: string
}

export type ServiceRow = {
  id: string
  name: string
  created_at: string
}

export type ContactServiceRow = {
  contact_id: string
  service_id: string
  created_at: string
}

export type CredentialRow = {
  key: string
  value: string
  created_at: string
}

export type SyncLogRow = {
  id: string
  event_text: string
  status: 'success' | 'failed' | 'info'
  created_at: string
}

/** Return shape of the public.import_contacts(jsonb) function. */
export type ImportContactsResult = {
  inserted: number
  updated: number
  skipped: number
  total: number
}

/** One element of the JSON array passed to public.import_contacts(jsonb). */
export type ImportContactPayloadRow = {
  email: string
  first_name: string
  last_name: string
  preferred_name?: string | null
  mobile_number?: string | null
  work_phone?: string | null
  address?: string | null
  suburb?: string | null
  state?: string | null
  postcode?: string | null
  country?: string | null
  department?: string | null
  position?: string | null
  organisation_name?: string | null
  job_type_name?: string | null
  is_customer?: boolean
  subscribed_to_newsletter?: boolean
}

// `Relationships` is required by postgrest-js's GenericTable/GenericView constraint.
// Omitting it makes `Database` fail `extends GenericSchema`, at which point supabase-js
// silently degrades to untyped queries and `rpc()` args resolve to `undefined`.
// Left empty because nothing here relies on typed embedded-resource selects yet;
// `npm run db:types` fills these in properly against the live schema.
type TableDef<Row, Insert = Partial<Row>, Update = Partial<Row>> = {
  Row: Row
  Insert: Insert
  Update: Update
  Relationships: []
}

export interface Database {
  public: {
    Tables: {
      contacts: TableDef<ContactRow>
      organisations: TableDef<OrganisationRow>
      job_types: TableDef<JobTypeRow>
      services: TableDef<ServiceRow>
      contact_services: TableDef<ContactServiceRow>
      credentials: TableDef<CredentialRow>
      sync_logs: TableDef<SyncLogRow>
    }
    Views: {
      /** contacts filtered to deleted_at IS NULL (security_invoker). */
      active_contacts: { Row: ContactRow; Relationships: [] }
    }
    Functions: {
      import_contacts: {
        Args: { payload: ImportContactPayloadRow[] }
        Returns: ImportContactsResult
      }
    }
    Enums: {
      contact_status: ContactStatus
    }
  }
}
