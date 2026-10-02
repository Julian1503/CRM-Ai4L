/**
 * @jest-environment node
 *
 * advanceCampaignSend for Content Studio campaigns: the snapshot decides the fields and
 * the CTA, the dynamic-fields flag stops new deliveries, and only booking needs an origin.
 */
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { ContentResolutionError } from './campaignContent'
import { advanceCampaignSend } from './dispatch'
import { STUDIO_STATIC_V1 } from './templateContracts'

const mockPrepare = jest.fn()
const mockExecute = jest.fn()
const mockSummary = jest.fn()
const mockResolve = jest.fn()
const mockAssess = jest.fn()

jest.mock('./runs', () => ({ ...jest.requireActual('./runs'), prepareCampaignRun: (...args: unknown[]) => mockPrepare(...args) }))
jest.mock('./send', () => ({ executeCampaignSends: (...args: unknown[]) => mockExecute(...args) }))
jest.mock('./sendStatus', () => ({ readCampaignSendSummary: (...args: unknown[]) => mockSummary(...args) }))
jest.mock('./campaignContent', () => ({
  ...jest.requireActual('./campaignContent'),
  resolveSendContent: (...args: unknown[]) => mockResolve(...args),
  assessContent: (...args: unknown[]) => mockAssess(...args),
}))

const sending = {
  id: 'camp-1',
  status: 'sending',
  segment_id: 'seg-1',
  provider_automation_id: 'auto-1',
  revision: 2,
  approved_revision: 2,
  send_run: 1,
  archived_at: null,
  removed_at: null,
  merge_fields: {},
  consent_stream: 'newsletter',
  content_snapshot_id: 'snap-1',
}

const base = { credentials: { apiKey: 'k', listId: 'l' }, chunkSize: 50, provider: {} as never }

function db() {
  const campaigns = createQueryBuilderMock([{ data: sending, error: null }, { data: null, error: null }])
  return createDbMock((table: string) => (table === 'campaigns' ? campaigns : createQueryBuilderMock({ data: null, error: null }))) as never
}

describe('advanceCampaignSend with Studio content', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockExecute.mockResolvedValue({ total: 1, sent: 1, failed: 0, skipped: 0, uncertain: 0, remaining: 0, lost: 0 })
    mockSummary.mockResolvedValue({ run: 1, total: 1, sent: 1, failed: 0, pending: 0, processing: 0, skipped: 0, uncertain: 0 })
    mockAssess.mockReturnValue([])
    mockResolve.mockResolvedValue({ fields: {}, ctaMode: 'none', contract: STUDIO_STATIC_V1, snapshot: { id: 'snap-1' }, contentHash: 'h' })
  })

  it('sends the snapshot with its CTA mode, with no app origin needed', async () => {
    const outcome = await advanceCampaignSend(db(), 'camp-1', { ...base, baseUrl: null })

    expect(outcome.kind).toBe('progress')
    expect(mockExecute).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ id: 'camp-1' }), {
      maxToProcess: 50,
      baseUrl: undefined,
      content: { fields: {}, ctaMode: 'none' },
    })
  })

  it('stops a send whose content is no longer allowed (flag switched off)', async () => {
    mockAssess.mockReturnValue(['Field-based Studio emails are switched off.'])

    const outcome = await advanceCampaignSend(db(), 'camp-1', { ...base, baseUrl: 'https://crm', dynamicEnabled: false })

    expect(outcome).toEqual({ kind: 'conflict', message: 'Field-based Studio emails are switched off.' })
    expect(mockAssess).toHaveBeenCalledWith(expect.anything(), { dynamicEnabled: false })
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it('needs an app origin only for booking', async () => {
    mockResolve.mockResolvedValue({ fields: {}, ctaMode: 'booking', contract: STUDIO_STATIC_V1, snapshot: { id: 'snap-1' }, contentHash: 'h' })

    const outcome = await advanceCampaignSend(db(), 'camp-1', { ...base, baseUrl: null })

    expect(outcome).toMatchObject({ kind: 'conflict', message: expect.stringMatching(/NEXT_PUBLIC_APP_URL/) })
  })

  it('turns an unreadable snapshot into a conflict and rethrows anything else', async () => {
    mockResolve.mockRejectedValueOnce(new ContentResolutionError('gone'))
    expect(await advanceCampaignSend(db(), 'camp-1', { ...base, baseUrl: 'https://crm' })).toEqual({ kind: 'conflict', message: 'gone' })

    mockResolve.mockRejectedValueOnce(new Error('down'))
    await expect(advanceCampaignSend(db(), 'camp-1', { ...base, baseUrl: 'https://crm' })).rejects.toThrow('down')
  })
})
