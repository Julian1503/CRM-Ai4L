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
    // Type-only modules have no runtime to cover; counting them as 0% just makes the
    // number meaningless.
    '!src/**/types.ts',
  ],
  // Ratchet, pinned just below the measured baseline so coverage cannot regress.
  //
  // Phase 6 brought statements and lines past the 80% project standard. Branches and
  // functions still fall short, and the shortfall is almost entirely src/app/page.tsx
  // (42% function coverage) — the 1,300-line client component whose decomposition was
  // deferred in Phase 2.1 for want of a working database. Raising these further means
  // doing that decomposition, not writing more tests around it.
  // Baseline at Phase 0: statements 74.52 / branches 56.79 / functions 38.70 / lines 74.52.
  // Baseline at Phase 1: statements 74.09 / branches 64.67 / functions 43.63 / lines 74.09.
  // Baseline at Phase 2: statements 78.20 / branches 70.42 / functions 54.41 / lines 78.20.
  // Baseline at Phase 3: statements 78.65 / branches 74.78 / functions 57.04 / lines 78.65.
  // Baseline at Phase 4: statements 79.78 / branches 75.17 / functions 64.21 / lines 79.78.
  // Baseline at Phase 5: statements 79.77 / branches 76.14 / functions 65.92 / lines 79.77.
  // Baseline at Phase 6: statements 87.38 / branches 79.73 / functions 71.91 / lines 87.38.
  coverageThreshold: {
    global: {
      statements: 87,
      branches: 79,
      functions: 71,
      lines: 87,
    },
  },
}

export default createJestConfig(config)
