import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ApiError } from './api'
import PublishDialog, { describePublishError } from './PublishDialog'
import { errorResponse, jsonResponse, makeAccount, makeAsset, makePublication, makeRevision, makeVariant, routeFetch } from './testUtils'

const ACCOUNTS = '/api/social/accounts'
const PREFLIGHT = '/api/social/publications/preflight'
const PUBLICATIONS = '/api/social/publications'

const approved = makeVariant({ current: makeRevision({ review: 'approved', assets: [{ assetId: 'asset-1', alt: 'Room', order: 0 }] }) })

function preflight(overrides = {}) {
  return jsonResponse({
    preflight: {
      ok: true,
      platform: 'facebook',
      composedText: 'Join our workshop next Tuesday.\n\nBook now\n\n#workshop',
      limits: { maxChars: 63206, maxHashtags: 30, maxImages: 10, requiresImage: false },
      issues: [],
      ...overrides,
    },
  })
}

function accounts(list = [makeAccount(), makeAccount({ id: 'acct-2', displayName: 'Second Page' })], enabledPlatforms = ['facebook']) {
  return jsonResponse({ accounts: list, enabledPlatforms })
}

async function waitForPublishReady() {
  const button = await screen.findByRole('button', { name: 'Publish to Facebook…' })
  await waitFor(() => expect(button).toBeEnabled())
}

async function armPublish() {
  const button = await screen.findByRole('button', { name: 'Publish to Facebook…' })
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)
}

function renderDialog(variant = approved, extra = {}) {
  const props = { onClose: jest.fn(), onPublished: jest.fn(), ...extra }
  render(<PublishDialog variant={variant} assets={[makeAsset()]} {...props} />)
  return props
}

