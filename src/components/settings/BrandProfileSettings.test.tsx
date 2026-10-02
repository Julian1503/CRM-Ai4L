import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import type { BrandProfile } from '@/lib/content-studio/types'

import BrandProfileSettings, { toDraft, toUpdate } from './BrandProfileSettings'

const mockFetch = jest.fn()
global.fetch = mockFetch as unknown as typeof fetch

const BRAND: BrandProfile = {
  id: 'b1',
  slug: 'ai4l',
  name: 'AI4L',
  tone: 'Clear and warm',
  audience: 'Small businesses',
  region: 'AU',
  approvedFacts: [{ id: 'f1', text: 'Founded in 2020', source: 'About page' }],
  channelRules: { linkedin: { cta: 'Book a call', structure: 'Hook, value, ask' } },
  hashtagSeeds: ['AI4L', 'Automation'],
  imageDirection: 'Real people, natural light',
  allowedLinkOrigins: ['https://ai4l.example'],
}

function respond(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }
}

beforeEach(() => mockFetch.mockReset())

describe('BrandProfileSettings', () => {
  it('shows the profile to an administrator and saves the whole edited profile', async () => {
    mockFetch.mockResolvedValueOnce(respond({ brand: BRAND, canEdit: true }))
    render(<BrandProfileSettings />)

    expect(await screen.findByLabelText('Brand name')).toHaveValue('AI4L')
    expect(screen.getByLabelText('Hashtag seeds')).toHaveValue('#AI4L #Automation')
    expect(screen.getByLabelText('LinkedIn call to action')).toHaveValue('Book a call')
    expect(screen.getByText(/blocked until a person edits it/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Tone of voice'), { target: { value: 'Plain, no hype' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add fact' }))
    fireEvent.change(screen.getByLabelText('Fact 2'), { target: { value: 'Workshops run monthly' } })
    fireEvent.change(screen.getByLabelText('Allowed link origins'), { target: { value: 'https://ai4l.example\nhttps://book.ai4l.example' } })

    mockFetch.mockResolvedValueOnce(respond({ brand: { ...BRAND, tone: 'Plain, no hype' }, canEdit: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Save brand profile' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Brand profile saved')
    const [url, init] = mockFetch.mock.calls[1]
    expect(url).toBe('/api/content-studio/brand')
    expect(init.method).toBe('PATCH')
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({
      tone: 'Plain, no hype',
      hashtagSeeds: ['AI4L', 'Automation'],
      allowedLinkOrigins: ['https://ai4l.example', 'https://book.ai4l.example'],
      channelRules: { linkedin: { cta: 'Book a call', structure: 'Hook, value, ask' } },
    })
    expect(body.approvedFacts).toEqual([
      { id: 'f1', text: 'Founded in 2020', source: 'About page' },
      expect.objectContaining({ text: 'Workshops run monthly' }),
    ])
  })

  it('removes a fact', async () => {
    mockFetch.mockResolvedValueOnce(respond({ brand: BRAND, canEdit: true }))
    render(<BrandProfileSettings />)

    fireEvent.click(await screen.findByRole('button', { name: 'Remove fact 1' }))

    expect(screen.queryByLabelText('Fact 1')).not.toBeInTheDocument()
    expect(screen.getByText('No approved facts yet.')).toBeInTheDocument()
  })

  it('is read-only for an operator', async () => {
    mockFetch.mockResolvedValueOnce(respond({ brand: BRAND, canEdit: false }))
    render(<BrandProfileSettings />)

    expect(await screen.findByTestId('brand-read-only')).toBeInTheDocument()
    expect(screen.getByLabelText('Brand name')).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save brand profile' })).not.toBeInTheDocument()
  })

  it('shows the server refusal and keeps the draft', async () => {
    mockFetch.mockResolvedValueOnce(respond({ brand: BRAND, canEdit: true }))
    render(<BrandProfileSettings />)
    fireEvent.change(await screen.findByLabelText('Allowed link origins'), { target: { value: 'https://x.example/path' } })

    mockFetch.mockResolvedValueOnce(respond({ error: 'Allowed link origins must look like https://example.com.', code: 'invalid_origin' }, 400))
    fireEvent.click(screen.getByRole('button', { name: 'Save brand profile' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/must look like/)
    expect(screen.getByLabelText('Allowed link origins')).toHaveValue('https://x.example/path')
  })

  it('reports a save failure without a message', async () => {
    mockFetch.mockResolvedValueOnce(respond({ brand: BRAND, canEdit: true }))
    render(<BrandProfileSettings />)
    await screen.findByLabelText('Brand name')

    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.reject(new Error('not json')) })
    fireEvent.click(screen.getByRole('button', { name: 'Save brand profile' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Save failed (HTTP 500)')

    mockFetch.mockRejectedValueOnce('offline')
    fireEvent.click(screen.getByRole('button', { name: 'Save brand profile' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Save failed.'))
  })

  it('says so when the Content Studio is switched off', async () => {
    mockFetch.mockResolvedValueOnce(respond({ error: 'off', code: 'feature_disabled' }, 404))
    render(<BrandProfileSettings />)

    expect(await screen.findByText(/not enabled/)).toBeInTheDocument()
  })

  it('reports a load failure and retries', async () => {
    mockFetch.mockResolvedValueOnce(respond({ error: 'Could not load the brand profile.' }, 500))
    render(<BrandProfileSettings />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load the brand profile.')

    mockFetch.mockResolvedValueOnce(respond({ brand: BRAND, canEdit: true }))
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByLabelText('Brand name')).toHaveValue('AI4L')
  })

  it('reports a load failure without a message', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 502, json: () => Promise.resolve({}) })
    render(<BrandProfileSettings />)
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 502')

    mockFetch.mockRejectedValueOnce('offline')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not load the brand profile.'))
  })
})

describe('draft conversion', () => {
  it('leaves out empty channel rules, blank facts and hash marks', () => {
    const draft = toDraft({ ...BRAND, channelRules: { email: { structure: 'Short' } } })
    const update = toUpdate({
      ...draft,
      approvedFacts: [...draft.approvedFacts, { id: 'f2', text: '  ', source: 'x' }, { id: 'f3', text: 'No source', source: ' ' }],
      hashtagSeeds: '#AI4L, ##Learn  ',
    })

    expect(update.channelRules).toEqual({ email: { structure: 'Short' } })
    expect(update.approvedFacts).toEqual([
      { id: 'f1', text: 'Founded in 2020', source: 'About page' },
      { id: 'f3', text: 'No source' },
    ])
    expect(update.hashtagSeeds).toEqual(['AI4L', 'Learn'])
    expect(toUpdate({ ...draft, channelRules: { ...draft.channelRules, linkedin: { cta: 'Go', structure: '' } } }).channelRules).toEqual({
      linkedin: { cta: 'Go' },
      email: { structure: 'Short' },
    })
  })
})
