/* Release preflight. Configuration checks are local; --online also verifies the live
database and provider resources without creating contacts, bookings, or charges.

Each feature is ready, intentionally disabled (CRM_DISABLED_FEATURES), or misconfigured;
only the last fails. See scripts/lib/readiness.mjs and docs/DEPLOYMENT.md. */

import { readFileSync } from 'node:fs';

import { assessFeatures } from './lib/readiness.mjs';

import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const args = process.argv.slice(2);
const online = args.includes('--online');
const targetArg = args.find((arg) => !arg.startsWith('--'));
const results = [];
let failures = 0;

function parseEnv(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*([^#][^=]*?)\s*=\s*(.*?)\s*$/))
      .filter(Boolean)
      .map((match) => [match[1].trim(), match[2].replace(/^(['"])(.*)\1$/, '$2')]),
  );
}

const examples = parseEnv(readFileSync('.env.local.example', 'utf8'));

function record(ok, name, detail = '') {
  if (!ok) failures += 1;
  results.push({ ok, name, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` - ${detail}` : ''}`);
}

function warn(name, detail) {
  console.log(` WARN  ${name} - ${detail}`);
}

function validUrl(name, value, { https = false } = {}) {
  if (!value) return null;

  try {
    const parsed = new URL(value);
    const validProtocol = https ? parsed.protocol === 'https:' : ['http:', 'https:'].includes(parsed.protocol);
    record(validProtocol, `${name} format`, validProtocol ? parsed.origin : `unexpected protocol ${parsed.protocol}`);
    return validProtocol ? parsed : null;
  } catch {
    record(false, `${name} format`, 'not an absolute URL');
    return null;
  }
}

async function checkDatabase(url, serviceRoleKey) {
  const db = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const requiredTables = [
    'contacts',
    'webhook_events',
    'segments',
    'campaigns',
    'campaign_templates',
    'bookings',
    'integration_deliveries',
    'content_items',
    'content_jobs',
    'social_accounts',
  ];

  for (const table of requiredTables) {
    // A real read, not HEAD: a HEAD request for a missing table comes back without an
    // error object in supabase-js, which reported unapplied migrations as "available".
    const { error } = await db.from(table).select('*').limit(1);
    record(!error, `database table ${table}`, error?.message ?? 'available');
  }

  const { error } = await db.rpc('get_operations_summary');
  record(!error, 'database operations aggregate', error?.message ?? 'available');

  // Contract, not existence: the columns the app reads through the view (audit M7).
  const view = await db
    .from('active_contacts')
    .select('id,source,removed_at,archive_reason,subscribed_to_newsletter,subscribed_to_programs')
    .limit(1);
  record(!view.error, 'active_contacts view contract', view.error?.message ?? 'columns present');

  // Membership enforcement (audit C1): the function exists and an administrator does.
  const member = await db.rpc('is_crm_member');
  record(!member.error, 'membership enforcement installed', member.error?.message ?? 'is_crm_member() present');
  const admins = await db
    .from('crm_members')
    .select('user_id', { count: 'exact' })
    .eq('role', 'admin')
    .eq('active', true);
  record(
    !admins.error && (admins.count ?? 0) > 0,
    'active CRM administrator',
    admins.error?.message ?? `${admins.count ?? 0} active`,
  );
  return db;
}

async function checkAccessBoundary(url, anonKey) {
  // Invite-only: public signup must be off. /auth/v1/settings is the read-only answer.
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/auth/v1/settings`, {
      headers: { apikey: anonKey },
    });
    const settings = await response.json();
    record(settings.disable_signup === true, 'public signup disabled', `disable_signup=${settings.disable_signup}`);
  } catch (error) {
    record(false, 'public signup disabled', error instanceof Error ? error.message : 'request failed');
  }

  const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  for (const table of ['contacts', 'credentials', 'crm_members', 'social_account_secrets', 'content_items']) {
    const { data, error } = await anon.from(table).select('*').limit(1);
    const denied = Boolean(error) || (data ?? []).length === 0;
    record(denied, `anonymous read of ${table} denied`, error ? 'refused' : `${(data ?? []).length} rows`);
  }
}

async function checkStripe(secretKey, priceId, couponId) {
  const stripe = new Stripe(secretKey);

  try {
    const [account, price, coupon] = await Promise.all([
      stripe.accounts.retrieve(),
      stripe.prices.retrieve(priceId),
      stripe.coupons.retrieve(couponId),
    ]);

    record(
      price.active && price.unit_amount === 50_000 && price.currency.toLowerCase() === 'aud',
      'Stripe consultation price',
      `${price.active ? 'active' : 'inactive'}, ${price.unit_amount ?? 'null'} ${price.currency.toUpperCase()}`,
    );
    record(
      coupon.valid && coupon.percent_off === 100 && coupon.duration === 'once',
      'Stripe promotional coupon',
      `${coupon.percent_off ?? 0}% off, duration ${coupon.duration}, valid ${coupon.valid}`,
    );

    if (!account.charges_enabled) {
      warn('Stripe account charges', 'charges_enabled is false; confirm no-cost Checkout is enabled before launch');
    } else {
      record(true, 'Stripe account charges', 'enabled');
    }
  } catch (error) {
    record(false, 'Stripe resources', error instanceof Error ? error.message : 'request failed');
  }
}

async function checkEmailOctopus(db) {
  const { data, error } = await db
    .from('credentials')
    .select('key,value')
    .in('key', ['emailoctopus_api_key', 'emailoctopus_list_id']);

  if (error) {
    record(false, 'EmailOctopus credentials', error.message);
    return;
  }

  const values = Object.fromEntries((data ?? []).map((row) => [row.key, row.value?.trim()]));
  const apiKey = values.emailoctopus_api_key;
  const listId = values.emailoctopus_list_id;

  if (!apiKey || !listId) {
    record(false, 'EmailOctopus credentials', 'missing from the credentials table');
    return;
  }

  const response = await fetch(
    `https://api.emailoctopus.com/lists/${encodeURIComponent(listId)}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  record(response.ok, 'EmailOctopus list', response.ok ? 'reachable' : `HTTP ${response.status}`);
}

async function checkCalendly(url) {
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'manual' });
    record(response.status < 400, 'Calendly scheduling page', `HTTP ${response.status}`);
  } catch (error) {
    record(false, 'Calendly scheduling page', error instanceof Error ? error.message : 'request failed');
  }
}

async function checkTarget(target, appUrl) {
  const parsed = validUrl('preflight target', target, { https: !/localhost|127\.0\.0\.1/.test(target) });
  if (!parsed) return;

  record(
    !appUrl || parsed.origin === appUrl.origin,
    'NEXT_PUBLIC_APP_URL matches target',
    `${appUrl?.origin ?? 'missing'} vs ${parsed.origin}`,
  );

  try {
    const response = await fetch(new URL('/login', parsed), { redirect: 'manual' });
    record(response.status < 500, 'deployment is reachable', `GET /login -> ${response.status}`);
  } catch (error) {
    record(false, 'deployment is reachable', error instanceof Error ? error.message : 'request failed');
  }
}

function reportFeatures() {
  const readiness = assessFeatures(process.env, examples);

  for (const feature of readiness.features) {
    if (feature.state === 'disabled') {
      console.log(` OFF   ${feature.label} (${feature.id}) - intentionally disabled`);
      continue;
    }
    record(
      feature.state === 'ready',
      `${feature.label} (${feature.id})`,
      feature.state === 'ready' ? 'ready' : feature.problems.join('; '),
    );
  }
  for (const id of readiness.unknownDisabled) {
    record(false, 'CRM_DISABLED_FEATURES', `unknown feature "${id}"`);
  }

  return new Map(readiness.features.map((feature) => [feature.id, feature.state]));
}

async function main() {
  console.log(`CRM release preflight${online ? ' (online)' : ''}\n`);

  const states = reportFeatures();
  const enabled = (id) => states.get(id) === 'ready';
  const env = (name) => process.env[name]?.trim() ?? '';

  const appUrl = enabled('core') ? new URL(env('NEXT_PUBLIC_APP_URL')) : null;
  if (targetArg) await checkTarget(targetArg, appUrl);

  if (online && enabled('core')) {
    await checkAccessBoundary(env('NEXT_PUBLIC_SUPABASE_URL'), env('NEXT_PUBLIC_SUPABASE_ANON_KEY'));
    const db = await checkDatabase(env('NEXT_PUBLIC_SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
    await checkEmailOctopus(db);
  }
  if (online && enabled('booking')) {
    await checkStripe(env('STRIPE_SECRET_KEY'), env('STRIPE_CONSULTATION_PRICE_ID'), env('STRIPE_CONSULTATION_COUPON_ID'));
  }
  if (online && enabled('calendly')) {
    await checkCalendly(new URL(env('NEXT_PUBLIC_CALENDLY_SCHEDULING_URL')));
  }

  console.log(`\n${results.length - failures}/${results.length} checks passed.`);
  if (!online) console.log('Run with --online to verify the database and provider resources.');
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
