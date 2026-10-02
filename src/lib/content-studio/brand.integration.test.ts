/**
 * @jest-environment node
 *
 * Brand profile editing against the local stack: an administrator updates it through
 * update_content_brand_profile with their own session (the function checks
 * is_crm_admin(), so the service role cannot be used for this), an operator is refused,
 * and invalid origins come back as CRM07 invalid_origin. The original values are put
 * back afterwards so the local brand is left as found.
 *
 * Needs an anon key (SUPABASE_INTEGRATION_ANON_KEY, or NEXT_PUBLIC_SUPABASE_ANON_KEY).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'
import { integrationEnabled, must, serviceClient, uniqueTag } from '@/test/integration'

import { getBrandProfile, updateBrandProfile } from './brand'

jest.setTimeout(60_000)

type Db = SupabaseClient<Database>

const url = process.env.SUPABASE_INTEGRATION_URL?.trim() ?? ''
const anonKey = (process.env.SUPABASE_INTEGRATION_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()
const describeBrand = integrationEnabled && anonKey !== '' ? describe : describe.skip

async function signedIn(admin: Db, role: 'admin' | 'operator'): Promise<Db> {
  const email = `${uniqueTag(`brand-${role}`)}@example.invalid`
  const password = `Pw-${uniqueTag('it')}-9aZ`
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error || !data.user) throw new Error(`Could not create a test user: ${error?.message}`)
  await must(admin.from('crm_members').insert({ user_id: data.user.id, role, active: true }).select('user_id').single())

  const client = createClient<Database>(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error: signInError } = await client.auth.signInWithPassword({ email, password })
  if (signInError) throw new Error(signInError.message)
  return client
}

describeBrand('brand profile against Postgres', () => {
  it('lets an administrator edit it, refuses an operator, and validates origins', async () => {
    const admin = serviceClient()
    const administrator = await signedIn(admin, 'admin')
    const operator = await signedIn(admin, 'operator')
    const original = await getBrandProfile(administrator)

    try {
      const updated = await updateBrandProfile(administrator, {
        tone: 'Integration tone',
        hashtagSeeds: ['#AI4L', 'Learn'],
        allowedLinkOrigins: ['https://ai4l.example'],
        approvedFacts: [{ id: 'it-1', text: 'Integration fact' }],
      })
      expect(updated).toMatchObject({
        tone: 'Integration tone',
        hashtagSeeds: ['AI4L', 'Learn'],
        allowedLinkOrigins: ['https://ai4l.example'],
        approvedFacts: [{ id: 'it-1', text: 'Integration fact' }],
        name: original.name,
      })
      // Every member reads it; the generator is grounded in it.
      await expect(getBrandProfile(operator)).resolves.toMatchObject({ tone: 'Integration tone' })

      await expect(updateBrandProfile(operator, { tone: 'Operator tone' })).rejects.toMatchObject({ sqlState: '42501' })
      await expect(updateBrandProfile(administrator, { allowedLinkOrigins: ['https://ai4l.example/path'] })).rejects.toMatchObject({
        sqlState: 'CRM07',
        hint: 'invalid_origin',
      })
    } finally {
      await updateBrandProfile(administrator, {
        tone: original.tone,
        hashtagSeeds: original.hashtagSeeds,
        allowedLinkOrigins: original.allowedLinkOrigins,
        approvedFacts: original.approvedFacts,
        channelRules: original.channelRules,
      })
    }
  })
})
