/* Post-deploy verification: prove a running host is safe to point real traffic at.

Usage:
  npm run verify:deployment                          # http://127.0.0.1:3000
  npm run verify:deployment https://crm.example.com  # a real deployment

Exits non-zero on the first failed check, so it can gate a release.

Why this exists alongside the E2E suite
---------------------------------------
The E2E specs run against `next start` on localhost. They prove the application is
correct; they cannot prove the *deployment* is. These are the failures that only appear
once there is a real host in front of the app:

  * TLS terminates but HSTS never reaches the browser, because the platform strips or
    overrides response headers set in next.config.
  * A protected route answers 200 to an anonymous request because the proxy did not run
    -- the single failure mode that turns a private CRM into a public one.
  * A webhook endpoint answers 200 to an unsigned POST, so anyone who learns the URL can
    unsubscribe contacts or mark bookings paid.
  * A server-only secret is readable in a client bundle. There is a structural unit test
    for this, but it inspects source; this inspects what the deployment actually serves.

None of these are hypothetical: each one is silent, and each one looks healthy from the
dashboard.
*/

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const DEFAULT_TARGET = 'http://127.0.0.1:3000';

/** Set by next.config.ts. HSTS is checked separately: it is inert over plain HTTP. */
const REQUIRED_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

/** Signature-authenticated. An unsigned POST must be refused, never processed. */
const WEBHOOK_PATHS = [
  '/api/integrations/emailoctopus/webhook',
  '/api/stripe/webhook',
  '/api/calendly/webhook',
];

/** Session-authenticated. An anonymous request must never receive data. */
const PROTECTED_API_PATHS = ['/api/contacts', '/api/campaigns', '/api/segments'];

/**
 * Values that must never appear in anything the browser downloads.
 *
 * Read from the environment rather than hardcoded, and skipped when absent, so this can
 * run in CI without secrets. Each is checked against the real deployed bundles.
 */
const SECRET_ENV_VARS = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'ANTHROPIC_API_KEY',
  'STRIPE_SECRET_KEY',
  'EMAILOCTOPUS_WEBHOOK_SECRET',
  'STRIPE_WEBHOOK_SECRET',
  'CALENDLY_WEBHOOK_SECRET',
];

function collectJsFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectJsFiles(full, acc);
    else if (entry.endsWith('.js')) acc.push(full);
  }
  return acc;
}

const results = [];
let failed = 0;

function record(ok, name, detail) {
  results.push({ ok, name, detail });
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

function check(name, condition, detail) {
  record(Boolean(condition), name, detail);
}

async function get(target, path, init) {
  return fetch(new URL(path, target), { redirect: 'manual', ...init });
}

async function checkReachable(target) {
  try {
    const response = await get(target, '/login');
    check('host is reachable', response.status < 500, `GET /login -> ${response.status}`);
    return response;
  } catch (error) {
    record(false, 'host is reachable', error.message);
    return null;
  }
}

function checkHeaders(target, response) {
  const isHttps = new URL(target).protocol === 'https:';

  for (const [header, expected] of Object.entries(REQUIRED_HEADERS)) {
    const actual = response.headers.get(header);
    check(`header ${header}`, actual === expected, `expected ${expected}, got ${actual ?? 'nothing'}`);
  }

  const permissions = response.headers.get('permissions-policy') ?? '';
  check('header permissions-policy', permissions.includes('camera=()'), permissions || 'not set');

  // Private workspace: keep every route out of search indexes even if a URL leaks.
  const robotsTag = response.headers.get('x-robots-tag') ?? '';
  check('header x-robots-tag', robotsTag.includes('noindex'), robotsTag || 'not set');

  if (isHttps) {
    const hsts = response.headers.get('strict-transport-security') ?? '';
    check('header strict-transport-security', hsts.includes('max-age='), hsts || 'not set');
  } else {
    record(true, 'header strict-transport-security', 'skipped — inert over plain HTTP');
  }
}

async function checkAnonymousIsLockedOut(target) {
  const dashboard = await get(target, '/');
  const location = dashboard.headers.get('location') ?? '';

  check(
    'anonymous GET / is redirected to sign in',
    [302, 303, 307, 308].includes(dashboard.status) && location.includes('/login'),
    `${dashboard.status} -> ${location || 'no Location header'}`,
  );

  // A redirect can carry a refreshed Set-Cookie; a shared CDN cache must never hand one
  // user's session to another.
  const cacheControl = dashboard.headers.get('cache-control') ?? '';
  check(
    'the sign-in redirect is not cacheable',
    cacheControl.includes('no-store'),
    cacheControl || 'not set',
  );

  for (const path of PROTECTED_API_PATHS) {
    const response = await get(target, path);
    check(
      `anonymous GET ${path} is refused`,
      response.status === 401,
      `expected 401, got ${response.status}`,
    );
  }
}

async function checkWebhooksRefuseUnsigned(target) {
  for (const path of WEBHOOK_PATHS) {
    let response;

    try {
      response = await get(target, path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ type: 'verification.probe' }]),
      });
    } catch (error) {
      record(false, `unsigned POST ${path} is refused`, error.message);
      continue;
    }

    // 401 is the intended answer. A 5xx would also refuse the request, but it means the
    // handler crashed before verifying rather than rejecting deliberately, and a
    // provider treats it as retryable.
    check(
      `unsigned POST ${path} is refused`,
      response.status === 401,
      `expected 401, got ${response.status}`,
    );
  }
}

