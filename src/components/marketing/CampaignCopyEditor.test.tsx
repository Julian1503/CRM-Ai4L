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

  describe('an audience that cannot receive the email', () => {
    // Generation fails with a 409 when the segment matches nobody. The route is right
    // to refuse, but the operator learned it only after clicking, from a banner
    // elsewhere on the page -- so the count belongs on the To line, before the click.
    it('shows the audience size beside the addressee', () => {
      renderEditor({ audienceLabel: 'NSW leads', audienceSize: 5082 })

      expect(screen.getByTestId('composer-audience')).toHaveTextContent(
        'NSW leads · 5,082 contacts'
      )
    })

    it('says one contact in the singular', () => {
      renderEditor({ audienceLabel: 'NSW leads', audienceSize: 1 })

      expect(screen.getByTestId('composer-audience')).toHaveTextContent('1 contact')
    })

    it('names the segment alone when the size is not known yet', () => {
      renderEditor({ audienceLabel: 'NSW leads' })

      expect(screen.getByTestId('composer-audience')).toHaveTextContent('NSW leads')
      expect(screen.getByTestId('composer-audience')).not.toHaveTextContent('contacts')
    })

    it('refuses to generate for an empty audience, and says why', () => {
      renderEditor({ audienceLabel: 'NSW Ele', audienceSize: 0 })

      expect(screen.getByTestId('generate-copy')).toBeDisabled()
      expect(screen.getByTestId('empty-audience')).toHaveTextContent(
        /matches no contacts/i
      )
    })

    it('does not block generation before the count arrives', () => {
      renderEditor({ audienceLabel: 'NSW Ele' })

      expect(screen.getByTestId('generate-copy')).toBeEnabled()
      expect(screen.queryByTestId('empty-audience')).toBeNull()
    })

    it('leaves an audience with contacts alone', () => {
      renderEditor({ audienceLabel: 'NSW leads', audienceSize: 42 })

      expect(screen.getByTestId('generate-copy')).toBeEnabled()
      expect(screen.queryByTestId('empty-audience')).toBeNull()
    })
  })

  describe('the email composer layout', () => {
    it('addresses the email to the campaign audience', () => {
      renderEditor({ audienceLabel: 'NSW leads' })

      expect(screen.getByTestId('composer-audience')).toHaveTextContent('NSW leads')
    })

    it('falls back to naming the segment generically when none is passed', () => {
      renderEditor()

      expect(screen.getByTestId('composer-audience')).toHaveTextContent(
        'the campaign segment'
      )
    })

    it('puts the headline in the subject line and the preheader in the preview line', () => {
      renderEditor()

      const subject = screen.getByTestId('composer-subject')
      const preview = screen.getByTestId('composer-preview')

      expect(subject).toContainElement(screen.getByTestId('copy-field-Headline'))
      expect(preview).toContainElement(screen.getByTestId('copy-field-Preheader'))
    })

    it('lays the body out as the message itself -- intro, benefits, then the button', () => {
      renderEditor()

      const body = screen.getByTestId('composer-body')

      expect(body).toContainElement(screen.getByTestId('copy-field-Intro'))
      for (const tag of ['Benefit1', 'Benefit2', 'Benefit3']) {
        expect(body).toContainElement(screen.getByTestId(`copy-field-${tag}`))
      }
      expect(body).toContainElement(screen.getByTestId('copy-field-CtaLabel'))
    })

    it('shows the benefits as a list, because that is what the template renders', () => {
      renderEditor()

      expect(screen.getAllByTestId('composer-benefit')).toHaveLength(3)
    })

    it('says the booking link is added per recipient, where the button is', () => {
      renderEditor()

      expect(screen.getByTestId('composer-cta-note')).toHaveTextContent(
        /booking link/i
      )
    })

    it('renders any merge field it has no slot for, so a new one cannot go missing', () => {
      // The slots are hand-placed. If the contract grows a field, it must still be
      // editable rather than silently dropped out of the composer.
      renderEditor()

      for (const field of CAMPAIGN_COPY_FIELDS) {
        expect(screen.getByTestId(`copy-field-${field.tag}`)).toBeInTheDocument()
      }
    })
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
