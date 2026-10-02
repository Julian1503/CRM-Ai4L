/** @jest-environment node */
import {
  latestReviews,
  toAsset,
  toBrandProfile,
  toBrief,
  toItem,
  toItemSummary,
  toJob,
  toPublication,
  toRevision,
  toSocialAccount,
  toVariant,
} from './mappers'
import {
  accountRow,
  assetRow,
  brandRow,
  IDS,
  itemRow,
  jobRow,
  publicationRow,
  reviewRow,
  revisionRow,
  variantRow,
} from './testFixtures'

describe('toBrandProfile', () => {
  it('maps facts and rules, dropping malformed facts', () => {
    const brand = toBrandProfile(
      brandRow({ approved_facts: [{ id: 'f1', text: 'A', source: 's' }, { text: 'B' }, { id: 'x' }, 'junk'] })
    )

    expect(brand.approvedFacts).toEqual([
      { id: 'f1', text: 'A', source: 's' },
      { id: 'fact-2', text: 'B' },
    ])
    expect(brand.channelRules).toEqual({ linkedin: { cta: 'Book a call' } })
    expect(brand.hashtagSeeds).toEqual(['AI4L'])
  })

  it('degrades non-object JSON to empty values', () => {
    const brand = toBrandProfile(
      brandRow({ approved_facts: null, channel_rules: [], hashtag_seeds: null as never, allowed_link_origins: null as never })
    )

    expect(brand).toMatchObject({ approvedFacts: [], channelRules: {}, hashtagSeeds: [], allowedLinkOrigins: [] })
  })
})

describe('reviews and revisions', () => {
  it('latestReviews keeps the newest review per revision, ties broken by id', () => {
    const older = reviewRow({ id: 'a', decision: 'approved', created_at: '2026-01-01T00:00:00Z' })
    const newer = reviewRow({ id: 'b', decision: 'rejected', reason: 'no', created_at: '2026-01-02T00:00:00Z' })
    const tie = reviewRow({ id: 'c', decision: 'approved', created_at: '2026-01-02T00:00:00Z' })
    const other = reviewRow({ id: 'd', revision_id: IDS.revision2 })

    const latest = latestReviews([newer, older, tie, other])

    expect(latest.get(IDS.revision)?.id).toBe('c')
    expect(latest.get(IDS.revision2)?.id).toBe('d')
    expect(latestReviews([older, newer]).get(IDS.revision)?.id).toBe('b')
  })

  it('derives review state from the latest review, pending without one', () => {
    expect(toRevision(revisionRow(), undefined)).toMatchObject({ review: 'pending', reviewedAt: null, reviewReason: null })
    expect(toRevision(revisionRow(), reviewRow({ decision: 'rejected', reason: 'tone' }))).toMatchObject({
      review: 'rejected',
      reviewReason: 'tone',
    })
  })

  it('maps content and tolerates malformed JSON columns', () => {
    const revision = toRevision(
      revisionRow({ fields: [] as never, assets: [{ assetId: IDS.asset }, 'junk'] as never, violations: ['long', 3], facts: null, hashtags: null as never }),
      null
    )

    expect(revision).toMatchObject({
      fields: {},
      assets: [{ assetId: IDS.asset, alt: '', order: 0 }],
      violations: ['long'],
      facts: [],
      hashtags: [],
    })
  })

  it('toVariant embeds the current revision', () => {
    const current = toRevision(revisionRow(), null)
    expect(toVariant(variantRow(), current)).toMatchObject({ id: IDS.variant, channel: 'linkedin', current })
  })
})

describe('jobs, publications, assets, accounts', () => {
  it('toJob exposes partial generation failures only', () => {
    const job = toJob(
      jobRow({ result: { failures: [{ channel: 'email', errorCode: 'x', message: 'm' }, { channel: 'facebook' }, 'junk'] } })
    )

    expect(job.failures).toEqual([
      { channel: 'email', errorCode: 'x', message: 'm' },
      { channel: 'facebook', errorCode: 'unknown', message: '' },
    ])
    expect(toJob(jobRow({ result: null })).failures).toEqual([])
    expect(toJob(jobRow({ result: null })).warnings).toEqual([])
    expect(toJob(jobRow({ result: { warnings: ['Reference URL unreadable', 7] } })).warnings).toEqual(['Reference URL unreadable'])
    expect(toJob(jobRow()).kind).toBe('generate_text')
  })

  it('toPublication, toAsset and toSocialAccount map every field', () => {
    expect(toPublication(publicationRow())).toMatchObject({ id: IDS.publication, status: 'queued', accountId: IDS.account })
    expect(toAsset(assetRow(), 'https://signed')).toMatchObject({ id: IDS.asset, previewUrl: 'https://signed', altText: 'A photo' })
    expect(toSocialAccount(accountRow({ scopes: null as never }))).toMatchObject({ id: IDS.account, scopes: [] })
  })
})

describe('items', () => {
  it('toBrief falls back to an empty topic for a malformed brief', () => {
    expect(toBrief({ topic: 'x', notes: 'n' })).toEqual({ topic: 'x', notes: 'n' })
    expect(toBrief(null)).toEqual({ topic: '' })
  })

  it('toItemSummary and toItem combine the row with derived data', () => {
    const counts = { variantCount: 2, approvedCount: 1, pendingReviewCount: 1, activeJobCount: 0 }

    expect(toItemSummary(itemRow(), counts)).toMatchObject({ id: IDS.item, ...counts })
    expect(toItem(itemRow(), { variants: [], jobs: [], publications: [] })).toMatchObject({
      id: IDS.item,
      brief: { topic: 'AI adoption' },
      variants: [],
    })
  })
})