async function checkRobots(target) {
  const response = await get(target, '/robots.txt');
  const body = response.ok ? await response.text() : '';

  check(
    'robots.txt disallows crawling',
    response.ok && /disallow:\s*\//i.test(body),
    response.ok ? body.trim().split('\n').join(' | ') : `GET -> ${response.status}`,
  );
}

/**
 * Server secrets, checked against what is actually shipped.
 *
 * Two sweeps, because neither alone is sufficient:
 *
 *  - The build output in `.next/static` is the complete set of code the browser can be
 *    served, and it is what gets uploaded. This is the sweep that can prove absence.
 *  - The reachable bundles on the host prove that *this deployment* serves what this
 *    build produced, rather than an older one.
 *
 * The first version of this check scanned only the scripts referenced by /login and
 * reported a confident pass. It was worthless: the sign-in page never instantiates the
 * browser Supabase client, so the chunk carrying the public configuration -- one of
 * thirteen -- was not among the eight it looked at. A sweep that finds nothing because
 * it looked nowhere reads exactly like a sweep that found nothing because there is
 * nothing there. Hence `assertSweepIsMeaningful` below, and the same guard that
 * src/lib/supabase/secrets.test.ts already applies to its own source scan.
 */
async function checkNoSecretsInBundles(target) {
  const present = SECRET_ENV_VARS.map((name) => [name, (process.env[name] || '').trim()])
    .filter(([, value]) => value.length >= 12);

  if (present.length === 0) {
    record(true, 'no server secret is shipped to the browser', 'skipped — no secrets in this environment');
    return;
  }

  const leaked = new Set();
  const scanned = { buildFiles: 0, remoteScripts: 0, bytes: 0 };

  const scan = (label, body) => {
    scanned.bytes += body.length;
    for (const [name, value] of present) {
      if (body.includes(value)) leaked.add(`${name} in ${label}`);
    }
  };

  // Sweep 1: the build output, if this is running where the app was built.
  const staticRoot = join(process.cwd(), '.next', 'static');

  if (existsSync(staticRoot)) {
    for (const file of collectJsFiles(staticRoot)) {
      scan(relative(process.cwd(), file), readFileSync(file, 'utf8'));
      scanned.buildFiles += 1;
    }
  }

  // Sweep 2: what the host actually serves to an anonymous visitor.
  const page = await get(target, '/login');
  const html = await page.text();
  scan('the /login HTML', html);

  for (const src of [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1])) {
    try {
      const response = await get(target, src);
      if (!response.ok) continue;
      scan(src, await response.text());
      scanned.remoteScripts += 1;
    } catch {
      // A chunk that cannot be fetched is not evidence either way; sweep 1 covers it.
    }
  }

  const coverage = scanned.buildFiles
    ? `${scanned.buildFiles} built chunks + ${scanned.remoteScripts} served scripts`
    : `${scanned.remoteScripts} served scripts only (no local build to compare against)`;

  // A sweep that read nothing must not report a pass.
  if (scanned.bytes < 1000) {
    record(false, 'no server secret is shipped to the browser', `sweep found almost nothing (${scanned.bytes} bytes) — the check cannot be trusted`);
    return;
  }

  check(
    'no server secret is shipped to the browser',
    leaked.size === 0,
    leaked.size ? [...leaked].join(', ') : `${present.length} secrets, ${coverage}`,
  );

  // Without a local build the sweep cannot prove absence, only that nothing leaked into
  // the handful of chunks the sign-in page happens to pull.
  if (!scanned.buildFiles) {
    record(true, 'secret sweep coverage', 'partial — run from the build directory for a complete sweep');
  }
}

async function main() {
  const target = (process.argv[2] || DEFAULT_TARGET).replace(/\/$/, '');

  console.log(`Verifying ${target}\n`);

  const login = await checkReachable(target);

  if (!login) {
    console.log('\nUnreachable. Nothing else can be checked.');
    process.exit(1);
  }

  checkHeaders(target, login);
  await checkAnonymousIsLockedOut(target);
  await checkWebhooksRefuseUnsigned(target);
  await checkRobots(target);
  await checkNoSecretsInBundles(target);

  const passed = results.length - failed;
  console.log(`\n${passed}/${results.length} checks passed.`);

  if (failed > 0) {
    console.log('This deployment is not safe to point real traffic at.');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
