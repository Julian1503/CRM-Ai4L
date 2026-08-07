// Jest stub for the `server-only` marker package.
//
// The real package throws unless the bundler sets the `react-server` export
// condition, which Jest does not. Mapping it here (see jest.config.ts
// moduleNameMapper) lets server modules be unit tested while the real package
// still guards them in the Next.js build.
export {}
