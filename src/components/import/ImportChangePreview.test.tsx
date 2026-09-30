import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { ImportPreview } from '@/lib/db/types'
import type { MappedContactRow } from '@/lib/excelParser'

import ImportChangePreview from './ImportChangePreview'

const preview: ImportPreview = {
  total: 5,
  rejected: 1,
  duplicates: 1,
  new: 1,
  changed: 2,
  unchanged: 0,
  held_back: 0,
  becoming_customers: 0,
  leaving_customers: 1,
  withdrawing_newsletter: 1,
  withdrawing_programs: 0,
  customer_column_present: true,
  samples: [
    { email: 'ada@example.com', outcome: 'changed', status: 'prospect', previous_status: 'customer', newsletter: false, previous_newsletter: true },
  ],
  token: 'tok-1',
}

const rows: MappedContactRow[] = [
  { isValid: true, data: { firstName: 'A', lastName: 'B', email: 'ada@example.com' } as never },
  { isValid: false, errors: ['Email address is required'] },
]

class StaleError extends Error {
  constructor() {
    super('changed after the preview')
    this.name = 'ImportPreviewStaleError'
  }
}

describe('ImportChangePreview (P3)', () => {
  it('shows counts and the consequential changes before anything is written', async () => {
    render(<ImportChangePreview rows={rows} onPreview={async () => preview} onCommit={jest.fn()} />)

    expect(await screen.findByTestId('import-preview-counts')).toHaveTextContent('1 new')
    expect(screen.getByTestId('import-preview-counts')).toHaveTextContent('2 updated')
    expect(screen.getByTestId('import-preview-consequences')).toHaveTextContent('1 existing customer(s) will become prospects')
    expect(screen.getByTestId('import-preview-consequences')).toHaveTextContent('1 contact(s) will lose newsletter consent')
    expect(screen.getByText('customer → prospect')).toBeInTheDocument()
    expect(screen.getByTestId('download-rejected')).toHaveAttribute('download', 'import-rejected-rows.csv')
  })

  it('explains that an unmapped customer column keeps existing statuses (H9)', async () => {
    render(
      <ImportChangePreview rows={rows} onPreview={async () => ({ ...preview, customer_column_present: false })} onCommit={jest.fn()} />
    )

    expect(await screen.findByText(/existing contacts keep their status/)).toBeInTheDocument()
  })

  it('commits with the preview token', async () => {
    const onCommit = jest.fn().mockResolvedValue(undefined)
    render(<ImportChangePreview rows={rows} onPreview={async () => preview} onCommit={onCommit} />)

    fireEvent.click(await screen.findByTestId('confirm-import'))

    await waitFor(() => expect(onCommit).toHaveBeenCalledWith('tok-1'))
  })

  it('refreshes a stale preview instead of importing over it', async () => {
    const onPreview = jest.fn().mockResolvedValueOnce(preview).mockResolvedValueOnce({ ...preview, token: 'tok-2', changed: 3 })
    const onCommit = jest.fn().mockRejectedValue(new StaleError())
    render(<ImportChangePreview rows={rows} onPreview={onPreview} onCommit={onCommit} />)

    fireEvent.click(await screen.findByTestId('confirm-import'))

    expect(await screen.findByTestId('import-preview-error')).toHaveTextContent(/changed after this preview/)
    await waitFor(() => expect(screen.getByTestId('import-preview-counts')).toHaveTextContent('3 updated'))
    expect(onPreview).toHaveBeenCalledTimes(2)
  })

  it('offers a retry when the preview itself fails', async () => {
    const onPreview = jest.fn().mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(preview)
    render(<ImportChangePreview rows={rows} onPreview={onPreview} onCommit={jest.fn()} />)

    fireEvent.click(await screen.findByText('Try again'))

    expect(await screen.findByTestId('import-preview-counts')).toBeInTheDocument()
  })

  it('shows a commit failure and keeps the preview on screen', async () => {
    const onCommit = jest.fn().mockRejectedValue(new Error('Contact import failed: timeout'))
    render(<ImportChangePreview rows={rows} onPreview={async () => preview} onCommit={onCommit} />)

    fireEvent.click(await screen.findByTestId('confirm-import'))

    expect(await screen.findByTestId('import-preview-error')).toHaveTextContent('timeout')
    expect(screen.getByTestId('confirm-import')).toBeInTheDocument()
  })

  it('shows tag changes: contacts receiving tags, tag-only updates and new tags', async () => {
    render(
      <ImportChangePreview
        rows={rows}
        onPreview={async () => ({
          ...preview,
          tags_assigned: 3,
          tags_only_changed: 1,
          tags_created: ['VIP', 'Workshop 2026'],
        })}
        onCommit={jest.fn()}
      />
    )

    expect(await screen.findByTestId('import-preview-tags-assigned')).toHaveTextContent('3 contact(s) will receive new tags')
    expect(screen.getByTestId('import-preview-tags-only')).toHaveTextContent('1 of the updated contacts change only by receiving tags')
    expect(screen.getByTestId('import-preview-tags-created')).toHaveTextContent('2 new tag(s) will be created: VIP, Workshop 2026.')
  })

  it('lists only the first new tags when there are many', async () => {
    const created = Array.from({ length: 12 }, (_, index) => `t${index}`)
    render(<ImportChangePreview rows={rows} onPreview={async () => ({ ...preview, tags_created: created })} onCommit={jest.fn()} />)

    expect(await screen.findByTestId('import-preview-tags-created')).toHaveTextContent('t9 and 2 more.')
  })

  it('says nothing about tags when the preview carries no tag changes', async () => {
    render(<ImportChangePreview rows={rows} onPreview={async () => preview} onCommit={jest.fn()} />)

    await screen.findByTestId('import-preview-counts')
    expect(screen.queryByTestId('import-preview-tags-assigned')).not.toBeInTheDocument()
    expect(screen.queryByTestId('import-preview-tags-created')).not.toBeInTheDocument()
  })

  it('drops the preview and reloads when what is imported changes (mapping or common tags)', async () => {
    const first = jest.fn().mockResolvedValue(preview)
    let resolveSecond: (value: ImportPreview) => void = () => undefined
    const second = jest.fn(
      () =>
        new Promise<ImportPreview>((resolve) => {
          resolveSecond = resolve
        })
    )
    const onCommit = jest.fn().mockResolvedValue(undefined)
    const { rerender } = render(<ImportChangePreview rows={rows} onPreview={first} onCommit={onCommit} />)
    await screen.findByTestId('confirm-import')

    rerender(<ImportChangePreview rows={rows} onPreview={second} onCommit={onCommit} />)

    // The old preview (and its token) can no longer be committed.
    expect(screen.queryByTestId('confirm-import')).not.toBeInTheDocument()
    await waitFor(() => expect(second).toHaveBeenCalled())
    await act(async () => resolveSecond({ ...preview, token: 'tok-new', tags_assigned: 2 }))
    fireEvent.click(await screen.findByTestId('confirm-import'))
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith('tok-new'))
  })

  it('ignores a slower answer to an older preview request', async () => {
    let resolveOld: (value: ImportPreview) => void = () => undefined
    const older = jest.fn(
      () =>
        new Promise<ImportPreview>((resolve) => {
          resolveOld = resolve
        })
    )
    const newer = jest.fn().mockResolvedValue({ ...preview, token: 'tok-new', changed: 7 })
    const { rerender } = render(<ImportChangePreview rows={rows} onPreview={older} onCommit={jest.fn()} />)

    rerender(<ImportChangePreview rows={rows} onPreview={newer} onCommit={jest.fn()} />)
    expect(await screen.findByTestId('import-preview-counts')).toHaveTextContent('7 updated')

    await act(async () => resolveOld({ ...preview, changed: 99 }))
    expect(screen.getByTestId('import-preview-counts')).toHaveTextContent('7 updated')
  })
})
