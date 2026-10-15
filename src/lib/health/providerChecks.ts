import { findMissingMergeFields } from '@/lib/marketing/mergeFields'
import { checkStripeReadiness } from '@/lib/stripe/health'

import type { CheckOutcome, HealthDeps } from './deps'

/**
 * Checks of the external services the CRM depends on. Read-only: nothing here sends an
 * email, creates a checkout, starts a generation or writes anywhere.
 */

function missing(names: string[]): CheckOutcome {
  return {
    state: 'not_configured',
    summary: 'Not set up in this deployment.',
    details: [`Missing: ${names.join(', ')}.`],
    actionHint: 'Set these in the deployment environment, then test again.',
  }
}

function unset(env: HealthDeps['env'], names: string[]): string[] {
  return names.filter((name) => !env[name]?.trim())
}

export async function checkEmailOctopus(deps: HealthDeps): Promise<CheckOutcome> {
  const credentials = await deps.loadEmailOctopusCredentials()
  if (!credentials) {
    return {
      state: 'not_configured',
      summary: 'No EmailOctopus API key and list are saved.',
      actionHint: 'Open Settings → Connections → Email marketing and save the API key and list.',
    }
  }

  const result = await deps.listMergeTags({ ...credentials, fetchImpl: deps.fetch })
  if (!result.ok) {
    // The provider's message is not shown: it can echo request details.
    return {
      state: 'down',
      summary: 'EmailOctopus did not accept the saved key and list.',
      actionHint: 'Check the API key and list in Settings → Connections → Email marketing.',
    }
  }

  const absent = findMissingMergeFields(result.tags)
  if (absent.length > 0) {
    return {
      state: 'degraded',
      summary: 'The list is reachable, but it is missing fields the campaign template uses.',
      details: [`Missing fields: ${absent.join(', ')}.`],
      actionHint: 'Create them from Settings → Connections → Email marketing.',
    }
  }
  return { state: 'ok', summary: 'The list is reachable and has every field campaigns use.' }
}

/** Stripe problems without the provider's own error text (it can quote request data). */
function plainProblem(problem: string): string {
  const unreadable = problem.indexOf(' could not be read')
  return unreadable >= 0 ? `${problem.slice(0, unreadable)} could not be read with this key.` : problem
}

export async function checkStripe(deps: HealthDeps): Promise<CheckOutcome> {
  const names = ['STRIPE_SECRET_KEY', 'STRIPE_CONSULTATION_PRICE_ID', 'STRIPE_CONSULTATION_COUPON_ID', 'STRIPE_WEBHOOK_SECRET']
  const absent = unset(deps.env, names)
  if (absent.length > 0) return missing(absent)

  const secretKey = deps.env.STRIPE_SECRET_KEY!.trim()
  const stripe = deps.stripe(secretKey)
  const readiness = await checkStripeReadiness(stripe, {
    secretKey,
    priceId: deps.env.STRIPE_CONSULTATION_PRICE_ID!.trim(),
    couponId: deps.env.STRIPE_CONSULTATION_COUPON_ID!.trim(),
  })

  let chargesEnabled: boolean | null = null
  try {
    chargesEnabled = (await stripe.accounts.retrieveCurrent()).charges_enabled
  } catch {
    chargesEnabled = null
  }

  const details = [`Key mode: ${readiness.mode}.`, ...readiness.problems.map(plainProblem)]
  if (chargesEnabled === false) details.push('The Stripe account cannot take charges yet.')
  if (chargesEnabled === null) details.push('The account status could not be read.')

  if (!readiness.ok || chargesEnabled === false) {
    return {
      state: 'down',
      summary: 'Booking checkout cannot start with this Stripe configuration.',
      details,
      actionHint: 'Fix the items listed in Stripe, then test again.',
    }
  }
  if (readiness.mode !== 'live' || chargesEnabled === null) {
    return { state: 'degraded', summary: readiness.mode === 'live' ? 'Price and coupon are ready.' : 'Stripe is in test mode: bookings do not take real payments.', details }
  }
  return { state: 'ok', summary: 'Live mode: the consultation price and free coupon are ready.', details }
}

