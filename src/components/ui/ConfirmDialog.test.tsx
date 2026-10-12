import { fireEvent, render, screen } from '@testing-library/react'

import ConfirmDialog from './ConfirmDialog'

function setup(props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onConfirm = jest.fn()
  const onClose = jest.fn()
  render(
    <ConfirmDialog title="Do it?" confirmLabel="Do it" onConfirm={onConfirm} onClose={onClose} {...props}>
      <p>Body</p>
    </ConfirmDialog>
  )
  return { onConfirm, onClose }
}

describe('ConfirmDialog', () => {
  it('is a danger question by default, with focus on Cancel', () => {
    setup()
    const dialog = screen.getByRole('alertdialog', { name: 'Do it?' })
    expect(dialog.className).not.toMatch(/neutral/)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
  })

  it('takes a neutral tone and a custom cancel label', () => {
    const { onClose, onConfirm } = setup({ tone: 'neutral', cancelLabel: 'Keep editing' })
    expect(screen.getByRole('alertdialog').className).toMatch(/neutral/)

    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(onClose).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
    expect(onConfirm).toHaveBeenCalled()
  })

  it('shows the busy label and error, and ignores Escape while busy', () => {
    const { onClose } = setup({ busy: true, busyLabel: 'Doing…', error: 'Nope', subject: 'Thing' })
    expect(screen.getByTestId('confirm-dialog-confirm')).toHaveTextContent('Doing…')
    expect(screen.getByRole('alert')).toHaveTextContent('Nope')
    expect(screen.getByText('Thing')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})
