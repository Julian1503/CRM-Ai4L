import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'

import type { RevisionAssetRef } from '@/lib/content-studio/types'

import AssetSelection from './AssetSelection'
import { makeAsset } from './testUtils'

const assets = [
  makeAsset({ id: 'a', originalFilename: 'first.jpg', altText: 'First' }),
  makeAsset({ id: 'b', originalFilename: 'second.jpg', altText: 'Second', previewUrl: null }),
  makeAsset({ id: 'c', originalFilename: 'pending.jpg', ingestStatus: 'pending' }),
  makeAsset({ id: 'd', originalFilename: 'bad.jpg', ingestStatus: 'rejected', rejectionReason: 'Not an image' }),
  makeAsset({ id: 'e', originalFilename: 'odd.jpg', ingestStatus: 'rejected', rejectionReason: null }),
  makeAsset({ id: 'z', originalFilename: 'archived.jpg', archivedAt: '2026-01-01' }),
]

function Harness({ initial = [], maxImages }: { initial?: RevisionAssetRef[]; maxImages?: number }) {
  const [value, setValue] = useState<RevisionAssetRef[]>(initial)
  return (
    <>
      <AssetSelection assets={assets} value={value} onChange={setValue} maxImages={maxImages} />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </>
  )
}

const value = () => JSON.parse(screen.getByTestId('value').textContent ?? '[]') as RevisionAssetRef[]

describe('AssetSelection', () => {
  it('adds ready images with their default alt text and explains the others', () => {
    render(<Harness />)

    expect(screen.getByText('No images on this revision.')).toBeInTheDocument()
    expect(screen.getByText('Still processing')).toBeInTheDocument()
    expect(screen.getByText('Rejected: Not an image')).toBeInTheDocument()
    expect(screen.getByText('Rejected: no reason given')).toBeInTheDocument()
    expect(screen.queryByText('archived.jpg')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Add first.jpg' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add second.jpg' }))

    expect(value()).toEqual([
      { assetId: 'a', alt: 'First', order: 0 },
      { assetId: 'b', alt: 'Second', order: 1 },
    ])
  })

  it('reorders with the keyboard-operable buttons and keeps focus on the moved row', () => {
    render(
      <Harness
        initial={[
          { assetId: 'a', alt: 'First', order: 0 },
          { assetId: 'b', alt: 'Second', order: 1 },
          { assetId: 'd', alt: 'Third', order: 2 },
        ]}
      />
    )

    expect(screen.getByRole('button', { name: 'Move first.jpg up' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move bad.jpg down' })).toBeDisabled()

    // A move that stays clear of the ends keeps focus on the same button.
    fireEvent.click(screen.getByRole('button', { name: 'Move first.jpg down' }))
    expect(value().map((ref) => ref.assetId)).toEqual(['b', 'a', 'd'])
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move first.jpg down' }))

    // Reaching the end disables that button, so focus moves to the one that still works.
    fireEvent.click(screen.getByRole('button', { name: 'Move first.jpg down' }))
    expect(value().map((ref) => ref.assetId)).toEqual(['b', 'd', 'a'])
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move first.jpg up' }))

    fireEvent.click(screen.getByRole('button', { name: 'Move first.jpg up' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move first.jpg up' }))
    expect(value().map((ref) => ref.assetId)).toEqual(['a', 'b', 'd'])
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move first.jpg down' }))
  })

  it('edits alt text, flags a blank one, and removes', () => {
    render(<Harness initial={[{ assetId: 'a', alt: 'First', order: 0 }]} />)

    fireEvent.change(screen.getByLabelText('Alt text'), { target: { value: '' } })
    expect(screen.getByText(/Describe the image/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Alt text'), { target: { value: 'A room' } })
    expect(value()[0].alt).toBe('A room')

    fireEvent.click(screen.getByRole('button', { name: 'Remove first.jpg' }))
    expect(value()).toEqual([])
  })

  it('stops adding past the image limit and names missing assets', () => {
    render(<Harness initial={[{ assetId: 'gone', alt: '', order: 0 }]} maxImages={1} />)

    expect(screen.getByText('Images (1/1)')).toBeInTheDocument()
    expect(screen.getByText('Missing image')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add first.jpg' })).toBeDisabled()
  })
})
