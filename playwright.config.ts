import { defineConfig, devices } from '@playwright/test';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3100';
const AUTH_STATE_PATH = 'test-results/.auth/user.json';
const SIGN_OUT_TEST = /signs the user out and blocks the dashboard afterwards/;

const baseURL = (process.env.E2E_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, '');
const parsedBaseURL = new URL(baseURL);
const hasCredentials = Boolean(process.env.E2E_EMAIL && process.env.E2E_PASSWORD);
const useExternalServer = process.env.E2E_EXTERNAL_SERVER === 'true';
const reuseExistingServer = process.env.E2E_REUSE_EXISTING_SERVER === 'true';
const skipBuild = process.env.E2E_SKIP_BUILD === 'true';
// Set in CI's integration job: a missing test identity is a broken environment, not a
// reason to skip the signed-in suites and report green (audit T1).
const requireAuth = process.env.E2E_REQUIRE_AUTH === 'true';

if (requireAuth && !hasCredentials) {
  throw new Error('E2E_REQUIRE_AUTH=true but E2E_EMAIL / E2E_PASSWORD are not set.');
}
if (
  requireAuth &&
  !['127.0.0.1', 'localhost'].includes(new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://invalid').hostname)
) {
  // Mutating journeys must never run against a hosted (business) project by accident.
  throw new Error('E2E_REQUIRE_AUTH=true expects the local Supabase test stack.');
}

if (!useExternalServer && !['127.0.0.1', 'localhost'].includes(parsedBaseURL.hostname)) {
  throw new Error('Set E2E_EXTERNAL_SERVER=true when E2E_BASE_URL is not local.');
}

const localPort = parsedBaseURL.port || (parsedBaseURL.protocol === 'https:' ? '443' : '80');
const allBrowserDefinitions = [
  { name: 'chromium', device: devices['Desktop Chrome'] },
  { name: 'firefox', device: devices['Desktop Firefox'] },
  { name: 'webkit', device: devices['Desktop Safari'] },
] as const;
const requestedBrowsers = new Set(
  (process.env.E2E_BROWSERS || allBrowserDefinitions.map(({ name }) => name).join(','))
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
);
const browserDefinitions = allBrowserDefinitions.filter(({ name }) => requestedBrowsers.has(name));

if (browserDefinitions.length !== requestedBrowsers.size || browserDefinitions.length === 0) {
  throw new Error('E2E_BROWSERS must contain one or more of: chromium, firefox, webkit.');
}

const publicProjects = browserDefinitions.map(({ name, device }) => ({
  name: `public-${name}`,
  testMatch: /auth\.spec\.ts/,
  use: { ...device },
}));

const authenticatedProjects = browserDefinitions.map(({ name, device }) => ({
  name: `authenticated-${name}`,
  testMatch: /(smoke|archive|membership)\.spec\.ts/,
  grepInvert: SIGN_OUT_TEST,
  dependencies: hasCredentials ? ['auth-setup'] : [],
  use: {
    ...device,
    ...(hasCredentials ? { storageState: AUTH_STATE_PATH } : {}),
  },
}));

export default defineConfig({
  testDir: './src/e2e',
  fullyParallel: true,
  // 60s rather than the 30s default.
  //
  // Signed-in specs load a 5,000-row contact list, and three browser projects share one
  // `next start`. Authentication itself is performed once by auth.setup.ts. WebKit on Windows
  // is the slowest of the three by a wide margin — a spec that clicks through four
  // workspaces passes in 53s alone and timed out at 30s in the full run. Nothing here
  // is waiting on a defect; it is waiting on real network and a real dataset. A
  // genuinely hung test still fails, just later.
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Capped rather than left to Playwright's default (half the CPU cores).
  //
  // The bottleneck is not CPU: every spec talks to one `next start` process and one
  // remote Supabase project, and each signed-in spec loads a 5,000-row contact list.
  // At the default width the server and the data endpoint
  // starve, and specs fail on a 30s timeout that moves between runs -- a different one
  // each time, which is the signature of contention rather than a defect. Three keeps
  // the browser projects overlapping without queueing behind each other.
  workers: process.env.CI ? 1 : 3,
  reporter: 'html',
  use: {
    baseURL,
    trace: 'on-first-retry',
    // Emulates `prefers-reduced-motion: reduce`.
    //
    // Two reasons. Determinism: five components drive GSAP entrance timelines, and
    // Playwright's actionability check waits for an element to be *stable* — an element
    // still being staggered into place is not, which surfaced as a click timing out on
    // a button that was plainly there. And coverage: src/lib/motion.ts means the app
    // now has a real reduced-motion path, so the E2E suite exercises the one a user
    // with that setting actually gets. The animated path is covered by unit tests.
    contextOptions: { reducedMotion: 'reduce' },
  },
  projects: [
    ...(hasCredentials
      ? [
          {
            name: 'auth-setup',
            testMatch: /auth\.setup\.ts/,
            use: { ...devices['Desktop Chrome'] },
          },
        ]
      : []),
    ...publicProjects,
    ...authenticatedProjects,
    ...(hasCredentials
      ? [
          {
            name: 'authenticated-sign-out',
            testMatch: /(smoke|archive)\.spec\.ts/,
            grep: SIGN_OUT_TEST,
            dependencies: browserDefinitions.map(({ name }) => `authenticated-${name}`),
            use: {
              ...devices['Desktop Chrome'],
              storageState: AUTH_STATE_PATH,
            },
          },
        ]
      : []),
  ],
  // Runs against a production build rather than `next dev`, for two reasons:
  // 1. E2E should exercise the artifact that actually ships.
  // 2. `next dev` does not currently hydrate on this machine — the client bundle loads
  //    but React never attaches (no fiber keys on any node), so every interaction is a
  //    no-op. It correlates with a failing HMR WebSocket handshake
  //    (ws://127.0.0.1:3000/_next/webpack-hmr -> ERR_INVALID_HTTP_RESPONSE) and
  //    reproduces on a cleared .next cache. `next build` + `next start` hydrates
  //    correctly, so this is a dev-server/environment issue, not an app defect.
  webServer: useExternalServer
    ? undefined
    : {
        command: `${skipBuild ? '' : 'npm run build && '}npm run start -- --hostname ${parsedBaseURL.hostname} --port ${localPort}`,
        url: baseURL,
        // Reuse is opt-in: silently adopting a dev server makes interaction tests
        // exercise unhydrated HTML while appearing to target a production build.
        reuseExistingServer,
        timeout: 180_000,
      },
});
