import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import VariantEditor, { contentFromDraft } from './VariantEditor'
import { bodyOf, errorResponse, jsonResponse, makeAsset, makeRevision, makeVariant, routeFetch } from './testUtils'

const REVISIONS = '/api/content-studio/variants/var-1/revisions'

function renderEditor(variant = makeVariant(), handlers = {}) {
  const props = { onSaved: jest.fn(), onReload: jest.fn(), onCancel: jest.fn() }
  const mock = routeFetch(handlers)
  const view = render(<VariantEditor variant={variant} assets={[makeAsset()]} {...props} />)
  return { ...props, mock, view }
}

describe('contentFromDraft', () => {
  it('trims, parses hashtags and nulls empty CTA and link', () => {
    expect(
      contentFromDraft({ body: ' b ', hashtags: 'one #two', callToAction: ' ', linkUrl: '', fields: { subject: ' s ' }, assets: [] }, true)
    ).toEqual({ body: 'b', hashtags: ['#one', '#two'], callToAction: null, linkUrl: null, fields: { subject: 's' }, assets: [] })
  })

  it('leaves fields untouched for social channels', () => {
    const fields = { anything: ' kept ' }
    expect(contentFromDraft({ body: '', hashtags: '', callToAction: '', linkUrl: '', fields, assets: [] }, false).fields).toBe(fields)
  })
})

describe('VariantEditor', () => {
  it('saves a new revision naming the revision it was based on', async () => {
    const { mock, onSaved } = renderEditor(makeVariant(), { [`POST ${REVISIONS}`]: jsonResponse({ revision: makeRevision({ id: 'rev-2' }) }, 201) })

    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'New body' } })
    fireEvent.change(screen.getByLabelText('Hashtags'), { target: { value: '#a b' } })
    fireEvent.change(screen.getByLabelText('Call to action'), { target: { value: 'Call us' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add workshop.jpg' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save revision' }))

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(bodyOf(mock, 'POST', REVISIONS)).toMatchObject({
      expectedRevisionId: 'rev-1',
      content: {
        body: 'New body',
        hashtags: ['#a', '#b'],
        callToAction: 'Call us',
        linkUrl: 'https://example.com/book',
        assets: [{ assetId: 'asset-1', alt: 'People at a workshop', order: 0 }],
      },
    })
  })

  it('refuses a non-https link before saving', () => {
    const { mock } = renderEditor()

    fireEvent.change(screen.getByLabelText('Link'), { target: { value: 'http://insecure.test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save revision' }))

    expect(screen.getByText('Use a full https:// address.')).toBeInTheDocument()
    expect(mock).not.toHaveBeenCalled()
  })

  it('keeps the draft on a stale revision and saves against the newer one after reload', async () => {
    const responses = [errorResponse(409, 'Stale', 'stale_revision'), jsonResponse({ revision: {} }, 201)]
    const { mock, onReload, onSaved, view } = renderEditor(makeVariant(), { [`POST ${REVISIONS}`]: () => responses.shift() ?? jsonResponse({}) })

    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'My careful edit' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save revision' }))

    expect(await screen.findByText(/nothing was lost/)).toBeInTheDocument()
    expect(screen.getByLabelText('Body')).toHaveValue('My careful edit')
    fireEvent.click(screen.getByRole('button', { name: 'Load the latest revision' }))
    expect(onReload).toHaveBeenCalled()

    const newer = makeRevision({ id: 'rev-3', revisionNumber: 3, body: 'Someone else wrote this' })
    view.rerender(
      <VariantEditor variant={makeVariant({ current: newer })} assets={[]} onSaved={onSaved} onReload={onReload} onCancel={jest.fn()} />
    )
    expect(screen.getByText(/Revision 3 is now the latest/)).toBeInTheDocument()
    expect(screen.getByText('Someone else wrote this')).toBeInTheDocument()
    expect(screen.getByLabelText('Body')).toHaveValue('My careful edit')

    fireEvent.click(screen.getByRole('button', { name: 'Save revision' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const saves = mock.mock.calls.map(([, init]) => JSON.parse(String(init.body)))
    expect(saves[1].expectedRevisionId).toBe('rev-3')
    expect(saves[1].idempotencyKey).not.toBe(saves[0].idempotencyKey)
  })

  it('shows other save errors', async () => {
    renderEditor(makeVariant(), { [`POST ${REVISIONS}`]: errorResponse(500, 'Write failed') })
    fireEvent.click(screen.getByRole('button', { name: 'Save revision' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Write failed')
  })

  it('edits the structured email fields', async () => {
    const variant = makeVariant({ channel: 'email', current: makeRevision({ fields: { subject: 'Hello' } }) })
    const { mock } = renderEditor(variant, { [`POST ${REVISIONS}`]: jsonResponse({ revision: {} }, 201) })

    expect(screen.getByLabelText('Subject')).toHaveValue('Hello')
    fireEvent.change(screen.getByLabelText('Preheader'), { target: { value: 'Peek' } })
    fireEvent.change(screen.getByLabelText('Intro'), { target: { value: 'Intro text' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save revision' }))

    await waitFor(() => expect(bodyOf(mock, 'POST', REVISIONS)).toMatchObject({ content: { fields: { subject: 'Hello', preheader: 'Peek', intro: 'Intro text' } } }))
  })

  it('cancels', () => {
    const { onCancel } = renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('starts empty for a variant with no revision', () => {
    renderEditor(makeVariant({ current: null }))
    expect(screen.getByLabelText('Body')).toHaveValue('')
  })
})
