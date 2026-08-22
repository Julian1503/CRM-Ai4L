import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './src/e2e',
  fullyParallel: true,
  // 60s rather than the 30s default.
  //
  // Every spec signs in against a remote Supabase project and loads a 5,000-row
  // contact list, and three browser projects share one `next start`. WebKit on Windows
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
  // remote Supabase project, and each signed-in spec performs a real sign-in and loads
  // a 5,000-row contact list. At the default width the server and the auth endpoint
  // starve, and specs fail on a 30s timeout that moves between runs -- a different one
  // each time, which is the signature of contention rather than a defect. Three keeps
  // the browser projects overlapping without queueing behind each other.
  workers: process.env.CI ? 1 : 3,
  reporter: 'html',
  use: {
    baseURL: 'http://127.0.0.1:3000',
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
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
  // Runs against a production build rather than `next dev`, for two reasons:
  // 1. E2E should exercise the artifact that actually ships.
  // 2. `next dev` does not currently hydrate on this machine — the client bundle loads
  //    but React never attaches (no fiber keys on any node), so every interaction is a
  //    no-op. It correlates with a failing HMR WebSocket handshake
  //    (ws://127.0.0.1:3000/_next/webpack-hmr -> ERR_INVALID_HTTP_RESPONSE) and
  //    reproduces on a cleared .next cache. `next build` + `next start` hydrates
  //    correctly, so this is a dev-server/environment issue, not an app defect.
  webServer: {
    command: 'npm run build && npm run start',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
