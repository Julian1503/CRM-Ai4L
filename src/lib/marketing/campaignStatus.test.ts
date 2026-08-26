import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  CAMPAIGN_TRANSITIONS,
  canReopen,
  canTransition,
  checkApprovable,
  isSendable,
  isTerminal,
} from './campaignStatus'

const MIGRATIONS_DIR = join(process.cwd(), 'supabase/migrations')

/**
 * The migration that currently defines the status trigger.
 *
 * Migrations accumulate and `create or replace` means the *last* definition wins, so
 * reading a fixed filename would compare the UI against a superseded trigger — which is
 * exactly the drift this test exists to catch.
 */
function latestTriggerDefinition(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort()

  const defining = files.filter((file) =>
    readFileSync(join(MIGRATIONS_DIR, file), 'utf8').includes(
      'function public.enforce_campaign_status_transition()'
    )
  )

  expect(defining.length).toBeGreaterThan(0)

  return readFileSync(join(MIGRATIONS_DIR, defining.at(-1)!), 'utf8')
}

describe('CAMPAIGN_TRANSITIONS', () => {
  it('only reaches sending from approved', () => {
    // The whole point of the approval gate: sending is irreversible.
    const sources = Object.entries(CAMPAIGN_TRANSITIONS)
      .filter(([, targets]) => targets.includes('sending'))
      .map(([from]) => from)

    expect(sources).toEqual(['approved'])
  })

  it('lets a sent campaign be re-opened, but only as a draft', () => {
    // Sending the same campaign again is a real need; skipping the approval gate to do
    // it is not. Draft is the only way back in.
    expect(CAMPAIGN_TRANSITIONS.sent).toEqual(['draft'])
    expect(isTerminal('sent')).toBe(false)
    expect(canReopen('sent')).toBe(true)
  })

  it('offers re-opening only for a campaign that finished', () => {
    // A failed campaign has "Retry failed", which requeues the recipients that failed
    // instead of emailing the whole segment twice.
    expect(canReopen('failed')).toBe(false)
    expect(canReopen('draft')).toBe(false)
    expect(canReopen('sending')).toBe(false)
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
    ['sent', 'approved'],
    ['sending', 'approved'],
  ] as const)('refuses %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false)
  })

  it('stays in step with the database trigger', () => {
    // The trigger is the real enforcement; this table only drives the UI. If they
    // drift, the UI offers actions the database rejects.
    const sql = latestTriggerDefinition()

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
