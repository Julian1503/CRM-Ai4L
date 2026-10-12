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

const openTab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }))

describe('BrandProfileSettings', () => {
  it('shows the profile to an administrator and saves the whole edited profile across tabs', async () => {
    mockFetch.mockResolvedValueOnce(respond({ brand: BRAND, canEdit: true }))
    render(<BrandProfileSettings />)

    expect(await screen.findByLabelText('Brand name')).toHaveValue('AI4L')
    fireEvent.change(screen.getByLabelText('Tone of voice'), { target: { value: 'Plain, no hype' } })

    openTab('Approved facts')
    fireEvent.click(screen.getByRole('button', { name: 'Add fact' }))
    fireEvent.change(screen.getByLabelText('Fact 2'), { target: { value: 'Workshops run monthly' } })

    openTab('Channel rules')
    expect(screen.getByLabelText('Hashtag seeds')).toHaveValue('#AI4L #Automation')
    fireEvent.click(screen.getByRole('button', { name: 'LinkedIn' }))
    expect(screen.getByLabelText('LinkedIn call to action')).toHaveValue('Book a call')

    openTab('Visuals & links')
    expect(screen.getByText(/Links outside this list need human editing/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Allowed link origins'), { target: { value: 'https://ai4l.example\nhttps://book.ai4l.example' } })

    // One draft for the whole profile: an edit on the first tab survives the others.
    openTab('Voice & audience')
    expect(screen.getByLabelText('Tone of voice')).toHaveValue('Plain, no hype')
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()

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
    expect(screen.getByText('All changes saved')).toBeInTheDocument()
  })

  it('edits and removes a fact', async () => {
    mockFetch.mockResolvedValueOnce(respond({ brand: BRAND, canEdit: true }))
    render(<BrandProfileSettings />)
    await screen.findByLabelText('Brand name')
    openTab('Approved facts')

    fireEvent.click(screen.getByRole('button', { name: /Fact 1/ }))
    fireEvent.change(screen.getByLabelText('Source of fact 1'), { target: { value: 'Annual report' } })
    expect(screen.getByLabelText('Source of fact 1')).toHaveValue('Annual report')
    fireEvent.click(screen.getByRole('button', { name: 'Remove fact' }))

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
    await screen.findByLabelText('Brand name')
    openTab('Visuals & links')
    fireEvent.change(screen.getByLabelText('Allowed link origins'), { target: { value: 'https://x.example/path' } })

    mockFetch.mockResolvedValueOnce(respond({ error: 'Allowed link origins must look like https://example.com.', code: 'invalid_origin' }, 400))
    fireEvent.click(screen.getByRole('button', { name: 'Save brand profile' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/must look like/)
    expect(screen.getByLabelText('Allowed link origins')).toHaveValue('https://x.example/path')
  })

  it('reports a save failure without a message', async () => {
    mockFetch.mockResolvedValueOnce(respond({ brand: BRAND, canEdit: true }))
    render(<BrandProfileSettings />)
    // Save is only offered once something changed.
    expect(await screen.findByRole('button', { name: 'Save brand profile' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'NZ' } })

    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.reject(new Error('not json')) })
    fireEvent.click(screen.getByRole('button', { name: 'Save brand profile' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Save failed (HTTP 500)')

    mockFetch.mockRejectedValueOnce('offline')
    fireEvent.click(screen.getByRole('button', { name: 'Save brand profile' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Save failed.'))
    expect(screen.getByLabelText('Region')).toHaveValue('NZ')
  })

  it('discards the draft and reports whether it is dirty', async () => {
    const onDirtyChange = jest.fn()
    mockFetch.mockResolvedValueOnce(respond({ brand: BRAND, canEdit: true }))
    render(<BrandProfileSettings onDirtyChange={onDirtyChange} compact />)

    fireEvent.change(await screen.findByLabelText('Region'), { target: { value: 'NZ' } })
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.getByLabelText('Region')).toHaveValue('AU')
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
    // Compact mode sits inside Settings' own heading.
    expect(screen.queryByRole('heading', { name: 'Brand profile' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Brand profile editor' })).toBeInTheDocument()
  })

  it('moves between tabs with the arrow, Home and End keys', async () => {
    mockFetch.mockResolvedValueOnce(respond({ brand: BRAND, canEdit: true }))
    render(<BrandProfileSettings />)
    await screen.findByLabelText('Brand name')
    const voice = screen.getByRole('tab', { name: 'Voice & audience' })

    fireEvent.keyDown(voice, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Approved facts' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Approved facts' })).toHaveFocus()

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Approved facts' }), { key: 'End' })
    expect(screen.getByRole('tab', { name: 'Visuals & links' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Visuals & links' }), { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Voice & audience' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Voice & audience' }), { key: 'ArrowLeft' })
    expect(screen.getByRole('tab', { name: 'Visuals & links' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Visuals & links' }), { key: 'Home' })
    expect(screen.getByRole('tab', { name: 'Voice & audience' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Voice & audience' }), { key: 'a' })
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'brand-tab-voice')
  })

  it('edits each channel rule separately', async () => {
    mockFetch.mockResolvedValueOnce(respond({ brand: BRAND, canEdit: true }))
    render(<BrandProfileSettings />)
    await screen.findByLabelText('Brand name')
    openTab('Channel rules')

    expect(screen.getByRole('button', { name: 'Facebook' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.change(screen.getByLabelText('Facebook structure'), { target: { value: 'Story first' } })
    fireEvent.click(screen.getByRole('button', { name: 'Email' }))
    fireEvent.change(screen.getByLabelText('Email call to action'), { target: { value: 'Reply' } })
    fireEvent.click(screen.getByRole('button', { name: 'Facebook' }))
    expect(screen.getByLabelText('Facebook structure')).toHaveValue('Story first')
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