describe('PublishDialog', () => {
  it('runs preflight for the first connected account and shows the exact text', async () => {
    const mock = routeFetch({ [`GET ${ACCOUNTS}`]: accounts(), [`POST ${PREFLIGHT}`]: preflight() })
    renderDialog()

    expect(await screen.findByText(/Exactly what will be sent · 52 \/ 63,206 characters/)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /AI4L Page/ })).toBeChecked()
    expect(screen.getByRole('img', { name: 'Room' })).toBeInTheDocument()
    const request = JSON.parse(String(mock.mock.calls.find(([url]) => url === PREFLIGHT)?.[1].body))
    expect(request).toMatchObject({ revisionId: 'rev-1', accountId: 'acct-1' })
  })

  it('requires a named confirmation, then publishes and shows the result', async () => {
    const mock = routeFetch({
      [`GET ${ACCOUNTS}`]: accounts(),
      [`POST ${PREFLIGHT}`]: preflight(),
      [`POST ${PUBLICATIONS}`]: jsonResponse({ publication: makePublication() }, 202),
    })
    const { onPublished, onClose } = renderDialog()

    await armPublish()
    expect(screen.getByText((_, element) => element?.tagName === 'SPAN' && /now\? This cannot be undone/.test(element.textContent ?? ''))).toHaveTextContent(
      'Publish to AI4L Page on Facebook now?'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Not yet' }))
    await armPublish()
    fireEvent.click(screen.getByRole('button', { name: 'Yes, publish to AI4L Page' }))

    expect(await screen.findByText('Published to Facebook.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View the post ↗' })).toHaveAttribute('href', 'https://facebook.com/post/1')
    expect(onPublished).toHaveBeenCalled()
    expect(JSON.parse(String(mock.mock.calls.find(([url]) => url === PUBLICATIONS)?.[1].body))).toMatchObject({ revisionId: 'rev-1', accountId: 'acct-1' })

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('re-checks when another account is chosen', async () => {
    const mock = routeFetch({ [`GET ${ACCOUNTS}`]: accounts(), [`POST ${PREFLIGHT}`]: preflight() })
    renderDialog()
    await screen.findByText(/Exactly what will be sent/)

    fireEvent.click(screen.getByRole('radio', { name: /Second Page/ }))

    await waitFor(() => expect(mock.mock.calls.filter(([url]) => url === PREFLIGHT)).toHaveLength(2))
    const second = JSON.parse(String(mock.mock.calls.filter(([url]) => url === PREFLIGHT)[1][1].body))
    expect(second.accountId).toBe('acct-2')
  })

  it('blocks publishing on a blocking issue and lists warnings', async () => {
    routeFetch({
      [`GET ${ACCOUNTS}`]: accounts(),
      [`POST ${PREFLIGHT}`]: preflight({
        ok: false,
        issues: [
          { code: 'too_long', message: 'Over the limit', blocking: true },
          { code: 'no_link', message: 'No link', blocking: false },
        ],
      }),
    })
    renderDialog()

    expect(await screen.findByText('Over the limit')).toBeInTheDocument()
    expect(screen.getByText('No link')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Publish to Facebook…' })).toBeDisabled()
  })

  it('explains a platform that is switched off', async () => {
    routeFetch({ [`GET ${ACCOUNTS}`]: accounts([makeAccount()], []), [`POST ${PREFLIGHT}`]: preflight() })
    renderDialog()
    expect(await screen.findByText(/Publishing to Facebook is switched off/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Publish to Facebook…' })).toBeDisabled()
  })

  it('explains that social publishing is not deployed yet', async () => {
    routeFetch({})
    renderDialog()
    expect(await screen.findByText('Social publishing is not available in this CRM yet.')).toBeInTheDocument()
  })

  it('reports an account load failure', async () => {
    routeFetch({ [`GET ${ACCOUNTS}`]: errorResponse(500, 'Accounts broke') })
    renderDialog()
    expect(await screen.findByText('Accounts broke')).toBeInTheDocument()
  })

  it('points to Settings when no account is connected, and flags ones needing reauth', async () => {
    routeFetch({ [`GET ${ACCOUNTS}`]: accounts([]) })
    const onOpenSettings = jest.fn()
    const { unmount } = render(<PublishDialog variant={approved} assets={[]} onClose={jest.fn()} onPublished={jest.fn()} onOpenSettings={onOpenSettings} />)
    expect(await screen.findByText(/No Facebook account is connected/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open connections in Settings' }))
    expect(onOpenSettings).toHaveBeenCalled()
    unmount()

    routeFetch({
      [`GET ${ACCOUNTS}`]: accounts([makeAccount({ status: 'needs_reauth' }), makeAccount({ id: 'x', status: 'disconnected', displayName: 'Gone', authorKind: 'instagram_business' })]),
    })
    renderDialog(approved, { onOpenSettings })
    expect(await screen.findByText(/needs reconnecting/)).toBeInTheDocument()
    expect(screen.getByText(/instagram business · disconnected/)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /AI4L Page/ })).toBeDisabled()
  })

  it('shows a preflight error and checks again', async () => {
    const responses = [errorResponse(500, 'Rules unavailable'), preflight()]
    routeFetch({ [`GET ${ACCOUNTS}`]: accounts(), [`POST ${PREFLIGHT}`]: () => responses.shift() ?? preflight() })
    renderDialog()

    expect(await screen.findByText(/Rules unavailable/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByText(/Exactly what will be sent/)).toBeInTheDocument()
  })

  it('keeps the idempotency key on a retried publish and re-runs preflight when it failed', async () => {
    const responses = [errorResponse(422, 'Image missing', 'preflight_failed'), jsonResponse({ publication: makePublication({ status: 'queued', permalink: null }) }, 202)]
    const mock = routeFetch({
      [`GET ${ACCOUNTS}`]: accounts(),
      [`POST ${PREFLIGHT}`]: preflight(),
      [`POST ${PUBLICATIONS}`]: () => responses.shift() ?? jsonResponse({}),
    })
    renderDialog()

    await armPublish()
    fireEvent.click(screen.getByRole('button', { name: 'Yes, publish to AI4L Page' }))
    expect(await screen.findByText('The post no longer passes the checks: Image missing')).toBeInTheDocument()
    await waitFor(() => expect(mock.mock.calls.filter(([url]) => url === PREFLIGHT).length).toBeGreaterThanOrEqual(2))

    await armPublish()
    fireEvent.click(screen.getByRole('button', { name: 'Yes, publish to AI4L Page' }))
    expect(await screen.findByText(/Queued\. Publishing runs in the background/)).toBeInTheDocument()

    const keys = mock.mock.calls.filter(([url]) => url === PUBLICATIONS).map(([, init]) => JSON.parse(String(init.body)).idempotencyKey)
    expect(keys[0]).toBe(keys[1])
  })

  it('explains an uncertain publication', async () => {
    routeFetch({
      [`GET ${ACCOUNTS}`]: accounts(),
      [`POST ${PREFLIGHT}`]: preflight(),
      [`POST ${PUBLICATIONS}`]: jsonResponse({ publication: makePublication({ status: 'uncertain', permalink: null, errorMessage: 'Timeout' }) }, 202),
    })
    renderDialog()
    await armPublish()
    fireEvent.click(screen.getByRole('button', { name: 'Yes, publish to AI4L Page' }))
    expect(await screen.findByText(/did not confirm the result/)).toBeInTheDocument()
    expect(screen.getByText('Timeout')).toBeInTheDocument()
  })

  it('refuses email variants', async () => {
    const mock = routeFetch({ [`GET ${ACCOUNTS}`]: accounts() })
    renderDialog(makeVariant({ channel: 'email' }))
    expect(screen.getByText('Email variants are not published to a social network.')).toBeInTheDocument()
    await waitFor(() => expect(mock).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Publish to Email…' })).toBeDisabled()
  })

  it('maps publish error codes to guidance', () => {
    expect(describePublishError(new ApiError('x', 409, 'already_published'))).toMatch(/already published/)
    expect(describePublishError(new ApiError('x', 409, 'not_approved'))).toMatch(/no longer approved/)
    expect(describePublishError(new ApiError('x', 409, 'account_not_connected'))).toMatch(/Reconnect/)
    expect(describePublishError(new ApiError('Other', 500))).toBe('Other')
    expect(describePublishError(null)).toBe('Publishing failed.')
  })

  it('does not show the first account preflight as the second one when the new check fails', async () => {
    const responses = [preflight(), errorResponse(500, 'Check failed for B')]
    routeFetch({ [`GET ${ACCOUNTS}`]: accounts(), [`POST ${PREFLIGHT}`]: () => responses.shift() ?? preflight() })
    renderDialog()
    await waitForPublishReady()

    fireEvent.click(screen.getByRole('radio', { name: /Second Page/ }))

    expect(await screen.findByText(/Check failed for B/)).toBeInTheDocument()
    expect(screen.queryByText(/Exactly what will be sent/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Publish to Facebook…' })).toBeDisabled()
  })
})
