/**
 * Feature-aware configuration readiness (audit M7).
 *
 * The old preflight checked a fixed list of variables, so a deployment missing the
 * preference-link secret or the cron secret still came back all green while unsubscribe
 * links and scheduled newsletters were broken. Each feature is now one of:
 *
 *   ready          every variable it needs is set to a real value
 *   disabled       named in CRM_DISABLED_FEATURES, i.e. switched off on purpose
 *   misconfigured  enabled but missing something — a readiness FAILURE
 *
 * Pure: takes an env object, returns a verdict, prints nothing. Values are never
 * returned, only variable names, so diagnostics cannot leak a secret.
 */

/** @typedef {{ name: string, validate?: (value: string) => string | null }} Requirement */
/** @typedef {{ id: string, label: string, canDisable: boolean, requires: Requirement[] }} Feature */

const MIN_SECRET_LENGTH = 32

function httpsUrl(value) {
  try {
    const parsed = new URL(value)
    if (parsed.protocol === 'https:') return null
    if (['localhost', '127.0.0.1'].includes(parsed.hostname)) return null
    return 'must be an https:// URL'
  } catch {
    return 'must be an absolute URL'
  }
}

function strongSecret(value) {
  return value.length >= MIN_SECRET_LENGTH ? null : `must be at least ${MIN_SECRET_LENGTH} characters`
}

function aes256Key(value) {
  try {
    return Buffer.from(value, 'base64').length === 32 ? null : 'must be 32 bytes, base64-encoded'
  } catch {
    return 'must be 32 bytes, base64-encoded'
  }
}

function positiveInteger(value) {
  return /^[1-9]\d{0,3}$/.test(value) ? null : 'must be a positive integer'
}

function emailList(value) {
  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean)
  return entries.length > 0 && entries.every((entry) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry))
    ? null
    : 'must be a comma-separated list of email addresses'
}

/** @type {Feature[]} */
export const FEATURES = [
  {
    id: 'core',
    label: 'CRM database and application origin',
    canDisable: false,
    requires: [
      { name: 'NEXT_PUBLIC_SUPABASE_URL', validate: httpsUrl },
      { name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY' },
      { name: 'SUPABASE_SERVICE_ROLE_KEY' },
      { name: 'NEXT_PUBLIC_APP_URL', validate: httpsUrl },
    ],
  },
  {
    // Every marketing email carries the signed preference link; without the secret the
    // link cannot be built and consent withdrawal breaks. Not optional while email is.
    id: 'email-consent',
    label: 'Preference links and consent webhooks',
    canDisable: false,
    requires: [
      { name: 'PREFERENCES_SECRET', validate: strongSecret },
      { name: 'EMAILOCTOPUS_WEBHOOK_SECRET' },
    ],
  },
  {
    id: 'booking',
    label: 'Paid consultation booking (Stripe)',
    canDisable: true,
    requires: [
      { name: 'STRIPE_SECRET_KEY' },
      { name: 'STRIPE_CONSULTATION_PRICE_ID' },
      { name: 'STRIPE_CONSULTATION_COUPON_ID' },
      { name: 'STRIPE_WEBHOOK_SECRET' },
    ],
  },
  {
    id: 'calendly',
    label: 'Consultation scheduling (Calendly)',
    canDisable: true,
    requires: [
      { name: 'CALENDLY_WEBHOOK_SECRET' },
      { name: 'NEXT_PUBLIC_CALENDLY_SCHEDULING_URL', validate: httpsUrl },
    ],
  },
  {
    id: 'booking-email',
    label: 'Booking confirmation email (Resend)',
    canDisable: true,
    requires: [{ name: 'RESEND_API_KEY' }, { name: 'BOOKING_EMAIL_FROM' }],
  },
  {
    id: 'newsletter-schedules',
    label: 'Recurring newsletter drafts (cron)',
    canDisable: true,
    requires: [{ name: 'CRON_SECRET', validate: strongSecret }],
  },
  {
    id: 'review-notifications',
    label: 'Campaign review notices',
    canDisable: true,
    requires: [{ name: 'CAMPAIGN_REVIEW_EMAILS', validate: emailList }, { name: 'RESEND_API_KEY' }],
  },
  {
    id: 'ai-copy',
    label: 'AI campaign copy (Anthropic)',
    canDisable: true,
    requires: [{ name: 'ANTHROPIC_API_KEY' }],
  },
  {
    id: 'location-autocomplete',
    label: 'Address autocomplete (Geoapify)',
    canDisable: true,
    requires: [{ name: 'GEOAPIFY_API_KEY' }],
  },
  {
    // docs/CONTENT_STUDIO_CONTRACTS.md §5. The worker secret signs the engine protocol;
    // the encryption key protects stored social tokens.
    id: 'content-studio',
    label: 'Content Studio (content engine worker)',
    canDisable: true,
    requires: [
      { name: 'CONTENT_WORKER_SECRET', validate: strongSecret },
      { name: 'CONTENT_ENGINE_SECRET', validate: strongSecret },
      { name: 'CONTENT_TOKEN_ENCRYPTION_KEY', validate: aes256Key },
      { name: 'CONTENT_TOKEN_ENCRYPTION_KEY_VERSION', validate: positiveInteger },
      { name: 'CONTENT_ENGINE_URL', validate: httpsUrl },
    ],
  },
]

export function parseDisabled(env) {
  return new Set(
    (env.CRM_DISABLED_FEATURES ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  )
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {Record<string, string>} examples  values from .env.local.example, treated as unset
 */
export function assessFeatures(env, examples = {}) {
  const disabled = parseDisabled(env)
  const known = new Set(FEATURES.map((feature) => feature.id))
  const unknownDisabled = [...disabled].filter((id) => !known.has(id))

  const features = FEATURES.map((feature) => {
    const problems = []

    for (const requirement of feature.requires) {
      const value = env[requirement.name]?.trim() ?? ''
      if (!value || value === examples[requirement.name]) {
        problems.push(`${requirement.name} is missing`)
        continue
      }
      const invalid = requirement.validate?.(value)
      if (invalid) problems.push(`${requirement.name} ${invalid}`)
    }

    if (disabled.has(feature.id)) {
      if (!feature.canDisable) {
        return { id: feature.id, label: feature.label, state: 'misconfigured', problems: ['this feature cannot be disabled', ...problems] }
      }
      return { id: feature.id, label: feature.label, state: 'disabled', problems: [] }
    }

    return {
      id: feature.id,
      label: feature.label,
      state: problems.length === 0 ? 'ready' : 'misconfigured',
      problems,
    }
  })

  return {
    features,
    unknownDisabled,
    ok: unknownDisabled.length === 0 && features.every((feature) => feature.state !== 'misconfigured'),
  }
}
