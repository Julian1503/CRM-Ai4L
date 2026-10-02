/**
 * @jest-environment node
 */
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { createCampaign } from './createCampaign'
import { LEGACY_V1 } from './templateContracts'

const TEMPLATE = { id: 'tpl-1', provider_automation_id: 'auto-t', consent_stream: 'programs', archived_at: null }

function setup(template: unknown = { data: TEMPLATE, error: null }, insert: unknown = { data: { id: 'camp-1', name: 'x' }, error: null }) {
  const templates = createQueryBuilderMock(template)
  const campaigns = createQueryBuilderMock(insert)
  const db = createDbMock((table: string) => (table === 'campaign_templates' ? templates : campaigns))
  return { db: db as never, templates, campaigns }
}

function inserted(campaigns: ReturnType<typeof setup>['campaigns']) {
  return (campaigns.argsFor('insert') as [Record<string, unknown>])[0]
}

describe('createCampaign', () => {
  it('takes stream, automation and template from the template', async () => {
    const { db, campaigns } = setup()

    const outcome = await createCampaign(db, { name: ' Intake ', segmentId: 'seg-1', source: { kind: 'template', templateId: 'tpl-1' } })

    expect(outcome.ok).toBe(true)
    expect(inserted(campaigns)).toMatchObject({
      name: 'Intake',
      template_id: 'tpl-1',
      provider_automation_id: 'auto-t',
      consent_stream: 'programs',
      merge_fields: {},
    })
    expect(inserted(campaigns)).not.toHaveProperty('status')
  })

  it('uses the stream named for a hand-typed automation', async () => {
    const { db, campaigns } = setup()

    await createCampaign(db, { name: 'x', segmentId: null, source: { kind: 'manual', automationId: 'auto-9', stream: 'newsletter' } })

    expect(inserted(campaigns)).toMatchObject({ template_id: null, provider_automation_id: 'auto-9', consent_stream: 'newsletter' })
  })

  it.each([
    ['a reserved field', { Headline: 'Hi', PrefsUrl: 'https://forged' }, /PrefsUrl is set at send time/],
    ['a booking link', { BookingUrl: 'https://x' }, /BookingUrl is set at send time/],
    ['an unknown key', { Nope: 'x' }, /Nope is not a field/],
    ['an over-long value', { CtaLabel: 'x'.repeat(40) }, /CtaLabel is 40 characters/],
  ])('refuses %s in the merge fields (the old route stored any string)', async (_label, mergeFields, message) => {
    const { db, campaigns } = setup()

    const outcome = await createCampaign(db, { name: 'x', segmentId: null, source: { kind: 'template', templateId: 'tpl-1' }, mergeFields })

    expect(outcome).toEqual({ ok: false, reason: 'bad_request', message: expect.stringMatching(message) })
    expect(campaigns.argsFor('insert')).toBeUndefined()
  })

  it('accepts partial copy and drops non-string values', async () => {
    const { db, campaigns } = setup()

    await createCampaign(db, { name: 'x', segmentId: null, source: { kind: 'template', templateId: 'tpl-1' }, mergeFields: { Headline: ' Hi ', Count: 3 } })

    expect(inserted(campaigns).merge_fields).toEqual({ Headline: 'Hi' })
  })

  it('refuses a Studio template: its campaigns are created from a snapshot', async () => {
    const { db } = setup({ data: { ...TEMPLATE, contract_id: 'studio-static-v1', contract_version: 1 }, error: null })

    const outcome = await createCampaign(db, { name: 'x', segmentId: null, source: { kind: 'template', templateId: 'tpl-1' } })

    expect(outcome).toMatchObject({ ok: false, reason: 'bad_request', message: expect.stringMatching(/Content Studio/) })
  })

  it.each([
    ['missing', { data: null, error: null }],
    ['archived', { data: { ...TEMPLATE, archived_at: '2026-01-01' }, error: null }],
    ['on an unknown contract', { data: { ...TEMPLATE, contract_id: 'future-v3', contract_version: 1 }, error: null }],
  ])('refuses a template that is %s', async (_label, template) => {
    const { db } = setup(template)

    const outcome = await createCampaign(db, { name: 'x', segmentId: null, source: { kind: 'template', templateId: 'tpl-1' } })

    expect(outcome).toMatchObject({ ok: false, reason: 'bad_request' })
  })

  it('requires a name', async () => {
    const { db } = setup()
    expect(await createCampaign(db, { name: '  ', segmentId: null, source: { kind: 'manual', automationId: null, stream: 'newsletter' } })).toMatchObject({ ok: false })
  })

  it('records a schedule occurrence and maps a duplicate one', async () => {
    const { db, campaigns } = setup(undefined, { data: null, error: { code: '23505', message: 'dup' } })

    const outcome = await createCampaign(db, {
      name: 'Monthly',
      segmentId: 'seg-1',
      source: { kind: 'resolved', templateId: 'tpl-1', automationId: 'auto-1', stream: 'newsletter', contract: LEGACY_V1 },
      scheduleId: 'sched-1',
      scheduledFor: '2026-10-01',
    })

    expect(inserted(campaigns)).toMatchObject({ schedule_id: 'sched-1', scheduled_for: '2026-10-01' })
    expect(outcome).toMatchObject({ ok: false, reason: 'duplicate' })
  })

  it('maps an archived segment and surfaces other failures', async () => {
    const archived = setup(undefined, { data: null, error: { code: 'CRM01', message: 'That segment is archived.' } })
    expect(await createCampaign(archived.db, { name: 'x', segmentId: 's', source: { kind: 'template', templateId: 'tpl-1' } })).toMatchObject({
      ok: false,
      reason: 'segment_archived',
    })

    const broken = setup(undefined, { data: null, error: { message: 'denied' } })
    await expect(createCampaign(broken.db, { name: 'x', segmentId: null, source: { kind: 'template', templateId: 'tpl-1' } })).rejects.toThrow('denied')

    const failedTemplate = setup({ data: null, error: { message: 'down' } })
    await expect(createCampaign(failedTemplate.db, { name: 'x', segmentId: null, source: { kind: 'template', templateId: 'tpl-1' } })).rejects.toThrow('down')
  })
})
