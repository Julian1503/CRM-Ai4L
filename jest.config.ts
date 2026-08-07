import type { Config } from 'jest'
import nextJest from 'next/jest.js'

const createJestConfig = nextJest({
  dir: './',
})

const config: Config = {
  coverageProvider: 'v8',
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  // src/e2e holds Playwright specs; importing @playwright/test under jsdom throws.
  testPathIgnorePatterns: ['<rootDir>/node_modules/', '<rootDir>/src/e2e/'],
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
    '!src/lib/db/types.ts',
  ],
  // Ratchet, not the target. These are pinned just below the measured baseline as of
  // Phase 0 so coverage cannot regress, and are raised as each phase adds tests.
  // Phase 6 lifts them to the 80% project standard, once page.tsx is decomposed and the
  // route handlers are covered — the three things holding the current numbers down.
  // Baseline at Phase 0: statements 74.52 / branches 56.79 / functions 38.70 / lines 74.52.
  // Baseline at Phase 1: statements 74.09 / branches 64.67 / functions 43.63 / lines 74.09.
  // Statements dipped marginally because the login page and form are covered by
  // Playwright rather than Jest; branch and function coverage both rose.
  coverageThreshold: {
    global: {
      statements: 74,
      branches: 64,
      functions: 43,
      lines: 74,
    },
  },
}

export default createJestConfig(config)
