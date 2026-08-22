import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import {
  BOOKING_URL_MERGE_FIELD,
  CAMPAIGN_COPY_FIELDS,
} from '@/lib/marketing/mergeFields'

import CampaignCopyEditor from './CampaignCopyEditor'

function fullCopy(overrides: Record<string, string> = {}): Record<string, string> {
  const copy: Record<string, string> = {}
  for (const field of CAMPAIGN_COPY_FIELDS) copy[field.tag] = 'Sound copy'
  return { ...copy, ...overrides }
}

function renderEditor(props: Partial<React.ComponentProps<typeof CampaignCopyEditor>> = {}) {
  const onSaved = jest.fn()
  const onError = jest.fn()

  render(
    <CampaignCopyEditor
      campaignId="camp-1"
      campaignName="Spring outreach"
      editable
      mergeFields={fullCopy()}
      onSaved={onSaved}
      onError={onError}
      {...props}
    />
  )

  return { onSaved, onError }
}

function mockFetch(response: { ok: boolean; body?: unknown; status?: number }) {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: async () => response.body ?? {},
  })
  global.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

describe('CampaignCopyEditor', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFetch({ ok: true, body: { campaign: { merge_fields: fullCopy() } } })
  })

  it('renders one input per merge field, labelled with its tag', () => {
    renderEditor()

    for (const field of CAMPAIGN_COPY_FIELDS) {
      expect(screen.getByTestId(`copy-field-${field.tag}`)).toBeInTheDocument()
      expect(screen.getByText(`{{${field.tag}}}`)).toBeInTheDocument()
    }
  })

  it('associates every input with its label, so a screen reader announces it', () => {
    renderEditor()

    for (const field of CAMPAIGN_COPY_FIELDS) {
      // Throws if the accessible name is missing — which is the bug this guards.
      expect(screen.getByLabelText(new RegExp(field.label, 'i'))).toBeInTheDocument()
    }
  })

  it('does not offer the booking link as an editable field', () => {
    renderEditor()

    expect(screen.queryByTestId(`copy-field-${BOOKING_URL_MERGE_FIELD}`)).toBeNull()
  })

  it('shows the character budget against each field', () => {
    const headline = CAMPAIGN_COPY_FIELDS.find((f) => f.tag === 'Headline')!
    renderEditor()

    expect(screen.getByTestId('copy-count-Headline')).toHaveTextContent(
      `10 / ${headline.maxLength}`
    )
  })

  describe('overrun', () => {
    it('flags a field that will break the template and blocks saving', () => {
      const headline = CAMPAIGN_COPY_FIELDS.find((f) => f.tag === 'Headline')!
      renderEditor()

      fireEvent.change(screen.getByTestId('copy-field-Headline'), {
        target: { value: 'x'.repeat(headline.maxLength + 1) },
      })

      expect(screen.getByTestId('copy-count-Headline')).toHaveTextContent('too long')
      expect(screen.getByTestId('save-copy')).toBeDisabled()
    })

    it('marks the overrunning input invalid for assistive technology', () => {
      const headline = CAMPAIGN_COPY_FIELDS.find((f) => f.tag === 'Headline')!
      renderEditor()

      fireEvent.change(screen.getByTestId('copy-field-Headline'), {
        target: { value: 'x'.repeat(headline.maxLength + 1) },
      })

      expect(screen.getByTestId('copy-field-Headline')).toHaveAttribute(
        'aria-invalid',
        'true'
      )
    })

    it('does not count trailing whitespace as an overrun', () => {
      const headline = CAMPAIGN_COPY_FIELDS.find((f) => f.tag === 'Headline')!
      renderEditor()

      fireEvent.change(screen.getByTestId('copy-field-Headline'), {
        target: { value: `${'x'.repeat(headline.maxLength)}    ` },
      })

      expect(screen.getByTestId('save-copy')).toBeEnabled()
    })
  })

  describe('incomplete copy', () => {
    it('blocks saving and says how many fields are empty', () => {
      renderEditor({ mergeFields: {} })

      expect(screen.getByTestId('save-copy')).toBeDisabled()
      expect(screen.getByTestId('copy-incomplete')).toHaveTextContent(
        `${CAMPAIGN_COPY_FIELDS.length} fields still empty`
      )
    })

    it('offers to write the copy when there is none', () => {
      renderEditor({ mergeFields: {} })

      expect(screen.getByTestId('generate-copy')).toHaveTextContent('Write with AI')
    })

    it('offers a rewrite when copy already exists', () => {
      renderEditor()

      expect(screen.getByTestId('generate-copy')).toHaveTextContent('Rewrite with AI')
    })
  })

  describe('generation', () => {
    it('asks the generate endpoint for this campaign', async () => {
      const fetchMock = mockFetch({
        ok: true,
        body: {
          campaign: { merge_fields: fullCopy({ Headline: 'Fresh headline' }) },
          audience: { size: 412 },
          generation: { attempts: 1 },
        },
      })
      renderEditor()

      fireEvent.click(screen.getByTestId('generate-copy'))

      await waitFor(() => expect(fetchMock).toHaveBeenCalled())
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('/api/campaigns/generate')
      expect(JSON.parse(init.body)).toEqual({ campaignId: 'camp-1' })
    })

    it('replaces the fields with what came back', async () => {
      mockFetch({
        ok: true,
        body: {
          campaign: { merge_fields: fullCopy({ Headline: 'Fresh headline' }) },
          audience: { size: 412 },
          generation: { attempts: 1 },
        },
      })
      renderEditor()

      fireEvent.click(screen.getByTestId('generate-copy'))

      await waitFor(() =>
        expect(screen.getByTestId('copy-field-Headline')).toHaveValue('Fresh headline')
      )
    })

    it('passes the post-generation status back, which is draft', async () => {
      mockFetch({
        ok: true,
        body: {
          campaign: { merge_fields: fullCopy(), status: 'draft' },
          audience: { size: 412 },
          generation: { attempts: 1 },
        },
      })
      const { onSaved } = renderEditor()

      fireEvent.click(screen.getByTestId('generate-copy'))

      await waitFor(() =>
        expect(onSaved).toHaveBeenCalledWith(expect.any(Object), 'draft')
      )
    })

    it('reports the audience the copy was written for', async () => {
      mockFetch({
        ok: true,
        body: {
          campaign: { merge_fields: fullCopy() },
          audience: { size: 412 },
          generation: { attempts: 1 },
        },
      })
      renderEditor()

      fireEvent.click(screen.getByTestId('generate-copy'))

      await waitFor(() =>
        expect(screen.getByTestId('generation-meta')).toHaveTextContent(
          'Written for 412 contacts'
        )
      )
    })

    it('surfaces the endpoint error rather than a generic failure', async () => {
      mockFetch({ ok: false, status: 500, body: { error: 'ANTHROPIC_API_KEY is not configured' } })
      const { onError } = renderEditor()

      fireEvent.click(screen.getByTestId('generate-copy'))

      await waitFor(() =>
        expect(onError).toHaveBeenCalledWith(
          expect.stringContaining('ANTHROPIC_API_KEY')
        )
      )
    })
  })

  describe('saving', () => {
    it('PATCHes the trimmed copy', async () => {
      const fetchMock = mockFetch({ ok: true, body: { campaign: {} } })
      renderEditor()

      fireEvent.change(screen.getByTestId('copy-field-Headline'), {
        target: { value: '  Trimmed headline  ' },
      })
      fireEvent.click(screen.getByTestId('save-copy'))

      await waitFor(() => expect(fetchMock).toHaveBeenCalled())
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('/api/campaigns/camp-1')
      expect(init.method).toBe('PATCH')
      expect(JSON.parse(init.body).mergeFields.Headline).toBe('Trimmed headline')
    })

    it('tells the parent what was saved, with the status the server reported', async () => {
      // Not an assumed status: a plain save does not move a campaign, but generating
      // copy does, and the parent must not have to guess which happened.
      mockFetch({ ok: true, body: { campaign: { status: 'failed' } } })
      const { onSaved } = renderEditor()

      fireEvent.click(screen.getByTestId('save-copy'))

      await waitFor(() =>
        expect(onSaved).toHaveBeenCalledWith(
          expect.objectContaining({ Headline: 'Sound copy' }),
          'failed'
        )
      )
    })

    it('surfaces a rejected save', async () => {
      mockFetch({ ok: false, status: 400, body: { error: 'Headline is 94 characters' } })
      const { onError } = renderEditor()

      fireEvent.click(screen.getByTestId('save-copy'))

      await waitFor(() =>
        expect(onError).toHaveBeenCalledWith(expect.stringContaining('94 characters'))
      )
    })
  })

  describe('locked once past review', () => {
    it('disables every field and both actions', () => {
      renderEditor({ editable: false })

      expect(screen.getByTestId('copy-locked')).toBeInTheDocument()
      expect(screen.getByTestId('generate-copy')).toBeDisabled()
      expect(screen.getByTestId('save-copy')).toBeDisabled()
      for (const field of CAMPAIGN_COPY_FIELDS) {
        expect(screen.getByTestId(`copy-field-${field.tag}`)).toBeDisabled()
      }
    })

    it('says how to unlock it', () => {
      renderEditor({ editable: false })

      expect(screen.getByTestId('copy-locked')).toHaveTextContent('back to draft')
    })
  })
})
