import type { Config } from 'jest'
import nextJest from 'next/jest.js'

const createJestConfig = nextJest({
  dir: './',
})

const config: Config = {
  coverageProvider: 'v8',
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  // Jest's 5s default is too tight for the heavier jsdom suites here: page.test.tsx
  // renders the whole 1,300-line dashboard and waits on several async round trips,
  // which tips over 5s whenever workers are contended (a 2-core CI runner, or a
  // developer machine doing anything else). It passed in isolation and failed in the
  // full run — a false negative, not a real failure. A genuinely hung test still
  // fails, just later.
  testTimeout: 20000,
  // src/e2e holds Playwright specs; importing @playwright/test under jsdom throws.
  // scripts/ holds node:test suites (npm run test:scripts), not Jest ones.
  testPathIgnorePatterns: ['<rootDir>/node_modules/', '<rootDir>/src/e2e/', '<rootDir>/scripts/'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // `server-only` throws on import outside the react-server condition, which Jest
    // does not set. Map it to a no-op so server modules can be unit tested.
    '^server-only$': '<rootDir>/src/test/server-only-stub.ts',
  },
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.test.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/e2e/**',
    '!src/test/**',
    // Type-only modules have no runtime to cover; counting them as 0% just makes the
    // number meaningless.
    '!src/**/types.ts',
  ],
  // Ratchet, pinned just below the measured baseline so coverage cannot regress.
  //
  // Phase 4.6 is the first point where all four metrics clear the 80% project standard.
  // Branches and functions had lagged since Phase 0; closing them did not require the
  // deferred page.tsx decomposition after all — it required testing the parts that had
  // never been touched at all: /api/contacts and /api/import/parse (both at 0% function
  // coverage despite being on the main path), FilterBar, Sidebar and DashboardStats
  // (no test file), and the address-autocomplete and services halves of ContactDrawer.
  // Baseline at Phase 0: statements 74.52 / branches 56.79 / functions 38.70 / lines 74.52.
  // Baseline at Phase 1: statements 74.09 / branches 64.67 / functions 43.63 / lines 74.09.
  // Baseline at Phase 2: statements 78.20 / branches 70.42 / functions 54.41 / lines 78.20.
  // Baseline at Phase 3: statements 78.65 / branches 74.78 / functions 57.04 / lines 78.65.
  // Baseline at Phase 4: statements 79.78 / branches 75.17 / functions 64.21 / lines 79.78.
  // Baseline at Phase 5: statements 79.77 / branches 76.14 / functions 65.92 / lines 79.77.
  // Baseline at Phase 6: statements 87.38 / branches 79.73 / functions 71.91 / lines 87.38.
  // Baseline at Phase 4.6: statements 91.66 / branches 82.75 / functions 81.03 / lines 91.66.
  coverageThreshold: {
    global: {
      statements: 91,
      branches: 82,
      functions: 80,
      lines: 91,
    },
  },
}

export default createJestConfig(config)
