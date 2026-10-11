import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React, { useState } from 'react'

import { installFetchRouter, page } from '@/components/contacts/testing/mockFetch'

import SegmentCriteriaFields, { type CriteriaDraft } from './SegmentCriteriaFields'

const VIP = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'VIP' }
const WORKSHOP = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Workshop 2026' }
const GONE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function Harness({ initial, spy }: { initial: CriteriaDraft; spy: jest.Mock }) {
  const [value, setValue] = useState(initial)
  return (
    <SegmentCriteriaFields
      value={value}
      onChange={(next) => {
        spy(next)
        setValue(next)
      }}
      jobTypes={[]}
    />
  )
}

function setup(initial: CriteriaDraft = {}) {
  const router = installFetchRouter({
    'GET /api/tags': (call) => {
      const q = (call.url.searchParams.get('q') ?? '').toLowerCase()
      return { body: page('tags', [VIP, WORKSHOP].filter((tag) => tag.name.toLowerCase().includes(q))) }
    },
    'GET /api/segments/options': (call) => {
      const ids = (call.url.searchParams.get('tagIds') ?? '').split(',')
      return { body: { services: [], organisations: [], tags: [VIP, WORKSHOP].filter((tag) => ids.includes(tag.id)) } }
    },
  })
  const spy = jest.fn()
  render(<Harness initial={initial} spy={spy} />)
  return { ...router, spy }
}

describe('SegmentCriteriaFields tag criteria', () => {
  it('stores the chosen "any of" tags as ids', async () => {
    const { spy } = setup()

    const input = screen.getByRole('combobox', { name: 'Has any of these tags' })
    fireEvent.focus(input)
    fireEvent.click(await screen.findByRole('option', { name: 'VIP' }))

    expect(spy).toHaveBeenLastCalledWith({ tagIds: VIP.id })
    expect(screen.getByRole('button', { name: 'Remove tag VIP' })).toBeInTheDocument()
  })

  it('stores excluded tags separately and clears an emptied list', async () => {
    const { spy } = setup({ excludeTagIds: WORKSHOP.id })

    fireEvent.click(await screen.findByRole('button', { name: 'Remove tag Workshop 2026' }))

    expect(spy).toHaveBeenLastCalledWith({})
  })

  it('labels a saved segment and keeps a tag removed from the catalogue removable', async () => {
    const { spy, calls } = setup({ tagIds: `${VIP.id},${GONE}` })

    expect(await screen.findByRole('button', { name: 'Remove tag VIP' })).toBeInTheDocument()
    const removed = await screen.findByRole('button', { name: 'Remove tag Removed tag' })
    expect(calls.filter((call) => call.url.pathname === '/api/segments/options')).toHaveLength(1)

    fireEvent.click(removed)
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith({ tagIds: VIP.id }))
  })

  it('never offers to create a tag from the segment editor', async () => {
    setup()

    const input = screen.getByRole('combobox', { name: 'Leave out contacts tagged' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Brand new' } })

    await waitFor(() => expect(screen.queryByRole('option', { name: /VIP/ })).not.toBeInTheDocument())
    expect(screen.queryByRole('option', { name: /Create/ })).not.toBeInTheDocument()
  })
})
