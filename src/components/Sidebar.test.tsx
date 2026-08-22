import { fireEvent, render, screen } from '@testing-library/react'

import Sidebar, { type ActiveView } from './Sidebar'

const VIEWS: ActiveView[] = [
  'contacts',
  'archive',
  'campaigns',
  'imports',
  'integrations',
  'settings',
]

function renderSidebar(currentView: ActiveView = 'contacts') {
  const onViewChange = jest.fn()
  render(<Sidebar currentView={currentView} onViewChange={onViewChange} />)
  return { onViewChange }
}

describe('Sidebar', () => {
  describe('navigation', () => {
    it('offers every workspace', () => {
      renderSidebar()

      for (const view of VIEWS) {
        expect(screen.getByTestId(`nav-item-${view}`)).toBeInTheDocument()
      }
    })

    it.each(VIEWS)('reports a click on "%s"', (view) => {
      const { onViewChange } = renderSidebar()

      fireEvent.click(screen.getByTestId(`nav-item-${view}`))

      expect(onViewChange).toHaveBeenCalledWith(view)
    })
  })

  describe('collapse', () => {
    it('names the toggle by what it will do', () => {
      renderSidebar()

      expect(screen.getByLabelText('Collapse sidebar')).toBeInTheDocument()
    })

    it('renames the toggle once collapsed', () => {
      renderSidebar()

      fireEvent.click(screen.getByLabelText('Collapse sidebar'))

      expect(screen.getByLabelText('Expand sidebar')).toBeInTheDocument()
    })

    it('toggles back', () => {
      renderSidebar()

      fireEvent.click(screen.getByLabelText('Collapse sidebar'))
      fireEvent.click(screen.getByLabelText('Expand sidebar'))

      expect(screen.getByLabelText('Collapse sidebar')).toBeInTheDocument()
    })
  })

  describe('sign out', () => {
    it('posts to the logout route rather than linking to it', () => {
      // A GET logout is CSRF-able, and a plain form keeps sign-out working if the
      // client bundle fails to load.
      renderSidebar()

      const button = screen.getByTestId('sign-out')
      const form = button.closest('form')

      expect(form).toHaveAttribute('action', '/auth/logout')
      expect(form).toHaveAttribute('method', 'post')
      expect(button).toHaveAttribute('type', 'submit')
    })

    it('gives the icon-only button an accessible name', () => {
      renderSidebar()

      expect(screen.getByText('Sign out')).toBeInTheDocument()
    })
  })

  describe('reduced motion', () => {
    const original = window.matchMedia

    afterEach(() => {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: original,
      })
    })

    it('still collapses when motion is reduced', () => {
      // The collapse is not decorative: the sidebar has to reach the collapsed width
      // either way, so reduced motion shortens the timeline rather than skipping it.
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: jest.fn().mockReturnValue({ matches: true }),
      })

      renderSidebar()
      fireEvent.click(screen.getByLabelText('Collapse sidebar'))

      expect(screen.getByLabelText('Expand sidebar')).toBeInTheDocument()
    })
  })
})
