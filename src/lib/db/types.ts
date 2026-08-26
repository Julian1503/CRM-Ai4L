// Database types for the CRM schema.
//
// Hand-written to match supabase/migrations as of 20260825030000. Regenerate from the
// live schema once the migration is applied:
//
//   npm run db:types
//
// which runs: supabase gen types typescript --project-id <ref> --schema public
//
// Excluded from coverage (see jest.config.ts) — types only, no runtime behaviour.

export type ContactStatus = 'lead' | 'prospect' | 'customer' | 'archived'

export type CampaignStatus =
  | 'draft'
  | 'in_review'
  | 'approved'
  | 'sending'
  | 'sent'
  | 'failed'

export type BookingStatus =
  | 'pending'
  | 'checkout_started'
  | 'paid'
  | 'booked'
  | 'cancelled'
  | 'expired'

export type IntegrationDeliveryStatus =
  | 'processing'
  | 'succeeded'
  | 'completed_with_errors'
  | 'failed'

export type IntegrationDeliveryRow = {
  id: string
  provider: 'emailoctopus' | 'stripe' | 'calendly'
  event_type: string | null
  status: IntegrationDeliveryStatus
  event_count: number
  processed_count: number
  failed_count: number
  error_code: string | null
  started_at: string
  completed_at: string | null
}

export type BookingRow = {
  id: string
  /** SHA-256 of the token in the email link; the raw token is never stored. */
  token_hash: string
  contact_id: string
  campaign_id: string | null
  status: BookingStatus
  expires_at: string
  consumed_at: string | null
  stripe_session_id: string | null
  stripe_promotion_code_id: string | null
  calendly_event_uri: string | null
  calendly_invitee_uri: string | null
  scheduled_at: string | null
  cancelled_at: string | null
  list_amount_cents: number
  charged_amount_cents: number | null
  currency: string
  created_at: string
  updated_at: string
}

export type SegmentRow = {
  id: string
  name: string
  description: string | null
  definition: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type CampaignRow = {
  id: string
  name: string
  segment_id: string | null
  status: CampaignStatus
  provider: string
  /** EmailOctopus automation with the "Started via API" trigger. */
  provider_automation_id: string | null
  merge_fields: Record<string, string>
  subject: string | null
  notes: string | null
  approved_at: string | null
  approved_by: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

export type CampaignSendRow = {
  id: string
  campaign_id: string
  contact_id: string
  status: 'pending' | 'sent' | 'failed' | 'skipped'
  provider_reference: string | null
  error: string | null
  attempted_at: string | null
  created_at: string
}

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
  /** newsletter | import | manual. Null for rows predating the column. */
  source: string | null
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

export type WebhookEventRow = {
  id: string
  provider: string
  event_id: string
  event_type: string | null
  received_at: string
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
// Defaults to empty; tables whose foreign keys are used in embedded-resource selects
// (`select('*, organisation:organisations(name)')`) must declare them, or postgrest-js
// resolves the embed to SelectQueryError instead of the joined row.
// `npm run db:types` fills these in properly against the live schema.
type TableDef<
  Row,
  Insert = Partial<Row>,
  Update = Partial<Row>,
  Relationships extends readonly unknown[] = [],
> = {
  Row: Row
  Insert: Insert
  Update: Update
  Relationships: Relationships
}

/** Foreign keys declared in 20260603000000_init_schema and 20260807000000_soft_delete_and_segmentation. */
type ContactRelationships = [
  {
    foreignKeyName: 'contacts_organisation_id_fkey'
    columns: ['organisation_id']
    isOneToOne: false
    referencedRelation: 'organisations'
    referencedColumns: ['id']
  },
  {
    foreignKeyName: 'contacts_job_type_id_fkey'
    columns: ['job_type_id']
    isOneToOne: false
    referencedRelation: 'job_types'
    referencedColumns: ['id']
  },
]

export interface Database {
  public: {
    Tables: {
      contacts: TableDef<ContactRow, Partial<ContactRow>, Partial<ContactRow>, ContactRelationships>
      organisations: TableDef<OrganisationRow>
      job_types: TableDef<JobTypeRow>
      services: TableDef<ServiceRow>
      contact_services: TableDef<ContactServiceRow>
      credentials: TableDef<CredentialRow>
      sync_logs: TableDef<SyncLogRow>
      webhook_events: TableDef<WebhookEventRow>
      integration_deliveries: TableDef<IntegrationDeliveryRow>
      segments: TableDef<SegmentRow>
      campaigns: TableDef<CampaignRow>
      campaign_sends: TableDef<CampaignSendRow>
      bookings: TableDef<BookingRow>
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
      get_operations_summary: {
        Args: Record<string, never>
        Returns: import('@/lib/operations/types').OperationsSummary
      }
    }
    Enums: {
      contact_status: ContactStatus
      campaign_status: CampaignStatus
      booking_status: BookingStatus
      integration_delivery_status: IntegrationDeliveryStatus
    }
  }
}
