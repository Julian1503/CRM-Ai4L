import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import BriefForm, { EMPTY_BRIEF, toBrief, validateBrief } from './BriefForm'
import { bodyOf, callsTo, errorResponse, jsonResponse, makeItem, makeJob, routeFetch } from './testUtils'

const ITEMS = '/api/content-studio/items'
const GENERATE = '/api/content-studio/items/item-1/generate'

function fillRequired() {
  fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Spring workshop' } })
  fireEvent.change(screen.getByLabelText(/^Topic/), { target: { value: 'Launch of the spring workshop' } })
}

describe('validateBrief / toBrief', () => {
  it('requires title, topic, an https reference and a channel', () => {
    expect(validateBrief({ ...EMPTY_BRIEF, channels: [], referenceUrl: 'http://x.test' })).toEqual({
      title: 'Give the piece a title.',
      topic: 'Say what the content is about.',
      referenceUrl: 'Use a full https:// address.',
      channels: 'Pick at least one channel.',
    })
    expect(validateBrief({ ...EMPTY_BRIEF, title: 'x'.repeat(201), topic: 't' }).title).toMatch(/under 200/)
  })

  it('drops blank optional fields and facts', () => {
    expect(toBrief({ ...EMPTY_BRIEF, topic: ' t ', audience: ' ', sourceFacts: [' a ', ' '] })).toEqual({
      topic: 't',
      audience: undefined,
      objective: undefined,
      notes: undefined,
      referenceUrl: undefined,
      sourceFacts: ['a'],
    })
    expect(toBrief(EMPTY_BRIEF).sourceFacts).toBeUndefined()
  })
})

describe('BriefForm', () => {
  it('shows validation errors without calling the server', () => {
    const mock = routeFetch({})
    render(<BriefForm onCreated={jest.fn()} />)

    fireEvent.change(screen.getByLabelText('Reference URL'), { target: { value: 'ftp://nope' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Facebook' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'LinkedIn' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create and generate' }))

    expect(screen.getByText('Give the piece a title.')).toBeInTheDocument()
    expect(screen.getByText('Use a full https:// address.')).toBeInTheDocument()
    expect(screen.getByText('Pick at least one channel.')).toBeInTheDocument()
    expect(mock).not.toHaveBeenCalled()
  })

  it('creates the item, then queues generation with the chosen channels and styles', async () => {
    const item = makeItem({ channels: ['facebook', 'email'] })
    const mock = routeFetch({
      [`POST ${ITEMS}`]: jsonResponse({ item }, 201),
      [`POST ${GENERATE}`]: jsonResponse({ job: makeJob() }, 202),
    })
    const onCreated = jest.fn()
    render(<BriefForm onCreated={onCreated} />)

    fillRequired()
    fireEvent.change(screen.getByLabelText('Audience'), { target: { value: 'Owners' } })
    fireEvent.change(screen.getByLabelText('Reference URL'), { target: { value: 'https://ai4l.test/spring' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'LinkedIn' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Email' }))
    fireEvent.change(screen.getByLabelText('Styles per channel'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Source facts'), { target: { value: 'Runs every Tuesday' } })
    fireEvent.keyDown(screen.getByLabelText('Source facts'), { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Create and generate' }))

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(item))
    expect(bodyOf(mock, 'POST', ITEMS)).toEqual({
      title: 'Spring workshop',
      brief: { topic: 'Launch of the spring workshop', audience: 'Owners', referenceUrl: 'https://ai4l.test/spring', sourceFacts: ['Runs every Tuesday'] },
      channels: ['facebook', 'email'],
    })
    expect(bodyOf(mock, 'POST', GENERATE)).toMatchObject({ channels: ['facebook', 'email'], stylesPerChannel: 2 })
    expect(screen.getByLabelText(/^Title/)).toHaveValue('')
  })

  it('keeps the created item when generation fails and retries with the same key', async () => {
    const item = makeItem({ channels: [] })
    const responses = [errorResponse(503, 'Engine offline'), jsonResponse({ job: makeJob() }, 202)]
    const mock = routeFetch({
      [`POST ${ITEMS}`]: jsonResponse({ item }, 201),
      [`POST ${GENERATE}`]: () => responses.shift() ?? jsonResponse({}),
    })
    const onCreated = jest.fn()
    render(<BriefForm onCreated={onCreated} />)

    fillRequired()
    fireEvent.click(screen.getByRole('button', { name: 'Create and generate' }))

    expect(await screen.findByText(/The item was saved, but generation did not start: Engine offline/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry generation' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(item))

    expect(callsTo(mock, 'POST', ITEMS)).toBe(1)
    const generateCalls = mock.mock.calls.filter(([url]) => url === GENERATE).map(([, init]) => JSON.parse(String(init.body)))
    expect(generateCalls).toHaveLength(2)
    expect(generateCalls[0].idempotencyKey).toBe(generateCalls[1].idempotencyKey)
    // An item created with no channels falls back to the ones ticked in the form.
    expect(generateCalls[0].channels).toEqual(['facebook', 'linkedin'])
  })

  it('lets the operator open a saved item without generating', async () => {
    const item = makeItem()
    routeFetch({ [`POST ${ITEMS}`]: jsonResponse({ item }, 201), [`POST ${GENERATE}`]: errorResponse(500, 'x') })
    const onCreated = jest.fn()
    render(<BriefForm onCreated={onCreated} />)

    fillRequired()
    fireEvent.click(screen.getByRole('button', { name: 'Create and generate' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open the item without generating' }))

    expect(onCreated).toHaveBeenCalledWith(item)
  })

  it('reports a failed create', async () => {
    routeFetch({ [`POST ${ITEMS}`]: errorResponse(400, 'Title taken') })
    render(<BriefForm onCreated={jest.fn()} />)

    fillRequired()
    fireEvent.click(screen.getByRole('button', { name: 'Create and generate' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Title taken')
  })

  it('adds and removes source facts', () => {
    render(<BriefForm onCreated={jest.fn()} />)
    const input = screen.getByLabelText('Source facts')

    fireEvent.click(screen.getByRole('button', { name: 'Add fact' }))
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'Fact one' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add fact' }))
    fireEvent.change(input, { target: { value: 'Fact two' } })
    fireEvent.keyDown(input, { key: 'a' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getAllByRole('listitem')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Remove fact: Fact one' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByText('Fact two')).toBeInTheDocument()
  })

  it('edits the remaining optional fields', () => {
    render(<BriefForm onCreated={jest.fn()} />)
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Book' } })
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Friendly' } })
    expect(screen.getByLabelText('Objective')).toHaveValue('Book')
    expect(screen.getByLabelText('Notes')).toHaveValue('Friendly')
  })

  it('locks the brief once the item is saved, so a retry cannot silently drop edits', async () => {
    routeFetch({ [`POST ${ITEMS}`]: jsonResponse({ item: makeItem() }, 201), [`POST ${GENERATE}`]: errorResponse(503, 'Offline') })
    render(<BriefForm onCreated={jest.fn()} />)

    fillRequired()
    fireEvent.click(screen.getByRole('button', { name: 'Create and generate' }))

    expect(await screen.findByText(/is saved, so the brief is locked here/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Title/)).toBeDisabled()
    expect(screen.getByLabelText(/^Topic/)).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Email' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Retry generation' })).toBeEnabled()
  })
})
