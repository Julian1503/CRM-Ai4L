/**
 * @jest-environment node
 */
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { generateForCampaign } from './generateForCampaign'
import { newsletterTemplateProblem } from './schedules/templateCheck'

const mockGenerate = jest.fn()
const mockMeasure = jest.fn()

jest.mock('./generateCampaign', () => ({ generateCampaignCopy: (...args: unknown[]) => mockGenerate(...args) }))
jest.mock('./segments', () => ({ measureSegmentAudience: (...args: unknown[]) => mockMeasure(...args) }))

const CAMPAIGN = {
  id: 'camp-1',
  name: 'Intake',
  status: 'draft',
  notes: null,
  segment_id: 'seg-1',
  consent_stream: 'newsletter',
  template_id: null,
  content_snapshot_id: null,
  segment: { name: 'All', description: null, definition: {} },
}

function setup(campaign: unknown, template: unknown = { data: null, error: null }) {
  const campaigns = createQueryBuilderMock([{ data: campaign, error: null }, { data: { ...CAMPAIGN, merge_fields: {} }, error: null }])
  const templates = createQueryBuilderMock(template)
  const db = createDbMock((table: string) => (table === 'campaign_templates' ? templates : campaigns))
  return db as never
}

describe('generateForCampaign and contracts', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockMeasure.mockResolvedValue({ total: 5, truncated: false })
    mockGenerate.mockResolvedValue({ ok: true, copy: { Headline: 'H' }, attempts: 1, usage: { inputTokens: 1, outputTokens: 1 } })
  })

  it('never rewrites a Content Studio email', async () => {
    const outcome = await generateForCampaign(setup({ ...CAMPAIGN, content_snapshot_id: 'snap-1' }), {} as never, 'camp-1')

    expect(outcome).toMatchObject({ ok: false, reason: 'conflict', message: expect.stringMatching(/Content Studio/) })
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('refuses a Studio template', async () => {
    const db = setup({ ...CAMPAIGN, template_id: 'tpl-1' }, { data: { contract_id: 'studio-newsletter-v1', contract_version: 1 }, error: null })

    expect(await generateForCampaign(db, {} as never, 'camp-1')).toMatchObject({ ok: false, reason: 'conflict' })
  })

  it('writes legacy copy for its template contract', async () => {
    const db = setup({ ...CAMPAIGN, template_id: 'tpl-1' }, { data: { contract_id: 'legacy-v1', contract_version: 1 }, error: null })

    const outcome = await generateForCampaign(db, {} as never, 'camp-1')

    expect(outcome.ok).toBe(true)
    expect(mockGenerate).toHaveBeenCalledWith(expect.anything(), expect.anything(), { contract: expect.objectContaining({ id: 'legacy-v1' }) })
  })

  it('surfaces a template read failure', async () => {
    const db = setup({ ...CAMPAIGN, template_id: 'tpl-1' }, { data: null, error: { message: 'down' } })
    await expect(generateForCampaign(db, {} as never, 'camp-1')).rejects.toThrow('down')
  })
})

describe('newsletterTemplateProblem', () => {
  function templateDb(row: unknown) {
    return createDbMock(createQueryBuilderMock({ data: row, error: null })) as never
  }

  it('accepts a classic newsletter template and refuses a Studio one', async () => {
    const base = { consent_stream: 'newsletter', archived_at: null, provider_automation_id: 'auto-1' }
    expect(await newsletterTemplateProblem(templateDb(base), 't1')).toBeNull()
    expect(await newsletterTemplateProblem(templateDb({ ...base, contract_id: 'studio-static-v1', contract_version: 1 }), 't1')).toMatch(/legacy-v1/)
  })
})
