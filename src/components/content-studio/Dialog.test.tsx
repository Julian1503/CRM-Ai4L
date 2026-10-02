import { fireEvent, render, screen } from '@testing-library/react'

import Dialog from './Dialog'
import PromptDialog from './PromptDialog'

describe('Dialog', () => {
  it('focuses the first control, traps Tab, and closes on the backdrop', () => {
    const onClose = jest.fn()
    render(
      <Dialog title="Title" onClose={onClose} footer={<button type="button">Last</button>}>
        <button type="button">First</button>
      </Dialog>
    )
    const first = screen.getByRole('button', { name: 'First' })
    const last = screen.getByRole('button', { name: 'Last' })
    expect(document.activeElement).toBe(first)

    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
    fireEvent.keyDown(last, { key: 'a' })
    fireEvent.keyDown(first, { key: 'Tab' })

    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('dialog').parentElement as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'x' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('focuses the dialog itself when it has no controls, and ignores Tab', () => {
    render(
      <Dialog title="Empty" hint="Nothing here" onClose={jest.fn()}>
        <p>Text</p>
      </Dialog>
    )
    const dialog = screen.getByRole('dialog', { name: 'Empty' })
    expect(dialog).toHaveAccessibleDescription('Nothing here')
    expect(document.activeElement).toBe(dialog)
    fireEvent.keyDown(dialog, { key: 'Tab' })
  })

  it('does not close while busy', () => {
    const onClose = jest.fn()
    render(
      <Dialog title="Busy" busy onClose={onClose}>
        <p>Working</p>
      </Dialog>
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByRole('dialog').parentElement as HTMLElement)
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('PromptDialog', () => {
  it('submits an optional blank answer and shows busy state', () => {
    const onSubmit = jest.fn()
    const { rerender } = render(<PromptDialog title="Ask" label="Note" confirmLabel="Go" onSubmit={onSubmit} onClose={jest.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    expect(onSubmit).toHaveBeenCalledWith('')

    rerender(<PromptDialog title="Ask" label="Note" confirmLabel="Go" busy onSubmit={onSubmit} onClose={jest.fn()} />)
    expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled()
  })
})
