/** @jest-environment node */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { IDS } from './testFixtures'
import {
  containsSecretKey,
  parseCheckpoint,
  parseClaim,
  parseComplete,
  parseFail,
  parseJobRef,
  validateJobResult,
} from './workerValidation'

const REF = { jobId: IDS.job, claimToken: IDS.token }
const FILE = { path: `library/${IDS.asset}/original`, mimeType: 'image/png', byteSize: 10, width: 10, height: 10, checksum: 'a'.repeat(64) }

function error(result: { ok: boolean; error?: string }) {
  return result.ok ? null : result.error
}

describe('requests', () => {
  it('parseClaim accepts a claim and de-duplicates kinds', () => {
    expect(parseClaim({ workerId: 'w1', kinds: ['ingest_asset', 'ingest_asset'], limit: 2, leaseSeconds: 60 })).toEqual({
      ok: true,
      value: { workerId: 'w1', kinds: ['ingest_asset'], limit: 2, leaseSeconds: 60 },
    })
    expect(parseClaim({ workerId: 'w1', kinds: ['generate_text'], limit: 1 })).toEqual({
      ok: true,
      value: { workerId: 'w1', kinds: ['generate_text'], limit: 1 },
    })
  })

  it.each([
    [{ kinds: ['ingest_asset'], limit: 1 }, /workerId/],
    [{ workerId: '  ', kinds: ['ingest_asset'], limit: 1 }, /workerId/],
    [{ workerId: 'w', kinds: [], limit: 1 }, /kinds/],
    [{ workerId: 'w', kinds: ['delete_all'], limit: 1 }, /kinds/],
    [{ workerId: 'w', kinds: ['ingest_asset'], limit: 21 }, /limit/],
    [{ workerId: 'w', kinds: ['ingest_asset'], limit: 1, leaseSeconds: 5 }, /leaseSeconds/],
  ])('parseClaim refuses %p', (body, message) => {
    expect(error(parseClaim(body))).toMatch(message)
  })

  it('parseJobRef needs UUIDs and a bounded lease', () => {
    expect(parseJobRef({ ...REF, leaseSeconds: 90 })).toEqual({ ok: true, value: { ...REF, leaseSeconds: 90 } })
    expect(error(parseJobRef({ jobId: 'x', claimToken: IDS.token }))).toMatch(/UUID/)
    expect(error(parseJobRef({ ...REF, leaseSeconds: 1000 }))).toMatch(/leaseSeconds/)
  })

  it('parseCheckpoint refuses credentials, oversize and non-objects', () => {
    expect(parseCheckpoint({ ...REF, checkpoint: { containerId: 'c1' } })).toEqual({ ok: true, value: { ...REF, checkpoint: { containerId: 'c1' } } })
    expect(error(parseCheckpoint({ ...REF, checkpoint: { nested: { access_token: 'x' } } }))).toMatch(/credential/)
    expect(error(parseCheckpoint({ ...REF, checkpoint: { big: 'x'.repeat(70000) } }))).toMatch(/too large/)
    expect(error(parseCheckpoint({ ...REF, checkpoint: [] }))).toMatch(/object/)
    expect(error(parseCheckpoint({ jobId: 'x' }))).toMatch(/UUID/)
  })

  it('parseComplete refuses credentials and oversize results', () => {
    expect(parseComplete({ ...REF, result: { externalId: '1' } })).toMatchObject({ ok: true })
    expect(error(parseComplete({ ...REF, result: { accessToken: 'x' } }))).toMatch(/credential/)
    expect(error(parseComplete({ ...REF, result: { big: 'x'.repeat(270000) } }))).toMatch(/too large/)
    expect(error(parseComplete({ ...REF, result: 'x' }))).toMatch(/object/)
    expect(error(parseComplete({}))).toMatch(/UUID/)
  })

  it('parseFail validates outcome, code, message and request id', () => {
    expect(parseFail({ ...REF, outcome: 'uncertain', errorCode: 'provider_timeout', message: 'Timed out', providerRequestId: 'r1' })).toEqual({
      ok: true,
      value: { ...REF, outcome: 'uncertain', errorCode: 'provider_timeout', message: 'Timed out', providerRequestId: 'r1' },
    })
    expect(parseFail({ ...REF, outcome: 'retry', errorCode: 'x', message: '' })).toMatchObject({ ok: true })
    expect(error(parseFail({ ...REF, outcome: 'maybe', errorCode: 'x', message: '' }))).toMatch(/outcome/)
    expect(error(parseFail({ ...REF, outcome: 'failed', errorCode: 'has space', message: '' }))).toMatch(/errorCode/)
    expect(error(parseFail({ ...REF, outcome: 'failed', errorCode: 'x', message: 5 }))).toMatch(/message/)
    expect(error(parseFail({ ...REF, outcome: 'failed', errorCode: 'x', message: '', providerRequestId: '' }))).toMatch(/providerRequestId/)
    expect(error(parseFail({ jobId: IDS.job }))).toMatch(/UUID/)
  })

  it('containsSecretKey looks at every level', () => {
    expect(containsSecretKey([{ a: { refreshToken: 'x' } }])).toBe(true)
    expect(containsSecretKey({ externalId: '1', list: [1, 'a'] })).toBe(false)
  })
})

