import { act, fireEvent, render, screen } from '@testing-library/react'

import BriefAssist, { type BriefField } from './BriefAssist'
import { bodyOf, errorResponse, jsonResponse, routeFetch } from './testUtils'

const SUGGEST = '/api/content-studio/suggestions'
const FACTS = [
  { id: 'f1', text: 'Workshops run online every month.' },
  { id: 'f2', text: 'Founded in 2020.' },
]
const COMPLETION = {
  title: 'AI workshops for small teams',
  audience: 'Small business owners',
  objective: 'Book a seat',
  notes: 'Lead with the monthly cadence.',
  factIds: ['f1'],
  channels: ['linkedin', 'email'],
}
const EMPTY: Record<BriefField, string> = { title: '', audience: '', objective: '', notes: '' }

function renderAssist(props: Partial<Parameters<typeof BriefAssist>[0]> = {}) {
  const handlers = { onUse: jest.fn(), onAddFact: jest.fn(), onChannels: jest.fn() }
  render(
    <BriefAssist
      topic="Monthly AI workshops"
      values={EMPTY}
      sourceFacts={[]}
      channels={['facebook', 'linkedin']}
      approvedFacts={FACTS}
      {...handlers}
      {...props}
    />
  )
  return handlers
}

function answer(completion: unknown = COMPLETION) {
  return routeFetch({ [`POST ${SUGGEST}`]: jsonResponse({ kind: 'brief_completion', cached: false, completion }) })
}

describe('BriefAssist', () => {
  it('needs a topic before it can ask', () => {
    const mock = answer()
    renderAssist({ topic: '   ' })

    expect(screen.getByText('Write a topic first.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Complete with AI' })).toBeDisabled()
    expect(mock).not.toHaveBeenCalled()
  })

  it('sends the topic with only the fields already written', async () => {
    const mock = answer()
    renderAssist({ values: { ...EMPTY, audience: ' Teams ', notes: '  ' } })

    fireEvent.click(screen.getByRole('button', { name: 'Complete with AI' }))
    await screen.findByText('AI workshops for small teams')

    expect(bodyOf(mock, 'POST', SUGGEST)).toEqual({
      kind: 'brief_completion',
      topic: 'Monthly AI workshops',
      draft: { audience: ' Teams ' },
      fresh: false,
    })
  })

  it('offers Use for empty fields and Replace for written ones, never applying on its own', async () => {
    answer()
    const { onUse } = renderAssist({ values: { ...EMPTY, title: 'My own title', objective: 'Book a seat' } })

    fireEvent.click(screen.getByRole('button', { name: 'Complete with AI' }))
    await screen.findByText('AI workshops for small teams')
    expect(onUse).not.toHaveBeenCalled()

    expect(screen.getByRole('button', { name: 'Replace title: AI workshops for small teams' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Use audience: Small business owners' }))
    expect(onUse).toHaveBeenCalledWith('audience', 'Small business owners')
    // The objective already says the same thing.
    expect(screen.getByText('In use')).toBeInTheDocument()
  })

  it('fills only the empty fields at once', async () => {
    answer()
    const { onUse } = renderAssist({ values: { ...EMPTY, title: 'Mine' } })

    fireEvent.click(screen.getByRole('button', { name: 'Complete with AI' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Fill the 3 empty fields' }))

    expect(onUse.mock.calls).toEqual([
      ['audience', 'Small business owners'],
      ['objective', 'Book a seat'],
      ['notes', 'Lead with the monthly cadence.'],
    ])
  })

  it('shows suggested facts by their approved text and suggested channels', async () => {
    answer()
    const { onAddFact, onChannels } = renderAssist({ sourceFacts: [] })

    fireEvent.click(screen.getByRole('button', { name: 'Complete with AI' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Add fact: Workshops run online every month.' }))
    expect(onAddFact).toHaveBeenCalledWith('Workshops run online every month.')
    expect(screen.queryByText('Founded in 2020.')).not.toBeInTheDocument()

    expect(screen.getByText('LinkedIn, Email')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Use the suggested channels' }))
    expect(onChannels).toHaveBeenCalledWith(['linkedin', 'email'])
  })

  it('marks a fact already in the brief, and hides channels that already match', async () => {
    answer()
    renderAssist({ sourceFacts: ['Workshops run online every month.'], channels: ['linkedin', 'email'] })

    fireEvent.click(screen.getByRole('button', { name: 'Complete with AI' }))

    expect(await screen.findByText('Added')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Use the suggested channels' })).not.toBeInTheDocument()
  })

  it('asks for a different completion with More ideas', async () => {
    const mock = answer()
    renderAssist()
    fireEvent.click(screen.getByRole('button', { name: 'Complete with AI' }))
    await screen.findByText('AI workshops for small teams')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'More ideas' }))
    })

    expect(JSON.parse(String(mock.mock.calls[1][1].body))).toMatchObject({ fresh: true })
  })

  it('explains a failure quietly and retries', async () => {
    routeFetch({ [`POST ${SUGGEST}`]: errorResponse(429, 'Too many suggestion requests.', 'rate_limited') })
    renderAssist()

    fireEvent.click(screen.getByRole('button', { name: 'Complete with AI' }))

    expect(await screen.findByText(/Too many suggestions in a minute/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    answer()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('AI workshops for small teams')).toBeInTheDocument()
  })
})
