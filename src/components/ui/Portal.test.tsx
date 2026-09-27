import { render, screen } from '@testing-library/react'

import Portal from './Portal'

describe('Portal', () => {
  it('renders its children at the body, outside the component tree it sits in', () => {
    const { container } = render(
      <main data-testid="main-column">
        <Portal>
          <div data-testid="overlay" />
        </Portal>
      </main>
    )

    const overlay = screen.getByTestId('overlay')

    expect(overlay.parentElement).toBe(document.body)
    expect(container.contains(overlay)).toBe(false)
  })
})
