import { fireEvent, render, screen } from '@testing-library/react'

import ContactContextMenu, { type ContextMenuItem } from './ContactContextMenu'

function setup() {
  const onClose = jest.fn()
  const items: ContextMenuItem[] = [
    { id: 'open', label: 'Open', onSelect: jest.fn() },
    { id: 'archive', label: 'Archive', onSelect: jest.fn(), separated: true },
    { id: 'remove', label: 'Remove…', onSelect: jest.fn(), tone: 'danger' },
  ]
  render(<ContactContextMenu x={40} y={60} label="Ada Lovelace" items={items} onClose={onClose} />)
  return { onClose, items }
}

describe('ContactContextMenu', () => {
  it('is a named menu with focus on the first item', () => {
    setup()

    expect(screen.getByRole('menu', { name: 'Ada Lovelace' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Open' })).toHaveFocus()
  })

  it('moves with the arrow keys and wraps around', () => {
    setup()
    const menu = screen.getByRole('menu')

    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toHaveFocus()

    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(screen.getByRole('menuitem', { name: 'Remove…' })).toHaveFocus()

    fireEvent.keyDown(menu, { key: 'Home' })
    expect(screen.getByRole('menuitem', { name: 'Open' })).toHaveFocus()
  })

  it('closes, then runs the chosen action', () => {
    const { onClose, items } = setup()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))

    expect(onClose).toHaveBeenCalled()
    expect(items[1].onSelect).toHaveBeenCalledTimes(1)
    expect(items[0].onSelect).not.toHaveBeenCalled()
  })

  it('closes on Escape, Tab, a click elsewhere and on scroll', () => {
    const { onClose } = setup()

    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' })
    fireEvent.mouseDown(document.body)
    fireEvent.scroll(window)

    expect(onClose).toHaveBeenCalledTimes(4)
  })

  it('does not close on a click inside itself', () => {
    const { onClose } = setup()

    fireEvent.mouseDown(screen.getByRole('menuitem', { name: 'Open' }))

    expect(onClose).not.toHaveBeenCalled()
  })
})