describe('validateJobResult', () => {
  const variant = {
    channel: 'linkedin',
    style: 'default',
    body: 'Hi',
    hashtags: ['AI4L'],
    callToAction: null,
    linkUrl: 'https://ai4l.example',
    fields: { subject: 's' },
    violations: [],
    promptVersion: 'p1',
  }

  it('accepts a generation result with partial failures', () => {
    expect(
      validateJobResult('generate_text', {
        variants: [variant],
        failures: [{ channel: 'email', errorCode: 'timeout', message: 'slow' }],
        promptVersion: 'p1',
        model: 'm',
        usage: { tokens: 3 },
        providerRequestId: 'r',
      })
    ).toMatchObject({ ok: true })
  })

  it.each([
    [{ variants: [], failures: [], promptVersion: 'p', model: 'm' }, /1 to 12/],
    [{ variants: [{ ...variant, channel: 'tiktok' }], failures: [], promptVersion: 'p', model: 'm' }, /invalid shape/],
    [{ variants: [{ ...variant, linkUrl: 'http://x' }], failures: [], promptVersion: 'p', model: 'm' }, /invalid shape/],
    [{ variants: [{ ...variant, fields: { a: 1 } }], failures: [], promptVersion: 'p', model: 'm' }, /invalid shape/],
    [{ variants: [variant], failures: [{ channel: 'x' }], promptVersion: 'p', model: 'm' }, /failures/],
    [{ variants: [variant], failures: [], model: 'm' }, /promptVersion/],
    [{ variants: [variant], failures: [], promptVersion: 'p', model: 'm', usage: { tokens: 'x' } }, /usage/],
    [{ variants: [variant], failures: [], promptVersion: 'p', model: 'm', providerRequestId: 5 }, /providerRequestId/],
  ])('refuses a malformed generation result %#', (result, message) => {
    expect(error(validateJobResult('generate_text', result))).toMatch(message)
  })

  it('validates image results', () => {
    const files = { original: FILE, renditions: { social: FILE, email: FILE } }
    expect(validateJobResult('generate_image', { assets: [{ files, alt: 'a' }], model: 'm' })).toMatchObject({ ok: true })
    expect(validateJobResult('generate_image', { assets: [{ files: { original: FILE } }], model: 'm' })).toMatchObject({ ok: true })
    expect(error(validateJobResult('generate_image', { assets: [], model: 'm' }))).toMatch(/1 to 4/)
    expect(error(validateJobResult('generate_image', { assets: [{ files: { original: { ...FILE, mimeType: 'image/gif' } } }], model: 'm' }))).toMatch(
      /invalid file/
    )
    expect(error(validateJobResult('generate_image', { assets: [{ files: { original: FILE, renditions: { thumb: FILE } } }], model: 'm' }))).toMatch(
      /invalid file/
    )
    expect(error(validateJobResult('generate_image', { assets: [{ files: { original: { ...FILE, path: '../x' } } }], model: 'm' }))).toMatch(/invalid file/)
    expect(error(validateJobResult('generate_image', { assets: [{ files: { original: FILE } }] }))).toMatch(/model/)
  })

  it('validates ingest results', () => {
    expect(validateJobResult('ingest_asset', { status: 'ready', files: { original: FILE } })).toMatchObject({ ok: true })
    expect(validateJobResult('ingest_asset', { status: 'rejected', reason: 'Not an image' })).toMatchObject({ ok: true })
    expect(error(validateJobResult('ingest_asset', { status: 'rejected' }))).toMatch(/reason/)
    expect(error(validateJobResult('ingest_asset', { status: 'ready', files: { original: { ...FILE, checksum: 'x' } } }))).toMatch(/files/)
    expect(error(validateJobResult('ingest_asset', { status: 'done' }))).toMatch(/status/)
  })

  it('validates publication results', () => {
    expect(validateJobResult('publish_social', { externalId: '123', permalink: 'https://x.example/p' })).toMatchObject({ ok: true })
    expect(validateJobResult('publish_social', { externalId: '123', permalink: null })).toMatchObject({ ok: true })
    expect(error(validateJobResult('publish_social', { permalink: null }))).toMatch(/externalId/)
    expect(error(validateJobResult('publish_social', { externalId: '1', permalink: 'http://x' }))).toMatch(/permalink/)
    expect(error(validateJobResult('publish_social', 'x'))).toMatch(/object/)
  })
})

describe('engine fixtures (shared/content-contracts/fixtures)', () => {
  const fixture = (name: string) =>
    JSON.parse(readFileSync(join(process.cwd(), 'shared', 'content-contracts', 'fixtures', `${name}.json`), 'utf8')) as unknown

  it.each([
    ['result-generate-text', 'generate_text'],
    ['result-ingest-asset', 'ingest_asset'],
    ['result-ingest-asset-rejected', 'ingest_asset'],
    ['result-publish-social', 'publish_social'],
  ] as const)('accepts %s as a %s result', (name, kind) => {
    expect(validateJobResult(kind, fixture(name))).toMatchObject({ ok: true })
  })

  it('accepts generation warnings and refuses malformed ones', () => {
    const result = fixture('result-generate-text') as Record<string, unknown>
    expect(validateJobResult('generate_text', { ...result, warnings: ['Reference URL could not be read.'] })).toMatchObject({ ok: true })
    expect(error(validateJobResult('generate_text', { ...result, warnings: [1] }))).toMatch(/warnings/)
  })

  it('accepts every job reference in the claim response fixture', () => {
    const { jobs } = fixture('claim-response') as { jobs: { jobId: string; claimToken: string }[] }
    jobs.forEach((job) => expect(parseJobRef({ jobId: job.jobId, claimToken: job.claimToken })).toMatchObject({ ok: true }))
  })
})
