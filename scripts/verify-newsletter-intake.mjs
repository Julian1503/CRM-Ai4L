/* End-to-end canary for the newsletter intake contract.

Usage:
  npm run verify:newsletter -- http://127.0.0.1:3100
  npm run verify:newsletter -- https://crm.example.com

The probe creates a unique synthetic subscriber, replays the event to prove idempotency,
unsubscribes it, and removes the contact, sync logs, and webhook ledger fixtures.
*/

import { createHmac, randomUUID } from 'node:crypto';

import { createClient } from '@supabase/supabase-js';

const target = (process.argv[2] || process.env.CANARY_TARGET_URL || '').replace(/\/$/, '');
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const webhookSecret = process.env.EMAILOCTOPUS_WEBHOOK_SECRET?.trim();

function required(name, value) {
  if (!value) throw new Error(`${name} is required for the newsletter canary.`);
  return value;
}

function validateTarget(value) {
  const parsed = new URL(required('target URL argument or CANARY_TARGET_URL', value));
  const local = ['127.0.0.1', 'localhost'].includes(parsed.hostname);

  if (!local && parsed.protocol !== 'https:') {
    throw new Error('A remote newsletter canary target must use HTTPS.');
  }

  return parsed.origin;
}

function sign(body, secret) {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

async function deliver(origin, secret, events) {
  const body = JSON.stringify(events);
  const response = await fetch(new URL('/api/integrations/emailoctopus/webhook', origin), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'EmailOctopus-Signature': sign(body, secret),
    },
    body,
    redirect: 'manual',
  });
  const responseBody = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`Newsletter webhook returned ${response.status}: ${responseBody.error ?? 'unknown error'}`);
  }

  return responseBody;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readContact(db, email) {
  const { data, error } = await db
    .from('contacts')
    .select('id,email,status,source,subscribed_to_newsletter,deleted_at')
    .eq('email', email)
    .maybeSingle();

  if (error) throw new Error(`Could not verify canary contact: ${error.message}`);
  return data;
}

async function cleanup(db, email, eventIds) {
  const failures = [];
  const operations = [
    db.from('sync_logs').delete().ilike('event_text', `%${email}%`),
    db.from('webhook_events').delete().eq('provider', 'emailoctopus').in('event_id', eventIds),
    db.from('contacts').delete().eq('email', email).eq('source', 'newsletter'),
  ];

  for (const operation of operations) {
    const { error } = await operation;
    if (error) failures.push(error.message);
  }

  if (failures.length > 0) {
    throw new Error(`Canary cleanup failed: ${failures.join('; ')}`);
  }
}

async function main() {
  const origin = validateTarget(target);
  const secret = required('EMAILOCTOPUS_WEBHOOK_SECRET', webhookSecret);
  const db = createClient(
    required('NEXT_PUBLIC_SUPABASE_URL', supabaseUrl),
    required('SUPABASE_SERVICE_ROLE_KEY', serviceRoleKey),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const suffix = randomUUID();
  const email = `crm-canary-${suffix}@example.invalid`;
  const subscribedEventId = `canary-subscribe-${suffix}`;
  const unsubscribedEventId = `canary-unsubscribe-${suffix}`;

  console.log(`Running newsletter intake canary against ${origin}`);

  try {
    const subscribed = await deliver(origin, secret, [
      {
        id: subscribedEventId,
        type: 'contact.created',
        contact_email_address: email,
        contact_status: 'subscribed',
        contact_fields: { FirstName: 'CRM', LastName: 'Canary' },
        occurred_at: new Date().toISOString(),
      },
    ]);

    assert(subscribed.created === 1, `Expected one created contact, got ${subscribed.created ?? 0}.`);

    const contact = await readContact(db, email);
    assert(contact, 'The signed signup returned success but created no contact.');
    assert(contact.source === 'newsletter', `Expected newsletter source, got ${contact.source}.`);
    assert(contact.status === 'lead', `Expected lead status, got ${contact.status}.`);
    assert(contact.subscribed_to_newsletter === true, 'The new contact was not subscribed.');
    assert(contact.deleted_at === null, 'The new contact was unexpectedly archived.');
    console.log('  ok   signed signup created an active newsletter lead');

    const replay = await deliver(origin, secret, [
      {
        id: subscribedEventId,
        type: 'contact.created',
        contact_email_address: email,
        contact_status: 'subscribed',
        contact_fields: { FirstName: 'CRM', LastName: 'Canary' },
      },
    ]);
    assert(replay.duplicate === 1, 'Replaying the same provider event was not a no-op.');
    console.log('  ok   repeated delivery was idempotent');

    const unsubscribed = await deliver(origin, secret, [
      {
        id: unsubscribedEventId,
        type: 'contact.unsubscribed',
        contact_email_address: email,
        occurred_at: new Date().toISOString(),
      },
    ]);
    assert(unsubscribed.updated === 1, 'The unsubscribe event did not update the contact.');

    const afterUnsubscribe = await readContact(db, email);
    assert(afterUnsubscribe?.subscribed_to_newsletter === false, 'The contact remained subscribed.');
    console.log('  ok   unsubscribe updated the existing contact');
  } finally {
    await cleanup(db, email, [subscribedEventId, unsubscribedEventId]);
    console.log('  ok   synthetic contact and idempotency fixtures removed');
  }

  console.log('Newsletter intake canary passed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
