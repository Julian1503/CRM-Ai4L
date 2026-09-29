/* Create a Supabase admin user and a linked contact record.

Usage: set the following env vars and run `node supabase/create-admin.js`:
  NEXT_PUBLIC_SUPABASE_URL (e.g. https://xyz.supabase.co)
  SUPABASE_SERVICE_ROLE_KEY (service_role key; keep secret)
  ADMIN_EMAIL
  ADMIN_PASSWORD

This script does NOT commit any secrets. It expects the service role key to be provided at runtime.
*/

async function main() {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
  const serviceRole = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const email = (process.env.ADMIN_EMAIL || '').trim();
  const password = (process.env.ADMIN_PASSWORD || '').trim();

  if (!url || !serviceRole || !email || !password) {
    console.error('Missing required env vars. Please set NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_EMAIL and ADMIN_PASSWORD');
    process.exit(1);
  }

  const headers = {
    'Content-Type': 'application/json',
    apikey: serviceRole,
    Authorization: `Bearer ${serviceRole}`,
  };

  try {
    // 1) Create the auth user via Supabase Admin REST API
    const createUserResp = await fetch(`${url.replace(/\/+$/,'')}/auth/v1/admin/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: { role: 'admin' }
      }),
    });

    const created = await createUserResp.json();

    if (!createUserResp.ok) {
      console.error('Failed to create auth user:', created);
      process.exit(1);
    }

    const userId = created.id || created.user?.id;
    if (!userId) {
      console.error('Created user response did not contain an id:', created);
      process.exit(1);
    }

    console.log(`Auth user created: ${email} (id: ${userId})`);

    // 1b) Approve the account. Without a crm_members row it can sign in to nothing
    // (20261002000000_crm_membership.sql).
    const memberResp = await fetch(`${url.replace(/\/+$/,'')}/rest/v1/crm_members?on_conflict=user_id`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: userId, role: 'admin', active: true }),
    });
    if (!memberResp.ok) {
      console.error('Failed to grant admin membership:', await memberResp.text());
      process.exit(1);
    }
    console.log('Granted active admin membership.');

    // 2) Insert a contact row linked to that user (optional)
    const contactBody = {
      id: userId,
      first_name: 'Admin',
      last_name: 'User',
      email,
      created_at: new Date().toISOString()
    };

    const insertResp = await fetch(`${url.replace(/\/+$/,'')}/rest/v1/contacts`, {
      method: 'POST',
      headers: {
        ...headers,
        Prefer: 'return=representation'
      },
      body: JSON.stringify(contactBody),
    });

    const inserted = await insertResp.json();
    if (!insertResp.ok) {
      console.error('Warning: failed to insert contact record (may already exist):', inserted);
    } else {
      console.log('Contact created in public.contacts:', inserted);
    }

    console.log('Done. Do NOT commit the SUPABASE_SERVICE_ROLE_KEY to the repository.');
  } catch (err) {
    console.error('Unexpected error:', err);
    process.exit(1);
  }
}

// Node 18+ provides global fetch. If not available, advise the user to run under Node 18+.
if (typeof fetch === 'undefined') {
  console.error('Global fetch is not available. Run this script with Node 18+ or provide a fetch polyfill.');
  process.exit(1);
} else {
  main();
}
