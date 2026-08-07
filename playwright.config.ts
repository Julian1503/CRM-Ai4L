import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './src/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
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
