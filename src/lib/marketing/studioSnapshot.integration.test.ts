/**
 * @jest-environment node
 *
 * The Content Studio → email bridge against the local stack, as the API drives it: the
 * server (service role) calls create_content_email_snapshot on behalf of a member
 * (p_actor) with a Studio-contract template and an existing Studio revision.
 *
 *   - a draft campaign is created whose stream and automation come from the template
 *   - the snapshot stores the content hash the database computed, and the campaign
 *     points at it
 *   - replaying the same idempotency key returns the same snapshot and campaign
 *   - a member cannot call the function directly (only the server renders emails)
 *   - a member cannot re-point the campaign's automation (CRM07 snapshot_content_locked)
 *
 * Needs an anon key (SUPABASE_INTEGRATION_ANON_KEY, or NEXT_PUBLIC_SUPABASE_ANON_KEY) to
 * sign a member in. Fixtures carry unique names and are never physically deleted.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { saveRevision } from '@/lib/content-studio/revisions'
import type { Database } from '@/lib/db/types'
import { integrationEnabled, must, serviceClient, uniqueTag } from '@/test/integration'

jest.setTimeout(60_000)

type Db = SupabaseClient<Database>

const url = process.env.SUPABASE_INTEGRATION_URL?.trim() ?? ''
const anonKey = (process.env.SUPABASE_INTEGRATION_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()
const describeBridge = integrationEnabled && anonKey !== '' ? describe : describe.skip

type SnapshotResult = { snapshotId: string; campaignId: string | null; created: boolean; contentHash: string }

async function signedInMember(admin: Db): Promise<{ id: string; client: Db }> {
  const email = `${uniqueTag('snapshot-it')}@example.invalid`
  const password = `Pw-${uniqueTag('it')}-9aZ`
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error || !data.user) throw new Error(`Could not create a test user: ${error?.message}`)
  await must(admin.from('crm_members').insert({ user_id: data.user.id, role: 'operator', active: true }).select('user_id').single())

  const client = createClient<Database>(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error: signInError } = await client.auth.signInWithPassword({ email, password })
  if (signInError) throw new Error(signInError.message)
  return { id: data.user.id, client }
}

async function studioRevision(admin: Db): Promise<string> {
  const brand = await must(admin.from('content_brand_profiles').select('id').eq('slug', 'ai4l').single())
  const item = await must(
    admin
      .from('content_items')
      .insert({ brand_id: brand.id, title: uniqueTag('snapshot-item'), brief: { topic: 'Email bridge' }, channels: ['email'] })
      .select('id')
      .single()
  )
  const variant = await must(admin.from('content_variants').insert({ item_id: item.id, channel: 'email' }).select('id').single())
  const revision = await saveRevision(admin, variant.id, {
    idempotencyKey: uniqueTag('snapshot-rev'),
    expectedRevisionId: null,
    content: { body: 'Hello from the Studio.', hashtags: [], callToAction: 'Reserve a place', linkUrl: null, fields: { subject: 'Hi' }, assets: [] },
  })
  return revision.id
}

async function studioTemplate(admin: Db) {
  return must(
    admin
      .from('campaign_templates')
      .insert({
        name: uniqueTag('Studio static'),
        provider_automation_id: uniqueTag('automation'),
        consent_stream: 'programs',
        contract_id: 'studio-static-v1',
        contract_version: 1,
        slots: [{ tag: 'Headline', label: 'Headline', description: 'Headline', maxLength: 120, role: 'headline' }],
      } as never)
      .select('id, provider_automation_id, consent_stream')
      .single()
  )
}

describeBridge('Studio email snapshot against Postgres', () => {
  it('creates a draft campaign from a Studio revision, idempotently, and locks its content', async () => {
    const admin = serviceClient()
    const member = await signedInMember(admin)
    const revisionId = await studioRevision(admin)
    const template = (await studioTemplate(admin)) as { id: string; provider_automation_id: string; consent_stream: string }
    const key = uniqueTag('snapshot-key')

    const args = {
      p_purpose: 'campaign',
      p_idempotency_key: key,
      p_source_revision_id: revisionId,
      p_template_id: template.id,
      p_cta_mode: 'none',
      p_cta_url: null,
      p_subject: 'Hello from the Studio',
      p_fields: { Headline: 'Hello' },
      p_assets: [],
      p_rendered_html: '<p>Hello</p>',
      p_rendered_text: 'Hello',
      p_campaign_name: uniqueTag('Studio email'),
      p_actor: member.id,
    }
    const rpc = (db: Db) => (db.rpc as unknown as (fn: string, a: unknown) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>)(
      'create_content_email_snapshot',
      args
    )

    const first = await rpc(admin)
    expect(first.error).toBeNull()
    const created = first.data as SnapshotResult
    expect(created).toMatchObject({ created: true, contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) })

    const campaign = await must(
      admin
        .from('campaigns')
        .select('id, status, consent_stream, provider_automation_id, template_id, content_snapshot_id, merge_fields')
        .eq('id', created.campaignId as string)
        .single()
    )
    expect(campaign).toMatchObject({
      status: 'draft',
      consent_stream: template.consent_stream,
      provider_automation_id: template.provider_automation_id,
      template_id: template.id,
      content_snapshot_id: created.snapshotId,
      merge_fields: { Headline: 'Hello' },
    })
    const snapshot = await must(
      admin.from('campaign_content_snapshots').select('content_hash, created_by, provider_automation_id').eq('id', created.snapshotId).single()
    )
    expect(snapshot).toEqual({ content_hash: created.contentHash, created_by: member.id, provider_automation_id: template.provider_automation_id })

    const replay = await rpc(admin)
    expect(replay.data).toEqual({ ...created, created: false })

    const direct = await rpc(member.client)
    expect(direct.data).toBeNull()
    expect(direct.error?.code === '42501' || /permission denied/i.test(direct.error?.message ?? '')).toBe(true)

    const repoint = await member.client.from('campaigns').update({ provider_automation_id: 'someone-elses-automation' }).eq('id', campaign.id)
    expect(repoint.error).toMatchObject({ code: 'CRM07', hint: 'snapshot_content_locked' })
    const unchanged = await must(admin.from('campaigns').select('provider_automation_id').eq('id', campaign.id).single())
    expect(unchanged.provider_automation_id).toBe(template.provider_automation_id)
  })
})
