/** @jest-environment node */
import vector from '../../../shared/content-contracts/fixtures/worker-signature.json'

import {
  authenticateWorkerRequest,
  getWorkerSecret,
  MAX_WORKER_BODY_BYTES,
  signWorkerRequest,
  verifyWorkerRequest,
  WORKER_SIGNATURE_HEADER,
  WORKER_TIMESTAMP_HEADER,
} from './workerAuth'

const SECRET = 'a'.repeat(40)
const NOW = 1_800_000_000
const PATH = '/api/internal/content-worker/v1/claim'
const BODY = '{"workerId":"w1","kinds":["ingest_asset"],"limit":1}'

function signed(overrides: Partial<Parameters<typeof verifyWorkerRequest>[0]> = {}) {
  return verifyWorkerRequest({
    method: 'POST',
    path: PATH,
    rawBody: BODY,
    timestampHeader: String(NOW),
    signatureHeader: signWorkerRequest(SECRET, NOW, 'POST', PATH, BODY),
    nowSeconds: NOW,
    secret: SECRET,
    ...overrides,
  })
}

describe('verifyWorkerRequest', () => {
  it('accepts a correctly signed request', () => {
    expect(signed()).toEqual({ ok: true })
  })

  it('fails closed without a configured secret', () => {
    expect(signed({ secret: null })).toEqual({ ok: false, reason: 'secret_not_configured' })
  })

  it('refuses missing headers', () => {
    expect(signed({ signatureHeader: null })).toEqual({ ok: false, reason: 'missing_signature' })
    expect(signed({ timestampHeader: null })).toEqual({ ok: false, reason: 'missing_signature' })
  })

  it('refuses malformed headers', () => {
    expect(signed({ timestampHeader: 'abc' })).toEqual({ ok: false, reason: 'malformed_signature' })
    expect(signed({ signatureHeader: 'v1=zz' })).toEqual({ ok: false, reason: 'malformed_signature' })
  })

  it('refuses a stale or future timestamp', () => {
    expect(signed({ nowSeconds: NOW + 301 })).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' })
    expect(signed({ nowSeconds: NOW - 301 })).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' })
  })

  it.each([
    ['another body', { rawBody: '{"limit":20}' }],
    ['another path', { path: '/api/internal/content-worker/v1/complete' }],
    ['another method', { method: 'PUT' }],
    ['another secret', { secret: 'b'.repeat(40) }],
  ])('refuses a signature replayed onto %s', (_label, overrides) => {
    expect(signed(overrides)).toEqual({ ok: false, reason: 'signature_mismatch' })
  })
})

describe('cross-language vector (services/content-engine/app/signing.py)', () => {
  it('produces the signature the Python worker produces', () => {
    expect(signWorkerRequest(vector.secret, vector.timestamp, vector.method, vector.path, vector.body)).toBe(vector.signature)
  })

  it('verifies the Python-signed request', () => {
    expect(
      verifyWorkerRequest({
        method: vector.method,
        path: vector.path,
        rawBody: vector.body,
        timestampHeader: String(vector.timestamp),
        signatureHeader: vector.signature,
        nowSeconds: vector.timestamp,
        secret: vector.secret,
      }),
    ).toEqual({ ok: true })
  })
})

describe('getWorkerSecret', () => {
  const original = process.env.CONTENT_WORKER_SECRET

  afterEach(() => {
    process.env.CONTENT_WORKER_SECRET = original
  })

  it('ignores a secret shorter than 32 characters', () => {
    process.env.CONTENT_WORKER_SECRET = 'short'
    expect(getWorkerSecret()).toBeNull()
  })

  it('returns a strong secret trimmed', () => {
    process.env.CONTENT_WORKER_SECRET = `  ${SECRET}  `
    expect(getWorkerSecret()).toBe(SECRET)
  })
})

describe('authenticateWorkerRequest', () => {
  const original = process.env.CONTENT_WORKER_SECRET

  afterEach(() => {
    process.env.CONTENT_WORKER_SECRET = original
  })

  it('returns the exact raw body when the signature matches', async () => {
    process.env.CONTENT_WORKER_SECRET = SECRET
    const ts = Math.floor(Date.now() / 1000)
    const request = new Request(`https://crm.test${PATH}`, {
      method: 'POST',
      body: BODY,
      headers: {
        [WORKER_TIMESTAMP_HEADER]: String(ts),
        [WORKER_SIGNATURE_HEADER]: signWorkerRequest(SECRET, ts, 'POST', PATH, BODY),
      },
    })

    await expect(authenticateWorkerRequest(request)).resolves.toEqual({ ok: true, rawBody: BODY })
  })

  it('refuses an oversized body before reading or verifying it', async () => {
    process.env.CONTENT_WORKER_SECRET = SECRET
    const big = 'x'.repeat(MAX_WORKER_BODY_BYTES + 1)
    const declared = new Request(`https://crm.test${PATH}`, { method: 'POST', body: big })

    await expect(authenticateWorkerRequest(declared)).resolves.toEqual({ ok: false, reason: 'body_too_large' })
  })

  it('refuses a streamed body that grows past the cap without a length header', async () => {
    process.env.CONTENT_WORKER_SECRET = SECRET
    const chunk = new TextEncoder().encode('x'.repeat(64 * 1024))
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_WORKER_BODY_BYTES) return controller.close()
        sent += chunk.byteLength
        controller.enqueue(chunk)
      },
    })
    const request = new Request(`https://crm.test${PATH}`, { method: 'POST', body: stream, duplex: 'half' } as RequestInit)

    await expect(authenticateWorkerRequest(request)).resolves.toEqual({ ok: false, reason: 'body_too_large' })
  })

  it('reads an empty body as the empty string', async () => {
    process.env.CONTENT_WORKER_SECRET = SECRET
    const ts = Math.floor(Date.now() / 1000)
    const request = new Request(`https://crm.test${PATH}`, {
      method: 'POST',
      headers: {
        [WORKER_TIMESTAMP_HEADER]: String(ts),
        [WORKER_SIGNATURE_HEADER]: signWorkerRequest(SECRET, ts, 'POST', PATH, ''),
      },
    })

    await expect(authenticateWorkerRequest(request)).resolves.toEqual({ ok: true, rawBody: '' })
  })

  it('reports why an unsigned request was refused', async () => {
    process.env.CONTENT_WORKER_SECRET = SECRET
    const request = new Request(`https://crm.test${PATH}`, { method: 'POST', body: BODY })

    await expect(authenticateWorkerRequest(request)).resolves.toEqual({ ok: false, reason: 'missing_signature' })
  })
})
