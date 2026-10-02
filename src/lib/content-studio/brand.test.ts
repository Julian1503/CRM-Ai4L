/** @jest-environment node */
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { getBrandProfile, updateBrandProfile } from './brand'
import { brandRow } from './testFixtures'

describe('brand profile', () => {
  it('reads the AI4L profile as the generator sees it', async () => {
    const db = createDbMock(createQueryBuilderMock({ data: brandRow(), error: null }))

    await expect(getBrandProfile(db as never)).resolves.toMatchObject({
      slug: 'ai4l',
      approvedFacts: [{ id: 'f1', text: 'Founded 2020', source: 'site' }],
      channelRules: { linkedin: { cta: 'Book a call' } },
      allowedLinkOrigins: ['https://ai4l.example'],
    })
  })

  it('updates through update_content_brand_profile with the member client', async () => {
    const db = createDbMock(createQueryBuilderMock())
    db.rpc.mockResolvedValue({ data: brandRow({ tone: 'Plain' }), error: null })

    await expect(updateBrandProfile(db as never, { tone: 'Plain' })).resolves.toMatchObject({ tone: 'Plain' })
    expect(db.rpc).toHaveBeenCalledWith('update_content_brand_profile', { p_slug: 'ai4l', p_profile: { tone: 'Plain' } })
  })

  it('propagates the database refusal', async () => {
    const db = createDbMock(createQueryBuilderMock())
    db.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'Only an administrator can change the brand profile.' } })

    await expect(updateBrandProfile(db as never, { tone: 'x' })).rejects.toMatchObject({ sqlState: '42501' })
  })
})
