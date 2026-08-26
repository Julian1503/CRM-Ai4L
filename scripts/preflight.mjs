/* Release preflight. Configuration checks are local; --online also verifies the live
database and provider resources without creating contacts, bookings, or charges. */

import { readFileSync } from 'node:fs';

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

function configured(name) {
  const value = process.env[name]?.trim() ?? '';
  const ok = value !== '' && value !== examples[name];
  record(ok, name, ok ? 'configured' : 'missing or still using the example value');
  return ok ? value : null;
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
  ];

  for (const table of requiredTables) {
    const { error } = await db.from(table).select('*', { head: true, count: 'exact' }).limit(1);
    record(!error, `database table ${table}`, error?.message ?? 'available');
  }

  const { error } = await db.rpc('get_operations_summary');
  record(!error, 'database operations aggregate', error?.message ?? 'available');
  return db;
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

async function main() {
  console.log(`CRM release preflight${online ? ' (online)' : ''}\n`);

  const supabaseUrl = configured('NEXT_PUBLIC_SUPABASE_URL');
  configured('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  const serviceRoleKey = configured('SUPABASE_SERVICE_ROLE_KEY');
  const appUrl = validUrl('NEXT_PUBLIC_APP_URL', configured('NEXT_PUBLIC_APP_URL'), { https: true });
  configured('EMAILOCTOPUS_WEBHOOK_SECRET');
  const stripeSecret = configured('STRIPE_SECRET_KEY');
  const stripePrice = configured('STRIPE_CONSULTATION_PRICE_ID');
  const stripeCoupon = configured('STRIPE_CONSULTATION_COUPON_ID');
  configured('STRIPE_WEBHOOK_SECRET');
  configured('CALENDLY_WEBHOOK_SECRET');
  const calendlyUrl = validUrl(
    'NEXT_PUBLIC_CALENDLY_SCHEDULING_URL',
    configured('NEXT_PUBLIC_CALENDLY_SCHEDULING_URL'),
    { https: true },
  );

  if (targetArg) await checkTarget(targetArg, appUrl);

  if (online && supabaseUrl && serviceRoleKey) {
    const db = await checkDatabase(supabaseUrl, serviceRoleKey);
    await checkEmailOctopus(db);
  }
  if (online && stripeSecret && stripePrice && stripeCoupon) {
    await checkStripe(stripeSecret, stripePrice, stripeCoupon);
  }
  if (online && calendlyUrl) await checkCalendly(calendlyUrl);

  console.log(`\n${results.length - failures}/${results.length} checks passed.`);
  if (!online) console.log('Run with --online to verify the database and provider resources.');
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
