import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import CreateEmailDialog, { type EmailProposal } from './CreateEmailDialog'
import EmailPreview from './EmailPreview'
import { bodyOf, errorResponse, jsonResponse, routeFetch } from './testUtils'

const VARIANT = 'var-1'
const DRAFT = `/api/content-studio/variants/${VARIANT}/email-draft`
const EXPORT = `/api/content-studio/variants/${VARIANT}/email-export`

const PROPOSAL: EmailProposal = {
  variantId: VARIANT,
  itemId: 'item-1',
  itemTitle: 'May workshop',
  revisionId: 'rev-1',
  adaptation: {
    subject: 'May workshop',
    fields: { Preheader: 'Twenty seats', Headline: 'Workshop on 14 May', Intro: 'Join us.', Body: 'Twenty seats.', CtaLabel: 'Save a seat' },
    ctaUrl: 'https://ai4l.com.au/workshop',
    ctaMode: 'external_url',
    notes: ['Hashtags and social-only phrases (such as "link in bio") were removed.'],
  },
  assets: [{ assetId: 'asset-1', alt: 'Room', previewUrl: 'https://proj.supabase.co/storage/v1/object/sign/x.jpg?token=t', width: 1200, height: 800, ready: true }],
}

const TEMPLATES = [
  { id: 'tpl-legacy', name: 'Classic', contract_id: 'legacy-v1', contract_version: 1, archived_at: null },
  { id: 'tpl-static', name: 'Static', contract_id: 'studio-static-v1', contract_version: 1, archived_at: null },
  { id: 'tpl-old', name: 'Retired', contract_id: 'studio-static-v1', contract_version: 1, archived_at: '2026-01-01' },
  { id: 'tpl-future', name: 'Future', contract_id: 'studio-static-v1', contract_version: 2, archived_at: null },
]

function mount(extra: Record<string, unknown> = {}) {
  const fetchMock = routeFetch({
    [`GET ${DRAFT}`]: jsonResponse({ proposal: PROPOSAL }),
    'GET /api/templates': jsonResponse({ templates: TEMPLATES }),
    'GET /api/segments': jsonResponse({ segments: [{ id: 'seg-1', name: 'Trainers' }] }),
    [`POST ${DRAFT}`]: jsonResponse({ campaignId: 'camp-9', snapshotId: 's', created: true }, 201),
    [`POST ${EXPORT}`]: jsonResponse({ html: '<html>x</html>', text: 'plain', snapshotId: 's2' }, 201),
    ...extra,
  })
  const props = { onClose: jest.fn(), onCreated: jest.fn() }
  render(<CreateEmailDialog variantId={VARIANT} {...props} />)
  return { fetchMock, props }
}

