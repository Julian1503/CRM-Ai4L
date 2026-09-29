#!/usr/bin/env node
/**
 * Seeds the four identities the browser suites need into a LOCAL Supabase stack (audit T1).
 *
 *   e2e-admin@example.test        approved administrator
 *   e2e-operator@example.test     approved operator (E2E_EMAIL in CI)
 *   e2e-unapproved@example.test   verified account with no membership (self-registered)
 *   e2e-disabled@example.test     membership present but disabled
 *
 * All four share E2E_PASSWORD. Idempotent: existing accounts get their password and
 * membership reset.
 *
 * Refuses any non-local Supabase URL, so it can never create accounts in the business
 * project. Provider operations stay mocked or pointed at provider test modes.
 */

const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim().replace(/\/+$/, '')
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
const password = process.env.E2E_PASSWORD || ''

function fail(message) {
  console.error(`seed-e2e: ${message}`)
  process.exit(1)
}

if (!url || !serviceKey || !password) {
  fail('set NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and E2E_PASSWORD.')
}

const { hostname } = new URL(url)
if (!['127.0.0.1', 'localhost'].includes(hostname)) {
  fail(`refusing to seed test accounts into non-local Supabase at ${hostname}.`)
}

export const E2E_ACCOUNTS = [
  { email: 'e2e-admin@example.test', membership: { role: 'admin', active: true } },
  { email: 'e2e-operator@example.test', membership: { role: 'operator', active: true } },
  { email: 'e2e-unapproved@example.test', membership: null },
  { email: 'e2e-disabled@example.test', membership: { role: 'operator', active: false } },
]

const headers = {
  'Content-Type': 'application/json',
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
}

async function call(path, init = {}) {
  const response = await fetch(`${url}${path}`, { ...init, headers: { ...headers, ...init.headers } })
  const text = await response.text()
  if (!response.ok) throw new Error(`${init.method || 'GET'} ${path}: ${response.status} ${text}`)
  return text ? JSON.parse(text) : null
}

const existing = (await call('/auth/v1/admin/users?page=1&per_page=1000')).users ?? []

for (const account of E2E_ACCOUNTS) {
  let user = existing.find((candidate) => candidate.email === account.email)

  if (user) {
    await call(`/auth/v1/admin/users/${user.id}`, {
      method: 'PUT',
      body: JSON.stringify({ password, email_confirm: true }),
    })
  } else {
    user = await call('/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email: account.email, password, email_confirm: true }),
    })
  }

  if (account.membership) {
    await call('/rest/v1/crm_members?on_conflict=user_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: user.id, ...account.membership }),
    })
  } else {
    await call(`/rest/v1/crm_members?user_id=eq.${user.id}`, { method: 'DELETE' })
  }

  console.log(`seeded ${account.email} (${account.membership ? `${account.membership.role}, ${account.membership.active ? 'active' : 'disabled'}` : 'no membership'})`)
}
