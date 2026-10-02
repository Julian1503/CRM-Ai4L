import { isUuid } from '@/lib/contacts/tags'
import type { PublishRequest } from '@/lib/content-studio/types'
import type { Body, Parsed } from '@/lib/content-studio/validation'

/** Body of POST /api/social/publications and /preflight. */
export function parsePublishRequest(body: Body): Parsed<PublishRequest> {
  const { revisionId, accountId, idempotencyKey } = body
  if (typeof revisionId !== 'string' || !isUuid(revisionId)) return { ok: false, error: 'revisionId must be a UUID.' }
  if (typeof accountId !== 'string' || !isUuid(accountId)) return { ok: false, error: 'accountId must be a UUID.' }
  const key = typeof idempotencyKey === 'string' ? idempotencyKey.trim() : ''
  if (key.length < 8 || key.length > 200) {
    return { ok: false, error: 'idempotencyKey must be 8 to 200 characters.' }
  }
  return { ok: true, value: { revisionId, accountId, idempotencyKey: key } }
}
