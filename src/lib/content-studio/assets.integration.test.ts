/**
 * @jest-environment node
 *
 * Content Storage against the local Supabase Storage API: bucket bootstrap, signed
 * worker uploads (upsert), signed previews and the immutable public copy. Objects written
 * here live under test-only paths and are never deleted (project rule).
 *
 * Needs the Storage API container, which `supabase start -x ...,storage-api,...` leaves
 * out, so it runs only with SUPABASE_INTEGRATION_STORAGE=true on top of the usual
 * integration variables.
 */
import { integrationEnabled, must, serviceClient } from '@/test/integration'

import { CONTENT_BUCKETS, ensureContentBuckets, publishAsset, signDownloads, signUploads } from './assets'

jest.setTimeout(60_000)

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)
const CHECKSUM = 'c'.repeat(64)

const describeStorage = integrationEnabled && process.env.SUPABASE_INTEGRATION_STORAGE === 'true' ? describe : describe.skip

describeStorage('content storage against Supabase Storage', () => {
  it('uploads through a signed URL, rewrites it (upsert), previews it and publishes an immutable copy', async () => {
    const db = serviceClient()
    await ensureContentBuckets(db)

    const assetId = (
      await must(
        db
          .from('content_assets')
          .insert({
            brand_id: (await must(db.from('content_brand_profiles').select('id').eq('slug', 'ai4l').single())).id,
            origin: 'upload',
            ingest_status: 'pending',
          })
          .select('id')
          .single()
      )
    ).id
    const path = `library/${assetId}/original.png`

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [upload] = await signUploads(db, CONTENT_BUCKETS.library, [path], true)
      const { error } = await db.storage.from(CONTENT_BUCKETS.library).uploadToSignedUrl(upload.path, upload.token, PNG, { contentType: 'image/png' })
      expect(error).toBeNull()
    }

    const previews = await signDownloads(db, CONTENT_BUCKETS.library, [path])
    expect(previews.get(path)).toMatch(/^https?:\/\//)

    await must(
      db
        .from('content_assets')
        .update({ ingest_status: 'ready', storage_path: path, mime_type: 'image/png', byte_size: PNG.length, width: 1, height: 1, checksum: CHECKSUM })
        .eq('id', assetId)
        .select('id')
        .single()
    )

    const first = await publishAsset(db, assetId, 'email', null)
    const again = await publishAsset(db, assetId, 'email', null)
    expect(again.id).toBe(first.id)
    expect(first.publicUrl).toContain(`/${CONTENT_BUCKETS.public}/p/${first.id}/${CHECKSUM}.png`)

    const response = await fetch(first.publicUrl)
    expect(response.status).toBe(200)
  })
})
