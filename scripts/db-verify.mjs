#!/usr/bin/env node
/**
 * Runs the supabase/tests verification scripts against an explicitly chosen database.
 *
 *   npm run db:verify                       every script, local stack (default)
 *   npm run db:verify -- membership         scripts whose name or alias matches
 *   DB_VERIFY_TARGET=linked DB_VERIFY_LINKED_REF=<ref> npm run db:verify
 *
 * Target guard (audit T2): the scripts write fixtures inside a rolled-back transaction,
 * but they still execute against whatever database they are pointed at. They used to
 * default to `--linked`, which is the business database. Now:
 *
 *   local   (default) psql inside the local Supabase container started by `supabase start`
 *   linked  only when DB_VERIFY_LINKED_REF equals the project ref the CLI is linked to,
 *           so a stale link can never be hit by accident
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const TESTS_DIR = join(ROOT, 'supabase', 'tests')

// Friendly names for `npm run db:verify -- <name>`; the file name also works.
const ALIASES = {
  contacts: 'verify_20260807000000.sql',
  webhooks: 'verify_20260807010000.sql',
  campaigns: 'verify_20260808000000.sql',
  bookings: 'verify_20260808010000.sql',
  operations: 'verify_20260825030000.sql',
  reruns: 'verify_20260827000000.sql',
  consent: 'verify_20260901000000.sql',
  schedules: 'verify_20260928000000.sql',
  segments: 'verify_20260929000000.sql',
  archive: 'verify_20260930000000.sql',
  archive2: 'verify_20261001000000.sql',
  membership: 'verify_20261002000000.sql',
  delivery: 'verify_20261003000000.sql',
  contacts2: 'verify_20261004000000.sql',
}

function fail(message) {
  console.error(`db:verify: ${message}`)
  process.exit(1)
}

function selectFiles(filters) {
  const all = readdirSync(TESTS_DIR).filter((name) => /^verify_.*\.sql$/.test(name)).sort()
  if (filters.length === 0) return all

  return filters.map((filter) => {
    const file = ALIASES[filter] ?? all.find((name) => name.includes(filter))
    if (!file || !all.includes(file)) fail(`no verification script matches "${filter}"`)
    return file
  })
}

function localContainer() {
  const config = readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8')
  const projectId = config.match(/^project_id\s*=\s*"([^"]+)"/m)?.[1]
  if (!projectId) fail('supabase/config.toml has no project_id')
  return `supabase_db_${projectId}`
}

function linkedRefGuard() {
  const expected = process.env.DB_VERIFY_LINKED_REF?.trim()
  if (!expected) {
    fail('DB_VERIFY_TARGET=linked requires DB_VERIFY_LINKED_REF=<project ref> as confirmation.')
  }

  let linked = ''
  try {
    linked = readFileSync(join(ROOT, 'supabase', '.temp', 'project-ref'), 'utf8').trim()
  } catch {
    fail('the Supabase CLI is not linked to any project.')
  }

  if (linked !== expected) {
    fail(`the CLI is linked to "${linked}", not the confirmed "${expected}". Refusing.`)
  }
}

function run(target, file) {
  const path = join(TESTS_DIR, file)

  if (target === 'local') {
    return spawnSync(
      'docker',
      ['exec', '-i', localContainer(), 'psql', '-U', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1'],
      { input: readFileSync(path), stdio: ['pipe', 'ignore', 'pipe'] }
    )
  }

  return spawnSync('npx', ['supabase', 'db', 'query', '--linked', '--file', path], {
    stdio: ['ignore', 'ignore', 'pipe'],
    shell: process.platform === 'win32',
  })
}

const target = (process.env.DB_VERIFY_TARGET ?? 'local').trim()
if (!['local', 'linked'].includes(target)) fail(`unknown DB_VERIFY_TARGET "${target}"`)
if (target === 'linked') linkedRefGuard()

const files = selectFiles(process.argv.slice(2))
console.log(`db:verify target=${target} scripts=${files.length}`)

let failures = 0
for (const file of files) {
  const result = run(target, file)
  const stderr = result.stderr?.toString() ?? ''
  const failed = result.status !== 0 || /\bERROR:/.test(stderr)

  if (failed) {
    failures += 1
    console.error(`FAIL ${file}`)
    console.error(stderr.split('\n').filter((line) => /ERROR|error/.test(line)).slice(0, 5).join('\n'))
  } else {
    console.log(`ok   ${file}`)
  }
}

if (failures > 0) fail(`${failures} of ${files.length} verification scripts failed`)
