/**
 * @jest-environment node
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { CRON_PATHS, PUBLIC_PATHS, WEBHOOK_PATHS } from '@/lib/auth/routes'

/**
 * Structural security invariants.
 *
 * These assert properties of the codebase rather than behaviour of one function. They
 * exist because the failures they catch are silent: an API route added without a
 * session check does not throw, does not fail a unit test, and does not look wrong in
 * review — it just quietly serves client data to anyone who finds the URL.
 *
 * proxy.ts is an optimistic gate only (the Next.js docs warn Server Functions can fall
 * outside a matcher), so "the proxy covers it" is not a defence.
 */

const API_ROOT = join(process.cwd(), 'src', 'app', 'api')

type RouteFile = {
  /** URL path the file serves, e.g. /api/contacts/export */
  urlPath: string
  repoPath: string
  content: string
}

function collectRouteFiles(dir: string, acc: RouteFile[] = []): RouteFile[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)

    if (statSync(full).isDirectory()) {
      collectRouteFiles(full, acc)
    } else if (entry === 'route.ts' || entry === 'route.tsx') {
      const repoPath = relative(process.cwd(), full).split(sep).join('/')

      acc.push({
        repoPath,
        // src/app/api/contacts/export/route.ts -> /api/contacts/export
        urlPath:
          '/' +
          repoPath
            .replace(/^src\/app\//, '')
            .replace(/\/route\.tsx?$/, ''),
        content: readFileSync(full, 'utf8'),
      })
    }
  }

  return acc
}

const routeFiles = collectRouteFiles(API_ROOT)

/** True when the route is a documented third-party webhook endpoint. */
function isWebhookRoute(route: RouteFile): boolean {
  return (WEBHOOK_PATHS as readonly string[]).includes(route.urlPath)
}

/** True when the route is a documented scheduled-job endpoint. */
function isCronRoute(route: RouteFile): boolean {
  return (CRON_PATHS as readonly string[]).includes(route.urlPath)
}

