/**
 * @jest-environment node
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// Static guard against leaking server-only credentials into a client bundle.
// Unit tests cannot catch this: a service-role key in a 'use client' module is a
// deploy-time data breach, not a runtime failure, so it is asserted structurally.

const SRC_ROOT = join(process.cwd(), 'src')
const SERVER_ONLY_ENV = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'STRIPE_SECRET_KEY',
  'ANTHROPIC_API_KEY',
  'CONTENT_WORKER_SECRET',
  'CONTENT_ENGINE_SECRET',
  'CONTENT_TOKEN_ENCRYPTION_KEY',
]

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, acc)
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      acc.push(full)
    }
  }
  return acc
}

const sourceFiles = collectSourceFiles(SRC_ROOT).map((file) => ({
  path: relative(process.cwd(), file).split(sep).join('/'),
  content: readFileSync(file, 'utf8'),
}))

const clientFiles = sourceFiles.filter(({ content }) =>
  /^\s*['"]use client['"]/m.test(content)
)

describe('credential isolation', () => {
  it('finds source files to scan (guards against a silently empty sweep)', () => {
    expect(sourceFiles.length).toBeGreaterThan(0)
  })

  it.each(SERVER_ONLY_ENV)('never exposes %s with a NEXT_PUBLIC_ prefix', (name) => {
    const offenders = sourceFiles
      .filter(({ content }) => content.includes(`NEXT_PUBLIC_${name}`))
      .map(({ path }) => path)

    expect(offenders).toEqual([])
  })

  it.each(SERVER_ONLY_ENV)('never references %s from a client component', (name) => {
    const offenders = clientFiles
      .filter(({ content }) => content.includes(name))
      .map(({ path }) => path)

    expect(offenders).toEqual([])
  })

  it('never imports the service-role client from a client component', () => {
    const offenders = clientFiles
      .filter(({ content }) => /from\s+['"][^'"]*supabase\/admin['"]/.test(content))
      .map(({ path }) => path)

    expect(offenders).toEqual([])
  })

  it('guards the service-role client with the server-only marker', () => {
    const admin = sourceFiles.find(({ path }) => path.endsWith('src/lib/supabase/admin.ts'))

    expect(admin).toBeDefined()
    expect(admin!.content).toMatch(/import\s+['"]server-only['"]/)
  })

  it('guards the session-bound server client with the server-only marker', () => {
    const server = sourceFiles.find(({ path }) => path.endsWith('src/lib/supabase/server.ts'))

    expect(server).toBeDefined()
    expect(server!.content).toMatch(/import\s+['"]server-only['"]/)
  })
})
