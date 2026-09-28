import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import LifecycleActions from './LifecycleActions'

const fetchMock = jest.fn()

function respond(status: number, body: unknown = {}) {
  fetchMock.mockResolvedValueOnce({ ok: status < 400, status, json: async () => body })
}

function setup(props: Partial<Parameters<typeof LifecycleActions>[0]> = {}) {
  const onChanged = jest.fn()
  render(
    <LifecycleActions
      endpoint="/api/segments/seg-1"
      noun="segment"
      name="NSW leads"
      archived={false}
      onChanged={onChanged}
      {...props}
    />
  )
  return onChanged
}

describe('LifecycleActions', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    global.fetch = fetchMock as never
  })

  it('archives at once, with the shared PATCH body', async () => {
    const onChanged = setup()
    respond(200)

    fireEvent.click(screen.getByTestId('segment-archive'))

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('archive'))
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/segments/seg-1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ archived: true }) })
    )
  })

  it('offers restore instead of archive for an archived record', async () => {
    const onChanged = setup({ archived: true })
    respond(200)

    expect(screen.queryByTestId('segment-archive')).toBeNull()
    fireEvent.click(screen.getByTestId('segment-restore'))

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('restore'))
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ archived: false }))
  })

  it('asks before removing, says nothing is deleted, and starts on Cancel', async () => {
    const onChanged = setup()

    fireEvent.click(screen.getByTestId('segment-remove'))

    const dialog = screen.getByTestId('confirm-dialog')
    expect(dialog).toHaveTextContent('Remove this segment?')
    expect(dialog).toHaveTextContent('NSW leads')
    expect(dialog).toHaveTextContent('Nothing is deleted')
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    expect(fetchMock).not.toHaveBeenCalled()

    respond(200)
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('remove'))
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ removed: true }))
    expect(screen.queryByTestId('confirm-dialog')).toBeNull()
  })

  it('closes the question on Escape without removing, and keeps Escape from the drawer', () => {
    setup()
    const drawerEscape = jest.fn()
    window.addEventListener('keydown', drawerEscape)

    fireEvent.click(screen.getByTestId('segment-remove'))
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByTestId('confirm-dialog')).toBeNull()
    expect(drawerEscape).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    window.removeEventListener('keydown', drawerEscape)
  })

  it('keeps the dialog open with the reason when the server refuses a removal', async () => {
    const onChanged = setup()
    fireEvent.click(screen.getByTestId('segment-remove'))
    respond(409, { error: 'This segment is used by campaign "August offer".' })

    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
    })

    expect(screen.getByTestId('confirm-dialog')).toHaveTextContent('"August offer"')
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('shows a refused archive under the buttons', async () => {
    setup()
    respond(409, { error: 'In use.' })

    await act(async () => {
      fireEvent.click(screen.getByTestId('segment-archive'))
    })

    expect(screen.getByTestId('segment-lifecycle-error')).toHaveTextContent('In use.')
  })

  it('disables what the rules forbid and says why', () => {
    setup({
      lifecycle: {
        canArchive: false,
        canRestore: false,
        canRemove: false,
        reason: 'This segment is used by campaign "August offer". Archive those first.',
      },
    })

    expect(screen.getByTestId('segment-archive')).toBeDisabled()
    expect(screen.getByTestId('segment-remove')).toBeDisabled()
    expect(screen.getByTestId('segment-archive')).toHaveAttribute('title', expect.stringContaining('August offer'))
    expect(screen.getByTestId('segment-blocked')).toHaveTextContent('Archive those first.')
  })
})