/** A cron route's only gate: the shared secret, compared in constant time. */
function verifiesCronSecret(route: RouteFile): boolean {
  return /process\.env\.CRON_SECRET/.test(route.content) && /timingSafeEqual\s*\(/.test(route.content)
}

/** True when the route is a documented public endpoint. */
function isPublicRoute(route: RouteFile): boolean {
  return (PUBLIC_PATHS as readonly string[]).some(
    (publicPath) => route.urlPath === publicPath || route.urlPath.startsWith(`${publicPath}/`)
  )
}

function checksSession(route: RouteFile): boolean {
  return /getSession\s*\(|requireSessionOr401\s*\(/.test(route.content)
}

function verifiesSignature(route: RouteFile): boolean {
  return /verifyWebhookSignature\s*\(|constructEvent\s*\(/.test(route.content)
}

describe('API route authentication', () => {
  it('finds routes to check, so an empty sweep cannot pass silently', () => {
    expect(routeFiles.length).toBeGreaterThan(5)
  })

  it.each(routeFiles.map((route) => [route.urlPath, route] as const))(
    '%s authenticates its caller',
    (_path, route) => {
      // Exactly one of four must hold: a session check, a webhook signature check, a
      // cron secret check, or membership of the documented public allowlist.
      const authenticated =
        checksSession(route) ||
        (isWebhookRoute(route) && verifiesSignature(route)) ||
        (isCronRoute(route) && verifiesCronSecret(route))

      expect(authenticated || isPublicRoute(route)).toBe(true)
    }
  )

  it.each(
    routeFiles
      .filter((route) => isWebhookRoute(route))
      .map((route) => [route.urlPath, route] as const)
  )('%s verifies its signature, since it has no session', (_path, route) => {
    // A webhook route is exempt from the session gate. If it also skips signature
    // verification it is completely unauthenticated — and these routes write with the
    // service-role key, bypassing RLS.
    expect(verifiesSignature(route)).toBe(true)
  })

  it.each(
    routeFiles
      .filter((route) => isWebhookRoute(route))
      .map((route) => [route.urlPath, route] as const)
  )('%s reads the raw body before parsing', (_path, route) => {
    // Signatures cover the exact bytes received. Calling request.json() first and
    // re-serialising changes whitespace and key order, and the digest with it.
    expect(route.content).toMatch(/await\s+request\.text\(\)/)
  })

  it.each(
    routeFiles
      .filter((route) => isCronRoute(route))
      .map((route) => [route.urlPath, route] as const)
  )('%s checks CRON_SECRET, since it has no session', (_path, route) => {
    // Exempt from the session gate and writing with the service-role key: without the
    // secret check anyone could trigger it.
    expect(verifiesCronSecret(route)).toBe(true)
  })

  it('keeps the public API surface small and deliberate', () => {
    const publicRoutes = routeFiles.filter(
      (route) => isPublicRoute(route) && !checksSession(route)
    )

    // Public API routes are a deliberate, reviewed set. A new one appearing here
    // should force a conversation rather than slip through.
    expect(publicRoutes.map((route) => route.urlPath).sort()).toEqual([
      '/api/booking/create-session',
      // Reviewed and deliberate: a login wall in front of an unsubscribe link is a
      // Spam Act problem, and the person acting has no CRM account by definition. The
      // signed token in the path is the credential, it names the only contact the
      // route will touch, and no id is ever read from the request body.
      '/api/preferences/[token]',
    ])
  })
})

describe('service-role usage', () => {
  const adminUsers = routeFiles.filter((route) => route.content.includes('getAdminClient'))

  it('is confined to webhooks, scheduled jobs and documented public routes', () => {
    // The service-role client bypasses Row Level Security entirely. Anything acting on
    // behalf of a signed-in user must go through the session-bound client so RLS still
    // applies. Scheduled jobs have no user, like webhooks.
    const offenders = adminUsers
      .filter((route) => !isWebhookRoute(route) && !isCronRoute(route) && !isPublicRoute(route))
      .map((route) => route.urlPath)

    expect(offenders).toEqual([])
  })

  it('is used by at least the routes that genuinely have no session', () => {
    expect(adminUsers.length).toBeGreaterThan(0)
  })
})

describe('cache safety', () => {
  it.each(
    routeFiles
      .filter((route) => checksSession(route))
      .map((route) => [route.urlPath, route] as const)
  )('%s marks authenticated responses uncacheable', (_path, route) => {
    // These responses carry client data. A shared cache must never be able to serve
    // one user's contacts to another.
    const usesHelper = /from '@\/lib\/api\/responses'/.test(route.content)
    const setsHeader = /no-store/.test(route.content)

    expect(usesHelper || setsHeader).toBe(true)
  })
})

describe("'use server' modules", () => {
  const SRC_ROOT = join(process.cwd(), 'src')

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

  const serverActionFiles = collectSourceFiles(SRC_ROOT)
    .map((file) => ({
      path: relative(process.cwd(), file).split(sep).join('/'),
      content: readFileSync(file, 'utf8'),
    }))
    .filter(({ content }) => /^\s*['"]use server['"]/m.test(content))

  it.each(serverActionFiles.map((file) => [file.path, file] as const))(
    '%s exports only async functions',
    (_path, file) => {
      // Next.js rejects any other export at runtime with "A 'use server' file can only
      // export async functions", and the whole module fails to evaluate — taking the
      // page with it. Neither the build nor Jest catches this: Jest imports the module
      // directly, without the Server Actions transform. It only appears when the page
      // is actually rendered, which is how it survived several phases here.
      const valueExports = [...file.content.matchAll(/^export\s+(?!type\b|interface\b)(\w+)/gm)]
        .map((match) => match[1])
        .filter((keyword) => keyword !== 'async')

      expect(valueExports).toEqual([])
    }
  )

  it('finds the server action modules, so an empty sweep cannot pass', () => {
    expect(serverActionFiles.length).toBeGreaterThan(0)
  })
})
