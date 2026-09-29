import type { NextResponse } from 'next/server'

import { badRequest, conflict, notFound, ok, readJsonBody, serverError } from '@/lib/api/responses'
import { processConsentOutbox } from '@/lib/consent/outbox'
import { loadEmailOctopusCredentials } from '@/lib/marketing/providers/credentials'
import { createSupabaseServerClient } from '@/lib/supabase/server'

import { preferencesOrigin } from './providerSync'
import { parseContactSaveInput, saveContact } from './save'

/**
 * The request handling shared by POST /api/contacts (create) and PUT
 * /api/contacts/[id] (update). Updates must carry `expectedRevision`.
 *
 * After a successful save, any consent change it queued is pushed straight away —
 * best effort, since the outbox entry was committed with the save and the scheduled
 * worker is the guarantee (audit H5).
 */
export async function handleContactSave(
  request: Request,
  id: string | null,
  origin: string
): Promise<NextResponse> {
  const body = await readJsonBody(request)
  if (!body) return badRequest('Expected a JSON object.')

  const parsed = parseContactSaveInput(body)
  if (!parsed.ok) return badRequest(parsed.error)

  const expectedRevision = body.expectedRevision
  if (id !== null && (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision))) {
    return badRequest('expectedRevision is required when updating a contact.')
  }

  try {
    const db = await createSupabaseServerClient()
    const result = await saveContact(db, {
      id,
      input: parsed.input,
      expectedRevision: id === null ? null : (expectedRevision as number),
    })

    if (result.kind === 'invalid') return badRequest(result.message)
    if (result.kind === 'conflict') return conflict(result.message)
    if (result.kind === 'not_found') return notFound('Contact not found.')

    const contactId = String(result.contact.id)
    const providerSync = await pushConsentNow(db, contactId, origin)

    return ok({ contact: result.contact, providerSync })
  } catch (error) {
    console.error('Contact save failed:', error)
    return serverError(null, 'Could not save this contact. Nothing was changed.')
  }
}

async function pushConsentNow(
  db: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  contactId: string,
  origin: string
): Promise<'done' | 'pending' | 'none'> {
  try {
    const result = await processConsentOutbox(db, {
      credentials: await loadEmailOctopusCredentials(),
      origin: preferencesOrigin(origin),
      contactId,
      limit: 1,
    })
    if (result.claimed === 0) return result.notConfigured ? 'pending' : 'none'
    return result.failed === 0 ? 'done' : 'pending'
  } catch (error) {
    console.error('Inline consent sync failed; left queued:', error)
    return 'pending'
  }
}
