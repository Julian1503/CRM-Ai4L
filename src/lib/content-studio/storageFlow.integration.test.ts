/**
 * @jest-environment node
 *
 * Content Storage end to end against the local stack (Postgres, PostgREST, Storage):
 *
 *   createUpload → the browser PUTs bytes to the signed URL → ingest is queued → a worker
 *   (simulated through workerOps, the same functions the internal routes call) claims it,
 *   reads its context, downloads the quarantined bytes and uploads renditions to the
 *   signed targets it was given → complete → the asset is ready → publishAsset('email')
 *   gives a public URL that serves those exact bytes, and publishing again returns the
 *   same immutable copy.
 *
 * Plus the access boundary: anonymous callers, signed-in non-members and members cannot
 * list or read the private buckets through the Storage API, and a member cannot read
 * social_account_secrets through PostgREST.
 *
 * Runs with SUPABASE_INTEGRATION_STORAGE=true and an anon key
 * (SUPABASE_INTEGRATION_ANON_KEY, or NEXT_PUBLIC_SUPABASE_ANON_KEY) on top of the usual
 * integration variables. Nothing is physically deleted; fixtures carry unique names.
 */
import { createHash } from 'node:crypto'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/lib/db/types'
import { integrationEnabled, must, serviceClient, uniqueTag } from '@/test/integration'

import { CONTENT_BUCKETS, createUpload, ensureContentBuckets, publishAsset } from './assets'
import { enqueueIngest, getJob } from './jobs'
import { createItem, getItem } from './repository'
import type { IngestAssetContext } from './types'
import { claimJobs, complete, jobContext } from './workerOps'

jest.setTimeout(90_000)

type Db = SupabaseClient<Database>

