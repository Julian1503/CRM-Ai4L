// Database types for the CRM schema.
//
// Hand-written to match supabase/migrations as of 20260901000000. Regenerate from the
// live schema once the migration is applied:
//
//   npm run db:types
//
// which runs: supabase gen types typescript --project-id <ref> --schema public
//
// Excluded from coverage (see jest.config.ts) — types only, no runtime behaviour.

import type { TemplateSlot } from '@/lib/marketing/templates'

export type ContactStatus = 'lead' | 'prospect' | 'customer' | 'archived'

/**
 * Why a contact is archived.
 *
 * `opted_out` is set by the database when a contact loses every consent, and is the
 * only reason the same rule will undo. A `manual` archive is a person's decision and no
 * external signup can reverse it — see 20260901000000_dual_consent.sql.
 */
export type ArchiveReason = 'manual' | 'opted_out'

/**
 * The two kinds of email a contact consents to separately.
 *
 * Also what a campaign spends: the segment gate forces the consent column matching the
 * campaign's stream, so a course invitation cannot reach a newsletter-only contact.
 */
export type ConsentStream = 'newsletter' | 'programs'

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
  /** The named template this campaign's copy was written for; null means the built-in one. */
  template_id: string | null
  /** Copied from the template at creation and frozen, so a sent campaign stays explicable. */
  consent_stream: ConsentStream
  subject: string | null
  notes: string | null
  approved_at: string | null
  approved_by: string | null
  started_at: string | null
  completed_at: string | null
  /**
   * Which fan-out this campaign is on. Incremented when a sent campaign is re-opened,
   * so a second send builds its own ledger instead of overwriting the first one's.
   */
  send_run: number
  created_at: string
  updated_at: string
}

/**
 * A named provider template — the registry that gives an EmailOctopus automation id a
 * name an operator can recognise. See `src/lib/marketing/templates.ts` for why the
 * names cannot come from EmailOctopus itself.
 */
export type CampaignTemplateRow = {
  id: string
  name: string
  description: string | null
  provider: string
  /** EmailOctopus automation with the "Started via API" trigger. */
  provider_automation_id: string | null
  /** The merge-field contract the automation's template references. */
  slots: TemplateSlot[]
  /** Which consent a campaign built on this template spends. */
  consent_stream: ConsentStream
  brief: string | null
  /** Retired from the pickers, but kept: sent campaigns still reference it. */
  archived_at: string | null
  created_at: string
  updated_at: string
}

export type CampaignSendRow = {
  id: string
  campaign_id: string
  contact_id: string
  /** The campaign fan-out this row belongs to. See `CampaignRow.send_run`. */
  run: number
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
  /** Courses, trainings and programmes. Independent of the newsletter. */
  subscribed_to_programs: boolean
  deleted_at: string | null
  /** Null while active; set by the database whenever `deleted_at` is. */
  archive_reason: ArchiveReason | null
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
  /**
   * Rows held back because the address belongs to an archived contact and to no live
   * one. Importing them would create a duplicate live record and hand back the consent
   * that archived them, so they wait for a person to merge or restore.
   */
  archived_collisions: number
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
  /**
   * Omitted when the spreadsheet has no column for it — which is not the same as
   * `false`. The RPC grants consent to a *new* contact and never raises an existing
   * one's, so a re-import cannot re-subscribe somebody who opted out.
   */
  subscribed_to_newsletter?: boolean
  subscribed_to_programs?: boolean
}

/**
 * One entry in the append-only consent ledger.
 *
 * Written only by the `contacts_record_consent_events` trigger; there is no insert
 * policy, so nothing that goes through PostgREST can add, edit or remove a row.
 */
export type ContactConsentEventRow = {
  id: string
  contact_id: string
  stream: ConsentStream
  granted: boolean
  /** Where the change came from: preference_center, newsletter_webhook, import, … */
  source: string
  /** Request context — IP, user agent, provider event id. Shape varies by source. */
  evidence: Record<string, unknown> | null
  occurred_at: string
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
      contact_consent_events: TableDef<ContactConsentEventRow>
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
      campaign_templates: TableDef<CampaignTemplateRow>
      bookings: TableDef<BookingRow>
    }
    Views: {
      /** contacts filtered to deleted_at IS NULL (security_invoker). */
      active_contacts: { Row: ContactRow; Relationships: [] }
    }
    Functions: {
      create_campaign_booking: {
        Args: {
          p_token_hash: string
          p_contact_id: string
          p_campaign_id: string
          p_expires_at: string
        }
        Returns: string
      }
      import_contacts: {
        Args: { payload: ImportContactPayloadRow[] }
        Returns: ImportContactsResult
      }
      apply_contact_consent: {
        Args: {
          p_contact_id: string
          /** Null leaves this stream untouched. */
          p_newsletter: boolean | null
          p_programs: boolean | null
          p_source: string
          p_evidence?: Record<string, unknown> | null
        }
        Returns: undefined
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
      consent_stream: ConsentStream
      integration_delivery_status: IntegrationDeliveryStatus
    }
  }
}
