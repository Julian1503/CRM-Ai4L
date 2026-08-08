import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  CAMPAIGN_TRANSITIONS,
  canTransition,
  checkApprovable,
  isSendable,
  isTerminal,
} from './campaignStatus'

describe('CAMPAIGN_TRANSITIONS', () => {
  it('only reaches sending from approved', () => {
    // The whole point of the approval gate: sending is irreversible.
    const sources = Object.entries(CAMPAIGN_TRANSITIONS)
      .filter(([, targets]) => targets.includes('sending'))
      .map(([from]) => from)

    expect(sources).toEqual(['approved'])
  })

  it('treats sent as terminal', () => {
    expect(isTerminal('sent')).toBe(true)
    expect(CAMPAIGN_TRANSITIONS.sent).toEqual([])
  })

  it('allows a failed campaign to be retried or reworked', () => {
    expect(canTransition('failed', 'approved')).toBe(true)
    expect(canTransition('failed', 'draft')).toBe(true)
  })

  it.each([
    ['draft', 'approved'],
    ['draft', 'sending'],
    ['in_review', 'sending'],
    ['sent', 'sending'],
    ['sent', 'draft'],
    ['sending', 'approved'],
  ] as const)('refuses %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false)
  })

  it('stays in step with the database trigger', () => {
    // The trigger is the real enforcement; this table only drives the UI. If they
    // drift, the UI offers actions the database rejects.
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20260808000000_segments_and_campaigns.sql'),
      'utf8'
    )

    for (const [from, targets] of Object.entries(CAMPAIGN_TRANSITIONS)) {
      if (targets.length === 0) continue

      const clause = new RegExp(`when '${from}'\\s+then array\\[([^\\]]*)\\]`)
      const match = sql.match(clause)

      expect(match).not.toBeNull()

      const sqlTargets = (match![1].match(/'([a-z_]+)'/g) ?? []).map((quoted) =>
        quoted.replaceAll("'", '')
      )

      expect(sqlTargets.sort()).toEqual([...targets].sort())
    }
  })
})

describe('isSendable', () => {
  it('is true only for approved', () => {
    expect(isSendable('approved')).toBe(true)
    expect(isSendable('draft')).toBe(false)
    expect(isSendable('in_review')).toBe(false)
    expect(isSendable('sent')).toBe(false)
  })
})

describe('checkApprovable', () => {
  const ready = {
    status: 'in_review' as const,
    providerAutomationId: 'auto-1',
    segmentId: 'seg-1',
  }

  it('approves a complete campaign under review', () => {
    expect(checkApprovable(ready)).toEqual({ ok: true })
  })

  it('refuses a draft that has not been reviewed', () => {
    const result = checkApprovable({ ...ready, status: 'draft' })

    expect(result.ok).toBe(false)
  })

  it('refuses without a segment', () => {
    const result = checkApprovable({ ...ready, segmentId: null })

    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/segment/i) })
  })

  it('refuses without a provider automation id', () => {
    // Approving without it produces a campaign that can never send, because
    // EmailOctopus cannot create one through the API.
    const result = checkApprovable({ ...ready, providerAutomationId: null })

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/Started via API/),
    })
  })

  it('treats a whitespace-only automation id as missing', () => {
    expect(checkApprovable({ ...ready, providerAutomationId: '   ' }).ok).toBe(false)
  })

  it('refuses to re-approve something already sent', () => {
    expect(checkApprovable({ ...ready, status: 'sent' }).ok).toBe(false)
  })
})