const url = process.env.SUPABASE_INTEGRATION_URL?.trim() ?? ''
const anonKey = (process.env.SUPABASE_INTEGRATION_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim()
const storageEnabled = integrationEnabled && process.env.SUPABASE_INTEGRATION_STORAGE === 'true' && anonKey !== ''
const describeStorage = storageEnabled ? describe : describe.skip

/** A 1×1 PNG: real image bytes, so Storage's MIME allowlist and the public copy are exercised. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)
const PASSWORD = `Pw-${uniqueTag('it')}-9aZ`
const ORIGINAL_ENV = process.env

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function anonClient(): Db {
  return createClient<Database>(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
}

async function newUser(admin: Db, membership: 'operator' | null): Promise<{ id: string; client: Db }> {
  const email = `${uniqueTag('content-it')}@example.invalid`
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true })
  if (error || !data.user) throw new Error(`Could not create a test user: ${error?.message}`)

  if (membership) {
    const { error: memberError } = await admin.from('crm_members').insert({ user_id: data.user.id, role: membership, active: true })
    if (memberError) throw new Error(memberError.message)
  }

  const client = anonClient()
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: PASSWORD })
  if (signInError) throw new Error(`Could not sign in the test user: ${signInError.message}`)
  return { id: data.user.id, client }
}

/** Plays the content engine for one ingest job: read the source, write renditions, report them. */
async function workIngest(admin: Db, jobId: string): Promise<{ checksum: string }> {
  await admin.from('content_jobs').update({ next_attempt_at: '2000-01-01T00:00:00Z' }).eq('id', jobId)
  const { jobs } = await claimJobs(admin, { workerId: 'it-worker', kinds: ['ingest_asset'], limit: 1, leaseSeconds: 60 })
  const claimed = jobs.find((job) => job.jobId === jobId)
  if (!claimed) throw new Error('The ingest job was not claimed first; another worker may be draining the local queue.')

  const { context } = await jobContext(admin, { jobId, claimToken: claimed.claimToken })
  const ingest = context as IngestAssetContext
  const source = Buffer.from(await (await fetch(ingest.source.signedUrl)).arrayBuffer())
  expect(source.equals(PNG)).toBe(true)

  const target = (name: string) => {
    const upload = ingest.uploads.find((entry) => entry.path.endsWith(`/${name}`))
    if (!upload) throw new Error(`No upload target named ${name}`)
    return upload
  }
  for (const name of ['original.png', 'email.png']) {
    const upload = target(name)
    const { error } = await anonClient().storage.from(CONTENT_BUCKETS.library).uploadToSignedUrl(upload.path, upload.token, PNG, {
      contentType: 'image/png',
    })
    if (error) throw new Error(`Worker upload failed: ${error.message}`)
  }

  const file = (name: string) => ({ path: target(name).path, mimeType: 'image/png', byteSize: PNG.length, width: 1, height: 1, checksum: sha256(PNG) })
  const result = { status: 'ready', files: { original: file('original.png'), renditions: { email: file('email.png') } } }
  expect(await complete(admin, { jobId, claimToken: claimed.claimToken, result: result as never })).toEqual({ accepted: true })
  return { checksum: sha256(PNG) }
}

describeStorage('content storage end to end', () => {
  beforeAll(() => {
    process.env = { ...ORIGINAL_ENV, CONTENT_STUDIO_ENABLED: 'true' }
  })

  afterAll(() => {
    process.env = ORIGINAL_ENV
  })

  it('uploads, ingests through the worker protocol and publishes an immutable public copy', async () => {
    const admin = serviceClient()
    await ensureContentBuckets(admin)
    const operator = await newUser(admin, 'operator')

    const { asset, upload } = await createUpload(admin, operator.id, { filename: 'My Photo.PNG', mimeType: 'image/png', byteSize: PNG.length }, admin)
    expect(upload.path).toBe(`uploads/${asset.id}/my-photo.png`)

    // The browser's PUT: no service role, only the signed token.
    const put = await anonClient().storage.from(CONTENT_BUCKETS.quarantine).uploadToSignedUrl(upload.path, upload.token, PNG, {
      contentType: 'image/png',
    })
    expect(put.error).toBeNull()

    const row = await must(admin.from('content_assets').select('*').eq('id', asset.id).single())
    const job = await enqueueIngest(admin, row)
    const again = await enqueueIngest(admin, row)
    expect(again.id).toBe(job.id)

    const { checksum } = await workIngest(admin, job.id)
    const ready = await must(admin.from('content_assets').select('ingest_status, storage_path, checksum').eq('id', asset.id).single())
    expect(ready).toMatchObject({ ingest_status: 'ready', storage_path: `library/${asset.id}/original.png`, checksum })

    const published = await publishAsset(admin, asset.id, 'email', operator.id)
    expect(published.publicUrl).toContain(`/${CONTENT_BUCKETS.public}/p/${published.id}/${checksum}.png`)

    const served = await fetch(published.publicUrl)
    expect(served.status).toBe(200)
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true)

    const republished = await publishAsset(admin, asset.id, 'email', operator.id)
    expect(republished).toEqual(published)
  })

  it('keeps the private buckets closed to anonymous callers, non-members and members', async () => {
    const admin = serviceClient()
    await ensureContentBuckets(admin)
    const path = `library/${uniqueTag('rls')}/original.png`
    const { error } = await admin.storage.from(CONTENT_BUCKETS.library).upload(path, PNG, { contentType: 'image/png' })
    if (error) throw new Error(error.message)

    const outsider = await newUser(admin, null)
    const member = await newUser(admin, 'operator')

    for (const client of [anonClient(), outsider.client, member.client]) {
      for (const bucket of [CONTENT_BUCKETS.library, CONTENT_BUCKETS.quarantine]) {
        const listed = await client.storage.from(bucket).list('library')
        expect(listed.data ?? []).toEqual([])
      }
      const download = await client.storage.from(CONTENT_BUCKETS.library).download(path)
      expect(download.data).toBeNull()
      const signed = await client.storage.from(CONTENT_BUCKETS.library).createSignedUrl(path, 60)
      expect(signed.data).toBeNull()
    }
  })

  it('lets a member read items and jobs without ever selecting the claim token', async () => {
    const admin = serviceClient()
    const member = await newUser(admin, 'operator')

    const item = await createItem(member.client, member.id, { title: uniqueTag('member-read'), brief: { topic: 'Grants' }, channels: ['email'] })
    const job = await member.client.rpc('enqueue_content_job', {
      p_kind: 'generate_text',
      p_idempotency_key: uniqueTag('member-job'),
      p_item_id: item.id,
      p_input: { itemId: item.id, channels: ['email'] },
    })
    expect(job.error).toBeNull()
    const jobId = (job.data as unknown as { id: string }).id

    const read = await getItem(member.client, item.id)
    expect(read?.jobs.map((entry) => entry.id)).toContain(jobId)
    await expect(getJob(member.client, jobId)).resolves.toMatchObject({ id: jobId, status: 'queued' })

    const direct = await member.client.from('content_jobs').select('claim_token').eq('id', jobId)
    expect(direct.error).not.toBeNull()

    const audit = await admin.from('content_audit_events').select('actor_id, action').eq('subject_id', item.id).eq('action', 'item.created')
    expect(audit.data).toEqual([{ actor_id: member.id, action: 'item.created' }])

    await admin.rpc('cancel_content_job', { p_job_id: jobId })
  })

  it('never lets a member read social tokens through PostgREST', async () => {
    const admin = serviceClient()
    const brand = await must(admin.from('content_brand_profiles').select('id').eq('slug', 'ai4l').single())
    const account = await must(
      admin
        .from('social_accounts')
        .insert({
          brand_id: brand.id,
          platform: 'linkedin',
          provider: 'mock',
          external_id: uniqueTag('urn'),
          display_name: 'IT account',
          author_kind: 'organization',
        })
        .select('id')
        .single()
    )
    await must(
      admin
        .from('social_account_secrets')
        .insert({ account_id: account.id, access_token: 'v1:not-a-real-envelope', key_version: 1 })
        .select('account_id')
        .single()
    )

    const member = await newUser(admin, 'operator')
    const { data, error } = await member.client.from('social_account_secrets').select('*').eq('account_id', account.id)

    expect(error !== null || (data ?? []).length === 0).toBe(true)
    expect(JSON.stringify(data ?? [])).not.toContain('not-a-real-envelope')
  })
})
