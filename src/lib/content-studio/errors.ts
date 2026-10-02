import { NextResponse } from 'next/server'

/**
 * Error model for the Content Studio API and worker bridge.
 *
 * The SQL functions in 20261007000000_content_studio.sql raise with a SQLSTATE and, where
 * the caller must branch, a `hint`. Those are translated here — in one place — into the
 * CRM error envelope `{ error, code? }` with the matching status:
 *
 *   CRM06  stale / conflict (hint: stale_revision, not_approved, already_published)  409
 *   CRM07  validation (hint: asset_not_ready, channel_mismatch, ...)                   422
 *          except hints archived, blocked_content, asset_not_pending               409
 *   CRM01  archive rule                                                               409
 *   42501  permission                                                                403
 *   P0002  not found                                                                 404
 *   22023  invalid argument; 22P02 malformed value; 23514 check constraint            400
 *   23505  unique violation                                                          409
 *
 * Anything else is a 500 whose body carries only the caller's fallback message: database
 * and provider messages can describe internals and are logged server-side instead.
 */

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export type DbErrorLike = { code?: string | null; message: string; hint?: string | null; details?: string | null }

/** An error with an HTTP meaning, raised by the application itself. */
export class ContentHttpError extends Error {
  readonly status: number
  readonly code: string | undefined

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'ContentHttpError'
    this.status = status
    this.code = code
  }
}

/** A database error, carrying the SQLSTATE and hint the mapping needs. */
export class ContentDbError extends Error {
  readonly sqlState: string | null
  readonly hint: string | null

  constructor(error: DbErrorLike) {
    super(error.message)
    this.name = 'ContentDbError'
    this.sqlState = error.code ?? null
    this.hint = error.hint ?? null
  }
}

/** Throws a ContentDbError when a PostgREST call failed. */
export function throwIfDbError(error: DbErrorLike | null | undefined): void {
  if (error) throw new ContentDbError(error)
}

const STATUS_BY_SQLSTATE: Readonly<Record<string, number>> = {
  CRM06: 409,
  CRM07: 422,
  CRM01: 409,
  '42501': 403,
  P0002: 404,
  '22023': 400,
  '22P02': 400,
  '23514': 400,
  '23505': 409,
}

/**
 * Hints whose meaning is a conflict with the record's state rather than bad input:
 * acting on an archived item or variant (CRM07 'archived') answers 409 like the other
 * archive rules (CRM01), so the UI treats "restore it first" the same way everywhere.
 */
const STATUS_BY_HINT: Readonly<Record<string, number>> = {
  archived: 409,
  // The generated revision carries a 'blocked:' violation; it must be edited first.
  blocked_content: 409,
  // Ingestion asked for an image that is already processed (or being processed).
  asset_not_pending: 409,
  // Brand profile validation the database repeats: plain bad input, so 400.
  invalid_facts: 400,
  invalid_channel_rules: 400,
  invalid_origin: 400,
}

/**
 * Generic PostgreSQL errors carry the database's own wording (constraint and column
 * names, sometimes values). Their message is replaced; the custom CRM0x messages and the
 * messages our functions raise with 22023/P0002 are written for people and are kept.
 */
const GENERIC_MESSAGES: Readonly<Record<string, string>> = {
  '23505': 'This conflicts with an existing record.',
  '23514': 'A value is not allowed here.',
  '22P02': 'A value has an invalid format.',
}

/** A hint is a machine code only when it looks like one (the SQL uses snake_case). */
function codeFromHint(hint: string | null): string | undefined {
  return hint && /^[a-z][a-z_]{1,60}$/.test(hint) ? hint : undefined
}

export function errorResponse(status: number, message: string, code?: string): NextResponse {
  return NextResponse.json(code ? { error: message, code } : { error: message }, { status, headers: NO_STORE })
}

export function featureDisabled(message = 'The Content Studio is not enabled.'): NextResponse {
  return errorResponse(404, message, 'feature_disabled')
}

/** Translates anything a handler caught into the response to send. */
export function contentErrorResponse(error: unknown, fallback = 'Request failed.'): NextResponse {
  if (error instanceof ContentHttpError) {
    return errorResponse(error.status, error.message, error.code)
  }

  if (error instanceof ContentDbError && error.sqlState && STATUS_BY_SQLSTATE[error.sqlState]) {
    const status = (error.hint && STATUS_BY_HINT[error.hint]) || STATUS_BY_SQLSTATE[error.sqlState]
    const message = status === 403 ? 'You do not have permission to do that.' : GENERIC_MESSAGES[error.sqlState] ?? error.message
    return errorResponse(status, message, codeFromHint(error.hint))
  }

  console.error(`${fallback}`, error instanceof Error ? error.message : 'unknown error')
  return errorResponse(500, fallback)
}