describe('CreateEmailDialog', () => {
  beforeAll(() => {
    URL.createObjectURL = jest.fn(() => 'blob:x')
    URL.revokeObjectURL = jest.fn()
    Object.assign(navigator, { clipboard: { writeText: jest.fn(async () => undefined) } })
  })

  it('says the draft still needs its own approval', async () => {
    mount()
    expect(screen.getByText(/Approving a post does not authorise sending an email/)).toBeInTheDocument()
    expect(await screen.findByDisplayValue('Workshop on 14 May')).toBeInTheDocument()
  })

  it('offers only active Studio templates and shows the adaptation notes', async () => {
    mount()
    await screen.findByDisplayValue('Workshop on 14 May')

    const options = screen.getAllByRole('option').map((option) => option.textContent)
    expect(options).toContain('Static (studio-static-v1)')
    expect(options).not.toContain('Classic (legacy-v1)')
    expect(options.join(' ')).not.toMatch(/Retired|Future/)
    expect(screen.getByText(/link in bio/)).toBeInTheDocument()
  })

  it('previews locally, labelled as such, with an images-off toggle', async () => {
    mount()
    await screen.findByDisplayValue('Workshop on 14 May')

    expect(screen.getByText(/Local render by the CRM/)).toBeInTheDocument()
    const frame = screen.getByTestId('email-preview-frame')
    expect(frame.getAttribute('srcdoc')).toContain('<img')
    fireEvent.click(screen.getByLabelText('Images blocked'))
    expect(screen.getByTestId('email-preview-frame').getAttribute('srcdoc')).not.toContain('<img')
  })

  it('creates a draft campaign with the chosen template, segment and image', async () => {
    const { fetchMock, props } = mount()
    await screen.findByDisplayValue('Workshop on 14 May')

    const create = screen.getByRole('button', { name: 'Create draft campaign' })
    expect(create).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Template'), { target: { value: 'tpl-static' } })
    fireEvent.change(screen.getByLabelText('Segment'), { target: { value: 'seg-1' } })
    fireEvent.click(create)

    await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith('camp-9'))
    expect(bodyOf(fetchMock, 'POST', DRAFT)).toMatchObject({
      revisionId: 'rev-1',
      templateId: 'tpl-static',
      segmentId: 'seg-1',
      campaignName: 'May workshop (email)',
      subject: 'May workshop',
      ctaMode: 'external_url',
      ctaUrl: 'https://ai4l.com.au/workshop',
      assets: [{ assetId: 'asset-1', alt: 'Room' }],
      idempotencyKey: expect.any(String),
    })
    expect(await screen.findByText(/Review and approve it in Campaigns/)).toBeInTheDocument()
  })

  it('exports HTML, copies the text, and says it is not a delivery', async () => {
    const { fetchMock } = mount()
    await screen.findByDisplayValue('Workshop on 14 May')

    fireEvent.click(screen.getByLabelText('No image'))
    fireEvent.click(screen.getByRole('button', { name: 'Export HTML' }))

    expect(await screen.findByText(/An export is not a delivery/)).toBeInTheDocument()
    expect(bodyOf(fetchMock, 'POST', EXPORT)).toMatchObject({ assets: [], ctaMode: 'external_url' })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('plain')
    expect(URL.createObjectURL).toHaveBeenCalled()
  })

  it('reuses a key only for the same payload: an edited re-export is a new request', async () => {
    const { fetchMock } = mount()
    await screen.findByDisplayValue('Workshop on 14 May')
    const exportButton = screen.getByRole('button', { name: 'Export HTML' })
    const keys = () =>
      fetchMock.mock.calls
        .filter(([url, init]) => String(url) === EXPORT && init?.method === 'POST')
        .map(([, init]) => JSON.parse(String(init?.body)).idempotencyKey)

    fireEvent.click(exportButton)
    await screen.findByText(/An export is not a delivery/)
    fireEvent.click(exportButton)
    await waitFor(() => expect(keys()).toHaveLength(2))
    expect(keys()[1]).toBe(keys()[0])

    fireEvent.change(screen.getByDisplayValue('Workshop on 14 May'), { target: { value: 'Workshop moved to 21 May' } })
    fireEvent.click(exportButton)
    await waitFor(() => expect(keys()).toHaveLength(3))
    expect(keys()[2]).not.toBe(keys()[0])
  })

  it('shows a server refusal and a render problem', async () => {
    mount({ [`POST ${EXPORT}`]: errorResponse(422, 'CtaUrl must be an https link.') })
    await screen.findByDisplayValue('Workshop on 14 May')

    fireEvent.click(screen.getByRole('button', { name: 'Export HTML' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('CtaUrl must be an https link.')

    fireEvent.change(screen.getByLabelText('Button link (https)'), { target: { value: 'http://insecure' } })
    expect(screen.getByText('The button link must be an https link.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export HTML' })).toBeDisabled()
  })

  it('hides the button label when there is no button', async () => {
    mount()
    await screen.findByDisplayValue('Workshop on 14 May')
    fireEvent.change(screen.getByLabelText('Button'), { target: { value: 'none' } })
    expect(screen.queryByDisplayValue('Save a seat')).not.toBeInTheDocument()
  })

  it('reports a proposal that cannot be loaded', async () => {
    mount({ [`GET ${DRAFT}`]: errorResponse(404, 'Creating emails from the Content Studio is not enabled.', 'feature_disabled') })
    expect(await screen.findByRole('alert')).toHaveTextContent('not enabled')
  })
})

describe('EmailPreview', () => {
  it('renders sandboxed without a toggle when there is no images-off version', () => {
    render(<EmailPreview html="<p>Hello</p>" />)
    const frame = screen.getByTestId('email-preview-frame')
    expect(frame).toHaveAttribute('sandbox', '')
    expect(frame.getAttribute('srcdoc')).toBe('<p>Hello</p>')
    expect(screen.queryByLabelText('Images blocked')).not.toBeInTheDocument()
  })
})
