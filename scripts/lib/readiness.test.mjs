import assert from 'node:assert/strict'
import { test } from 'node:test'

import { assessFeatures } from './readiness.mjs'

const SECRET = 'x'.repeat(40)

const COMPLETE = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  NEXT_PUBLIC_APP_URL: 'https://crm.example.com',
  PREFERENCES_SECRET: SECRET,
  EMAILOCTOPUS_WEBHOOK_SECRET: 'eo-webhook',
  STRIPE_SECRET_KEY: 'sk_test',
  STRIPE_CONSULTATION_PRICE_ID: 'price_1',
  STRIPE_CONSULTATION_COUPON_ID: 'coupon',
  STRIPE_WEBHOOK_SECRET: 'whsec',
  CALENDLY_WEBHOOK_SECRET: 'cal',
  NEXT_PUBLIC_CALENDLY_SCHEDULING_URL: 'https://calendly.com/x/30min',
  RESEND_API_KEY: 're_1',
  BOOKING_EMAIL_FROM: 'Ai4L <b@example.com>',
  CRON_SECRET: SECRET,
  CAMPAIGN_REVIEW_EMAILS: 'a@example.com, b@example.com',
  ANTHROPIC_API_KEY: 'sk-ant',
  GEOAPIFY_API_KEY: 'geo',
  CONTENT_WORKER_SECRET: SECRET,
  CONTENT_ENGINE_SECRET: 'y'.repeat(40),
  CONTENT_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  CONTENT_TOKEN_ENCRYPTION_KEY_VERSION: '1',
  CONTENT_ENGINE_URL: 'https://engine.example.com',
}

function stateOf(result, id) {
  return result.features.find((feature) => feature.id === id).state
}

test('a fully configured environment is ready', () => {
  const result = assessFeatures(COMPLETE)
  assert.equal(result.ok, true)
  assert.ok(result.features.every((feature) => feature.state === 'ready'))
})

test('regression: a missing preference secret fails readiness (was all green)', () => {
  const { PREFERENCES_SECRET: _omit, ...env } = COMPLETE
  const result = assessFeatures(env)
  assert.equal(result.ok, false)
  assert.equal(stateOf(result, 'email-consent'), 'misconfigured')
})

test('regression: a missing cron secret fails the enabled schedules feature', () => {
  const { CRON_SECRET: _omit, ...env } = COMPLETE
  const result = assessFeatures(env)
  assert.equal(result.ok, false)
  assert.equal(stateOf(result, 'newsletter-schedules'), 'misconfigured')
})

test('an intentionally disabled feature passes and is reported as disabled', () => {
  const { CRON_SECRET: _omit, ...env } = COMPLETE
  const result = assessFeatures({ ...env, CRM_DISABLED_FEATURES: 'newsletter-schedules' })
  assert.equal(result.ok, true)
  assert.equal(stateOf(result, 'newsletter-schedules'), 'disabled')
})

test('content studio rejects an encryption key that is not 32 bytes', () => {
  const result = assessFeatures({ ...COMPLETE, CONTENT_TOKEN_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') })
  assert.equal(result.ok, false)
  assert.equal(stateOf(result, 'content-studio'), 'misconfigured')
})

test('content studio rejects a weak worker secret and a bad key version', () => {
  assert.equal(stateOf(assessFeatures({ ...COMPLETE, CONTENT_WORKER_SECRET: 'short' }), 'content-studio'), 'misconfigured')
  assert.equal(
    stateOf(assessFeatures({ ...COMPLETE, CONTENT_TOKEN_ENCRYPTION_KEY_VERSION: '0' }), 'content-studio'),
    'misconfigured',
  )
})

test('content studio can be disabled', () => {
  const { CONTENT_WORKER_SECRET: _omit, ...env } = COMPLETE
  const result = assessFeatures({ ...env, CRM_DISABLED_FEATURES: 'content-studio' })
  assert.equal(result.ok, true)
  assert.equal(stateOf(result, 'content-studio'), 'disabled')
})

test('core and consent cannot be disabled', () => {
  const result = assessFeatures({ ...COMPLETE, CRM_DISABLED_FEATURES: 'email-consent' })
  assert.equal(result.ok, false)
  assert.equal(stateOf(result, 'email-consent'), 'misconfigured')
})

test('an unknown feature name in the disable list fails rather than being ignored', () => {
  const result = assessFeatures({ ...COMPLETE, CRM_DISABLED_FEATURES: 'newsleter-schedules' })
  assert.equal(result.ok, false)
  assert.deepEqual(result.unknownDisabled, ['newsleter-schedules'])
})

test('example placeholder values count as missing', () => {
  const result = assessFeatures(
    { ...COMPLETE, STRIPE_SECRET_KEY: 'sk_test_your-stripe-secret-key' },
    { STRIPE_SECRET_KEY: 'sk_test_your-stripe-secret-key' }
  )
  assert.equal(stateOf(result, 'booking'), 'misconfigured')
})

test('weak secrets and non-https origins are misconfigured', () => {
  const result = assessFeatures({ ...COMPLETE, PREFERENCES_SECRET: 'short', NEXT_PUBLIC_APP_URL: 'http://crm.example.com' })
  assert.equal(stateOf(result, 'email-consent'), 'misconfigured')
  assert.equal(stateOf(result, 'core'), 'misconfigured')
})

test('diagnostics name variables but never contain their values', () => {
  const result = assessFeatures({ ...COMPLETE, PREFERENCES_SECRET: 'tooshort-secret-value' })
  const text = JSON.stringify(result)
  assert.ok(text.includes('PREFERENCES_SECRET'))
  assert.ok(!text.includes('tooshort-secret-value'))
})
