/* Push environment variables from .env.local to a Vercel environment.

Usage:
  npm run vercel:env -- preview --dry-run
  npm run vercel:env -- preview
  npm run vercel:env -- production

Requires `vercel login` (or VERCEL_TOKEN in .env.local) and a linked project.

Why a script rather than the dashboard
--------------------------------------
Fifteen variables, four of which are still placeholders and three of which must never be
set on Vercel at all. Doing that by hand is how a deployment ends up with a placeholder
Stripe secret and a confident green checkmark. The manifest below is the same one in
docs/DEPLOYMENT.md, encoded so the two cannot drift.

A placeholder is detected by comparing against .env.local.example rather than by pattern
matching: if a value is identical to the documented example, nobody has filled it in yet.
That stays correct as the example changes, which a "starts with your-" heuristic does not.
*/

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * Variables the deployed application reads.
 *
 * `required` here means the app is broken without it, not that this script refuses to
 * run -- a preview deployment is legitimately missing the payment secrets.
 */
const MANIFEST = [
  { name: 'NEXT_PUBLIC_SUPABASE_URL', required: true },
  { name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', required: true },
  { name: 'SUPABASE_SERVICE_ROLE_KEY', required: true, secret: true },
  { name: 'EMAILOCTOPUS_WEBHOOK_SECRET', secret: true },
  { name: 'STRIPE_SECRET_KEY', secret: true },
  { name: 'STRIPE_CONSULTATION_PRICE_ID', secret: true },
  { name: 'STRIPE_CONSULTATION_COUPON_ID', secret: true },
  { name: 'STRIPE_WEBHOOK_SECRET', secret: true },
  { name: 'CALENDLY_WEBHOOK_SECRET', secret: true },
  { name: 'NEXT_PUBLIC_CALENDLY_SCHEDULING_URL' },
  { name: 'ANTHROPIC_API_KEY', secret: true },
  { name: 'GEOAPIFY_API_KEY', secret: true },
];

/**
 * `NEXT_PUBLIC_APP_URL` is deliberately absent from the manifest above.
 *
 * It is inlined at build time, so it has to be right before the build rather than set
 * alongside everything else, and its correct value differs per environment: on a preview
 * it should stay unset so booking links fall back to the deployment's own origin, and on
 * production it is the customer-facing host. Handled explicitly, with a warning, rather
 * than swept along with the rest.
 */
const BUILD_TIME_ONLY = 'NEXT_PUBLIC_APP_URL';

/** Read by ops scripts or by CI, never by the deployed app. See docs/DEPLOYMENT.md §3. */
const NEVER_ON_VERCEL = {
  EMAILOCTOPUS_API_KEY: 'the app reads this from the `credentials` table, not the environment',
  EMAILOCTOPUS_LIST_ID: 'the app reads this from the `credentials` table, not the environment',
  ADMIN_EMAIL: 'local only, consumed by `npm run db:create-admin`',
  ADMIN_PASSWORD: 'local only, consumed by `npm run db:create-admin`',
  E2E_EMAIL: 'a GitHub Actions secret, for the signed-in E2E specs',
  E2E_PASSWORD: 'a GitHub Actions secret, for the signed-in E2E specs',
  VERCEL_TOKEN: 'credential for this script itself',
};

const ENVIRONMENTS = ['production', 'preview', 'development'];

function parseEnvFile(path) {
  if (!existsSync(path)) return {};

  const values = {};

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    values[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }

  return values;
}

function runVercel(args, input) {
  const token = (process.env.VERCEL_TOKEN || '').trim();
  const full = token ? [...args, '--token', token] : args;

  return spawnSync('npx', ['--yes', 'vercel', ...full], {
    input,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
}

function main() {
  const [environment, ...flags] = process.argv.slice(2);
  const dryRun = flags.includes('--dry-run');

  if (!ENVIRONMENTS.includes(environment)) {
    console.error(`Usage: npm run vercel:env -- <${ENVIRONMENTS.join('|')}> [--dry-run]`);
    process.exit(1);
  }

  const actual = parseEnvFile('.env.local');
  const examples = parseEnvFile('.env.local.example');

  if (Object.keys(actual).length === 0) {
    console.error('No .env.local found, or it is empty. Nothing to push.');
    process.exit(1);
  }

  const toPush = [];
  const placeholders = [];
  const missing = [];

  for (const entry of MANIFEST) {
    const value = (actual[entry.name] || '').trim();

    if (!value) {
      missing.push(entry);
      continue;
    }

    // Identical to the documented example means nobody has filled it in.
    if (examples[entry.name] && value === examples[entry.name]) {
      placeholders.push(entry);
      continue;
    }

    toPush.push({ ...entry, value });
  }

  console.log(`Target: ${environment}${dryRun ? ' (dry run)' : ''}\n`);

  console.log(`Will set ${toPush.length}:`);
  for (const entry of toPush) {
    // Never print a secret. The length is enough to spot a truncated paste.
    const shown = entry.secret ? `<${entry.value.length} chars>` : entry.value;
    console.log(`  ${entry.name} = ${shown}`);
  }

  if (placeholders.length) {
    console.log(`\nSkipped — still the placeholder from .env.local.example (${placeholders.length}):`);
    for (const entry of placeholders) console.log(`  ${entry.name}`);
  }

  if (missing.length) {
    console.log(`\nSkipped — absent from .env.local (${missing.length}):`);
    for (const entry of missing) console.log(`  ${entry.name}`);
  }

  const brokenWithout = [...placeholders, ...missing].filter((entry) => entry.required);

  if (brokenWithout.length) {
    console.log('\nThe application cannot start without these:');
    for (const entry of brokenWithout) console.log(`  ${entry.name}`);
  }

  console.log(`\n${BUILD_TIME_ONLY} is not pushed by this script.`);
  console.log(
    environment === 'production'
      ? '  Production: set it to the customer-facing host and REDEPLOY. It is inlined at\n' +
        '  build time, so setting it without rebuilding has no effect, and booking links\n' +
        '  minted with the wrong value go out inside emails and cannot be recalled.'
      : '  Preview: leave it unset so booking links fall back to the deployment origin.\n' +
        '  Do not approve a real campaign send from a preview deployment.',
  );

  const present = Object.keys(NEVER_ON_VERCEL).filter((name) => actual[name]);

  if (present.length) {
    console.log(`\nDeliberately not pushed (${present.length}):`);
    for (const name of present) console.log(`  ${name} — ${NEVER_ON_VERCEL[name]}`);
  }

  if (dryRun) {
    console.log('\nDry run: nothing was sent to Vercel.');
    return;
  }

  console.log('');
  let added = 0;

  for (const entry of toPush) {
    // `vercel env add` reads the value from stdin, which keeps it out of the process
    // list and out of the shell history.
    const result = runVercel(['env', 'add', entry.name, environment, '--force'], `${entry.value}\n`);
    const output = `${result.stdout || ''}${result.stderr || ''}`;

    if (result.status === 0) {
      console.log(`  set  ${entry.name}`);
      added += 1;
    } else {
      console.log(`  FAIL ${entry.name} — ${output.trim().split('\n').pop()}`);
    }
  }

  console.log(`\n${added}/${toPush.length} variables set on ${environment}.`);

  if (added < toPush.length) process.exit(1);
}

main();
