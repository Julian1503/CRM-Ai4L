import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { ApiError } from './api'
import VariantCard, { describeActionError } from './VariantCard'
import { bodyOf, errorResponse, jsonResponse, makeAsset, makeJob, makeRevision, makeVariant, routeFetch } from './testUtils'

const REVIEW = '/api/content-studio/variants/var-1/review'
const GENERATE = '/api/content-studio/items/item-1/generate'
const DUPLICATE = '/api/content-studio/variants/var-1/duplicate'
const VARIANT = '/api/content-studio/variants/var-1'

function renderCard(variant = makeVariant(), extra: Partial<Parameters<typeof VariantCard>[0]> = {}) {
  const onChanged = jest.fn()
  render(<VariantCard itemId="item-1" variant={variant} assets={[makeAsset()]} onChanged={onChanged} {...extra} />)
  return onChanged
}

describe('VariantCard', () => {
  it('shows the current revision with its review state, number and content', () => {
    routeFetch({})
    renderCard(
      makeVariant({
        current: makeRevision({ revisionNumber: 4, origin: 'edited', violations: ['Over 280 characters'], assets: [{ assetId: 'asset-1', alt: 'Room', order: 0 }] }),
        conflictOfRevisionId: 'rev-0',
      })
    )

    expect(screen.getByText('Pending review')).toBeInTheDocument()
    expect(screen.getByText(/Revision 4 · edited/)).toBeInTheDocument()
    expect(screen.getByText('Join our workshop next Tuesday.')).toBeInTheDocument()
    expect(screen.getByText('Over 280 characters')).toBeInTheDocument()
    expect(screen.getByText(/late generation result/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'https://example.com/book' })).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByRole('img', { name: 'Room' })).toBeInTheDocument()
  })

  it('approves the current revision', async () => {
    const mock = routeFetch({ [`POST ${REVIEW}`]: jsonResponse({ review: {} }, 201) })
    const onChanged = renderCard()

    fireEvent.click(screen.getByRole('button', { name: 'Approve revision 1' }))

    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(bodyOf(mock, 'POST', REVIEW)).toEqual({ revisionId: 'rev-1', decision: 'approved' })
  })

  it('requires a reason to reject', async () => {
    const mock = routeFetch({ [`POST ${REVIEW}`]: jsonResponse({ review: {} }, 201) })
    const onChanged = renderCard()

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    const dialog = screen.getByRole('dialog', { name: 'Reject this revision?' })
    expect(document.activeElement).toBe(within(dialog).getByLabelText('Reason'))

    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject revision' }))
    expect(within(dialog).getByText('Reason is required.')).toBeInTheDocument()
    expect(mock).not.toHaveBeenCalled()

    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Wrong date' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject revision' }))

    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(bodyOf(mock, 'POST', REVIEW)).toEqual({ revisionId: 'rev-1', decision: 'rejected', reason: 'Wrong date' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows a rejected revision with its reason and offers publish only once approved', () => {
    routeFetch({})
    const onPublish = jest.fn()
    renderCard(makeVariant({ current: makeRevision({ review: 'rejected', reviewReason: 'Too long' }) }), { onPublish })
    expect(screen.getByText('Rejected: Too long')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Publish…' })).not.toBeInTheDocument()
  })

  it('opens publishing for an approved social revision', () => {
    routeFetch({})
    const onPublish = jest.fn()
    const variant = makeVariant({ current: makeRevision({ review: 'approved' }) })
    renderCard(variant, { onPublish })

    expect(screen.getByText('Approved')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Publish…' }))
    expect(onPublish).toHaveBeenCalledWith(variant)
  })

  it('regenerates with an optional instruction and reports failures in the dialog', async () => {
    const responses = [errorResponse(503, 'Engine busy'), jsonResponse({ job: makeJob() }, 202)]
    const mock = routeFetch({ [`POST ${GENERATE}`]: () => responses.shift() ?? jsonResponse({}) })
    const onChanged = renderCard()

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
    const dialog = screen.getByRole('dialog', { name: 'Regenerate this variant' })
    fireEvent.change(within(dialog).getByLabelText('Instruction (optional)'), { target: { value: 'Shorter' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Regenerate' }))
    expect(await within(dialog).findByText('Engine busy')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Regenerate' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())

    const bodies = mock.mock.calls.map(([, init]) => JSON.parse(String(init.body)))
    expect(bodies[0]).toMatchObject({ channels: ['facebook'], variantId: 'var-1', baseRevisionId: 'rev-1', instruction: 'Shorter' })
    expect(bodies[0].idempotencyKey).toBe(bodies[1].idempotencyKey)
  })

  it('closes the prompt with Escape and returns focus to the opener', () => {
    routeFetch({})
    renderCard()
    const opener = screen.getByRole('button', { name: 'Regenerate' })
    opener.focus()
    fireEvent.click(opener)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(opener)
  })

  it('duplicates and archives', async () => {
    const mock = routeFetch({
      [`POST ${DUPLICATE}`]: jsonResponse({ variant: makeVariant({ id: 'var-2' }) }, 201),
      [`PATCH ${VARIANT}`]: jsonResponse({}),
    })
    const onChanged = renderCard()

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(bodyOf(mock, 'POST', DUPLICATE)).toHaveProperty('idempotencyKey')

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2))
    expect(bodyOf(mock, 'PATCH', VARIANT)).toEqual({ archived: true })
  })

  it('reports a failed duplicate', async () => {
    routeFetch({ [`POST ${DUPLICATE}`]: errorResponse(500, 'Nope') })
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Nope')
  })

  it('copies the composed text and reports clipboard failures', async () => {
    routeFetch({})
    const writeText = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'))
    Object.assign(navigator, { clipboard: { writeText } })
    renderCard()

    fireEvent.click(screen.getByRole('button', { name: 'Copy text' }))
    expect(await screen.findByText('Copied to the clipboard.')).toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith('Join our workshop next Tuesday.\n\nBook now\n\n#workshop')

    fireEvent.click(screen.getByRole('button', { name: 'Copy text' }))
    expect(await screen.findByText('Could not copy to the clipboard.')).toBeInTheDocument()
  })

  it('toggles a social preview', () => {
    routeFetch({})
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.getByRole('figure', { name: 'Facebook preview' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Hide preview' }))
    expect(screen.queryByRole('figure')).not.toBeInTheDocument()
  })

  it('opens the editor and closes it after a save', async () => {
    routeFetch({ ['POST /api/content-studio/variants/var-1/revisions']: jsonResponse({ revision: {} }, 201) })
    const onChanged = renderCard()

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('form', { name: 'Edit variant' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('form')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save revision' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
  })

  it('reserves Create email, enabled only when wired', () => {
    routeFetch({})
    renderCard()
    expect(screen.getByRole('button', { name: 'Create email' })).toBeDisabled()
  })

  it('hands the revision to the email hook when provided, and shows email fields', () => {
    routeFetch({})
    const onCreateEmail = jest.fn()
    renderCard(makeVariant({ channel: 'email', current: makeRevision({ fields: { subject: 'Hello there' }, callToAction: null, linkUrl: null, hashtags: [] }) }), {
      onCreateEmail,
    })

    expect(screen.getByText('Hello there')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create email' }))
    expect(onCreateEmail).toHaveBeenCalledWith('var-1', 'rev-1')
  })

  it('handles a variant without a revision', () => {
    routeFetch({})
    renderCard(makeVariant({ current: null }))
    expect(screen.getByText('No revision yet')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeInTheDocument()
  })

  it('shows an image placeholder when the preview URL is missing', () => {
    routeFetch({})
    render(
      <VariantCard
        itemId="item-1"
        variant={makeVariant({ current: makeRevision({ assets: [{ assetId: 'gone', alt: '', order: 0 }] }) })}
        assets={[]}
        onChanged={jest.fn()}
      />
    )
    expect(screen.getByRole('img', { name: 'Image' })).toBeInTheDocument()
  })

  it('explains blocked content and archived refusals on approve', async () => {
    const responses = [errorResponse(422, 'The price claim is not in the approved facts', 'blocked_content'), errorResponse(409, 'Archived', 'archived')]
    routeFetch({ [`POST ${REVIEW}`]: () => responses.shift() ?? jsonResponse({}) })
    renderCard()

    fireEvent.click(screen.getByRole('button', { name: 'Approve revision 1' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Edit this text before approving: The price claim is not in the approved facts')

    fireEvent.click(screen.getByRole('button', { name: 'Approve revision 1' }))
    expect(await screen.findByText(/is archived\. Restore the item/)).toBeInTheDocument()
  })

  it('maps a stale revision on review to a reload hint', () => {
    expect(describeActionError(new ApiError('x', 409, 'stale_revision'), 'f')).toMatch(/newer revision/)
    expect(describeActionError(new Error('plain'), 'f')).toBe('plain')
  })
})
