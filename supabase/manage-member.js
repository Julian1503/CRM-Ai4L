/* Grant, change or disable CRM membership (audit C1).

A Supabase account on its own grants nothing: the CRM also requires an active row in
public.crm_members. This script is the controlled provisioning path, and the only way to
bootstrap the first administrator before 20261002000000_crm_membership.sql is applied.

Usage (reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env.local):
  npm run db:member -- list
  npm run db:member -- grant   <email> <admin|operator>
  npm run db:member -- disable <email>

The account must already exist (invite it from the Supabase dashboard first). Disabling
takes effect on the next request: the server and every RLS policy re-check membership
each time, so an existing session stops working without being revoked.
*/

const ROLES = ['admin', 'operator'];

function config() {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) {
    console.error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(1);
  }
  return {
    url,
    headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
  };
}

async function request(cfg, path, init = {}) {
  const response = await fetch(`${cfg.url}${path}`, { ...init, headers: { ...cfg.headers, ...init.headers } });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${init.method || 'GET'} ${path} failed (${response.status}): ${text}`);
  }
  return body;
}

async function findUserByEmail(cfg, email) {
  const wanted = email.trim().toLowerCase();
  for (let page = 1; page < 100; page += 1) {
    const body = await request(cfg, `/auth/v1/admin/users?page=${page}&per_page=200`);
    const users = body.users || [];
    const match = users.find((user) => (user.email || '').toLowerCase() === wanted);
    if (match) return match;
    if (users.length < 200) return null;
  }
  return null;
}

async function list(cfg) {
  const members = await request(cfg, '/rest/v1/crm_members?select=user_id,role,active,updated_at&order=role');
  const body = await request(cfg, '/auth/v1/admin/users?page=1&per_page=1000');
  const emails = new Map((body.users || []).map((user) => [user.id, user.email]));
  for (const member of members) {
    console.log(`${member.active ? 'active  ' : 'disabled'} ${member.role.padEnd(8)} ${emails.get(member.user_id) || member.user_id}`);
  }
  const unapproved = (body.users || []).filter((user) => !members.some((m) => m.user_id === user.id));
  if (unapproved.length > 0) {
    console.log(`\n${unapproved.length} auth account(s) without membership (no CRM access):`);
    for (const user of unapproved) console.log(`  ${user.email}`);
  }
}

async function grant(cfg, email, role) {
  if (!ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}`);
  const user = await findUserByEmail(cfg, email);
  if (!user) throw new Error(`No auth account for ${email}. Invite it from the Supabase dashboard first.`);
  await request(cfg, '/rest/v1/crm_members?on_conflict=user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ user_id: user.id, role, active: true }),
  });
  console.log(`${email} is now an active ${role}.`);
}

async function disable(cfg, email) {
  const user = await findUserByEmail(cfg, email);
  if (!user) throw new Error(`No auth account for ${email}.`);
  await request(cfg, `/rest/v1/crm_members?user_id=eq.${user.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ active: false }),
  });
  console.log(`${email} is disabled. Their next request is refused.`);
}

async function main() {
  const [command, email, role] = process.argv.slice(2);
  const cfg = config();
  if (command === 'list') return list(cfg);
  if (command === 'grant' && email && role) return grant(cfg, email, role);
  if (command === 'disable' && email) return disable(cfg, email);
  console.error('Usage: npm run db:member -- list | grant <email> <admin|operator> | disable <email>');
  process.exit(1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
