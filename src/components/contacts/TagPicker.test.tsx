import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React, { useState } from 'react'

import { installFetchRouter, page } from './testing/mockFetch'
import TagPicker, { type TagOption, type TagPickerProps } from './TagPicker'

const VIP = { id: 't-1', name: 'VIP' }
const WORKSHOP = { id: 't-2', name: 'Workshop 2026' }

function Harness({
  initial = [],
  onChangeSpy,
  ...props
}: Partial<TagPickerProps> & { initial?: TagOption[]; onChangeSpy?: jest.Mock }) {
  const [value, setValue] = useState<TagOption[]>(initial)

  return (
    <TagPicker
      {...props}
      value={value}
      onChange={(next) => {
        onChangeSpy?.(next)
        setValue(next)
      }}
    />
  )
}

function setup(props: Partial<TagPickerProps> & { initial?: TagOption[] } = {}, routes = {}) {
  const router = installFetchRouter({
    'GET /api/tags': (call) => {
      const q = (call.url.searchParams.get('q') ?? '').toLowerCase()
      return { body: page('tags', [VIP, WORKSHOP].filter((tag) => tag.name.toLowerCase().includes(q))) }
    },
    ...routes,
  })
  const onChangeSpy = jest.fn()
  render(<Harness {...props} onChangeSpy={onChangeSpy} />)
  return { ...router, onChangeSpy, input: screen.getByRole('combobox', { name: props.label ?? 'Tags' }) }
}

describe('TagPicker', () => {
  it('suggests existing tags from the server when focused', async () => {
    const { input } = setup()

    fireEvent.focus(input)

    expect(await screen.findByRole('option', { name: 'VIP' })).toBeInTheDocument()
    expect(input).toHaveAttribute('aria-expanded', 'true')
  })

  it('does not fetch until opened', () => {
    const { fetchMock } = setup()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('adds a tag by click and shows it as a removable chip', async () => {
    const { input, onChangeSpy } = setup()
    fireEvent.focus(input)

    fireEvent.click(await screen.findByRole('option', { name: 'VIP' }))

    expect(onChangeSpy).toHaveBeenLastCalledWith([VIP])
    expect(screen.getByRole('button', { name: 'Remove tag VIP' })).toBeInTheDocument()
  })

  it('hides tags that are already selected', async () => {
    const { input } = setup({ initial: [VIP] })
    fireEvent.focus(input)

    expect(await screen.findByRole('option', { name: 'Workshop 2026' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'VIP' })).not.toBeInTheDocument()
  })

  it('navigates with the keyboard and picks with Enter', async () => {
    const { input, onChangeSpy } = setup()
    fireEvent.focus(input)
    await screen.findByRole('option', { name: 'VIP' })

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: 'Workshop 2026' })).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onChangeSpy).toHaveBeenLastCalledWith([WORKSHOP])
  })

  it('removes a chip, and the last one with Backspace in an empty field', () => {
    const { input, onChangeSpy } = setup({ initial: [VIP, WORKSHOP] })

    fireEvent.click(screen.getByRole('button', { name: 'Remove tag VIP' }))
    expect(onChangeSpy).toHaveBeenLastCalledWith([WORKSHOP])

    fireEvent.keyDown(input, { key: 'Backspace' })
    expect(onChangeSpy).toHaveBeenLastCalledWith([])
  })

  it('closes with Escape without removing anything', async () => {
    const { input, onChangeSpy } = setup({ initial: [VIP] })
    fireEvent.focus(input)
    await screen.findByRole('listbox')

    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onChangeSpy).not.toHaveBeenCalled()
  })

  it('creates a missing tag and selects it', async () => {
    const created = { id: 't-9', name: 'Board member' }
    const { input, calls, onChangeSpy } = setup(
      {},
      { 'POST /api/tags': () => ({ status: 201, body: { tag: created, created: true } }) }
    )
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '  Board   member ' } })

    fireEvent.click(await screen.findByRole('option', { name: /Create .Board member./ }))

    await waitFor(() => expect(onChangeSpy).toHaveBeenLastCalledWith([created]))
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({ name: 'Board member' })
  })

  it('does not offer to create a name that already exists, ignoring case', async () => {
    const { input } = setup()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'vip' } })

    expect(await screen.findByRole('option', { name: 'VIP' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Create/ })).not.toBeInTheDocument()
  })

  it('does not offer to create when creation is disabled', async () => {
    const { input } = setup({ allowCreate: false })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Brand new' } })

    expect(await screen.findByText('No matching tags.')).toBeInTheDocument()
  })

  it('refuses a name longer than 80 characters without calling the server', async () => {
    const { input, calls } = setup()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'x'.repeat(81) } })

    fireEvent.click(await screen.findByRole('option', { name: /Create/ }))

    expect(screen.getByRole('alert')).toHaveTextContent('at most 80 characters')
    expect(calls.some((call) => call.method === 'POST')).toBe(false)
  })

  it('refuses to go past the tag limit', async () => {
    const { input, onChangeSpy } = setup({ initial: [VIP], maxTags: 1 })
    fireEvent.focus(input)

    fireEvent.click(await screen.findByRole('option', { name: 'Workshop 2026' }))

    expect(screen.getByRole('alert')).toHaveTextContent('At most 1 tags can be selected.')
    expect(onChangeSpy).not.toHaveBeenCalled()
  })

  it('shows a create failure', async () => {
    const { input } = setup(
      {},
      { 'POST /api/tags': () => ({ status: 400, body: { error: 'Tag name is invalid.' } }) }
    )
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'New' } })
    fireEvent.click(await screen.findByRole('option', { name: /Create/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Tag name is invalid.')
  })
})