const STALE_WEBHOOK_DAYS = 30

export async function checkCalendly(deps: HealthDeps): Promise<CheckOutcome> {
  const absent = unset(deps.env, ['CALENDLY_SCHEDULING_URL', 'CALENDLY_WEBHOOK_SECRET'])
  if (absent.length > 0) return missing(absent)

  const details: string[] = []
  let pageOk = false
  try {
    const page = await deps.fetch(deps.env.CALENDLY_SCHEDULING_URL!.trim(), { method: 'GET', redirect: 'follow' })
    pageOk = page.ok
    if (!page.ok) details.push(`The scheduling page answered HTTP ${page.status}.`)
  } catch {
    details.push('The scheduling page did not answer.')
  }

  const { data, error } = await deps.db
    .from('webhook_events')
    .select('received_at')
    .eq('provider', 'calendly')
    .order('received_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const last = error ? null : (data as { received_at?: string } | null)?.received_at ?? null

  if (error) details.push('The webhook ledger could not be read.')
  else if (last) details.push(`Last webhook received ${last}.`)
  else details.push('No Calendly webhook has ever been received.')

  if (!pageOk) {
    return { state: 'down', summary: 'The booking scheduling page is not reachable.', details, actionHint: 'Check CALENDLY_SCHEDULING_URL.' }
  }
  if (!last) {
    return {
      state: 'degraded',
      summary: 'The scheduling page works, but Calendly has never notified the CRM of a booking.',
      details,
      actionHint: 'Register the webhook in Calendly (docs/DEPLOYMENT.md) and book a test slot.',
    }
  }
  const ageDays = (deps.now().getTime() - new Date(last).getTime()) / 86_400_000
  if (ageDays > STALE_WEBHOOK_DAYS) {
    return { state: 'degraded', summary: `No Calendly webhook in the last ${STALE_WEBHOOK_DAYS} days.`, details, actionHint: 'Confirm the webhook subscription is still active in Calendly.' }
  }
  return { state: 'ok', summary: 'The scheduling page works and webhooks are arriving.', details }
}

/** Configured key, and a free model listing (never a generation). */
export async function checkAi(deps: HealthDeps): Promise<CheckOutcome> {
  const key = deps.env.ANTHROPIC_API_KEY?.trim()
  if (!key) return { ...missing(['ANTHROPIC_API_KEY']), summary: 'AI copy writing is not set up.' }

  try {
    const response = await deps.fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    })
    if (response.ok) return { state: 'ok', summary: 'The API key is accepted.' }
    if (response.status === 401 || response.status === 403) {
      return { state: 'down', summary: 'The Anthropic API key was rejected.', actionHint: 'Replace ANTHROPIC_API_KEY in the deployment environment.' }
    }
    return { state: 'degraded', summary: 'The key is set, but the API did not confirm it.', details: [`HTTP ${response.status}.`] }
  } catch {
    return { state: 'degraded', summary: 'The key is set, but the API could not be reached.' }
  }
}

export async function checkContentEngine(deps: HealthDeps): Promise<CheckOutcome> {
  const url = deps.env.CONTENT_ENGINE_URL?.trim()
  if (!url) return { ...missing(['CONTENT_ENGINE_URL']), summary: 'The Content Studio engine is not set up.' }

  try {
    const response = await deps.fetch(`${url.replace(/\/+$/, '')}/health`)
    if (response.ok) return { state: 'ok', summary: 'The engine is up.' }
    return { state: 'down', summary: 'The engine answered with an error.', details: [`HTTP ${response.status}.`], actionHint: 'Check the engine service on the hosting platform.' }
  } catch {
    return { state: 'down', summary: 'The engine did not answer.', actionHint: 'Check the engine service and CONTENT_ENGINE_URL.' }
  }
}
