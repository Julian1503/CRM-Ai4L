import { fireEvent, render, screen } from '@testing-library/react'

let mockPathname = '/contacts'
jest.mock('next/navigation', () => ({ usePathname: () => mockPathname }))

import Sidebar, { type ActiveView } from './Sidebar'

const VIEWS: ActiveView[] = [
  'contacts',
  'archive',
  'campaigns',
  'imports',
  'integrations',
  'settings',
]

function renderSidebar(pathname = '/contacts', onBeforeNavigate?: (view: ActiveView) => boolean) {
  mockPathname = pathname
  render(<Sidebar onBeforeNavigate={onBeforeNavigate} />)
}

describe('Sidebar', () => {
  describe('badges', () => {
    it('shows how many campaigns are waiting for approval', () => {
      render(
        <Sidebar badges={{ campaigns: 2 }} />
      )

      const badge = screen.getByTestId('nav-badge-campaigns')
      expect(badge).toHaveTextContent('2')
      expect(badge).toHaveAccessibleName('2 waiting for approval')
    })

    it('shows nothing when none are waiting', () => {
      render(
        <Sidebar badges={{ campaigns: 0 }} />
      )

      expect(screen.queryByTestId('nav-badge-campaigns')).toBeNull()
    })

    it('caps a large count so the pill keeps its size', () => {
      render(
        <Sidebar badges={{ campaigns: 140 }} />
      )

      expect(screen.getByTestId('nav-badge-campaigns')).toHaveTextContent('99+')
    })
  })

  describe('navigation', () => {
    it.each(VIEWS)('links "%s" to its route', (view) => {
      renderSidebar()

      expect(screen.getByTestId(`nav-item-${view}`)).toHaveAttribute('href', `/${view}`)
    })

    it('marks the current workspace with aria-current, sub-paths included', () => {
      renderSidebar('/settings')
      expect(screen.getByTestId('nav-item-settings')).toHaveAttribute('aria-current', 'page')
      expect(screen.getByTestId('nav-item-contacts')).not.toHaveAttribute('aria-current')
    })

    it('marks nothing outside the shell', () => {
      renderSidebar('/login')
      expect(document.querySelector('[aria-current="page"]')).toBeNull()
    })

    it('cancels a link the guard refuses, and asks only for another workspace', () => {
      const guard = jest.fn(() => false)
      renderSidebar('/settings', guard)

      const leave = fireEvent.click(screen.getByTestId('nav-item-contacts'))
      expect(leave).toBe(false)
      expect(guard).toHaveBeenCalledWith('contacts')

      guard.mockClear()
      fireEvent.click(screen.getByTestId('nav-item-settings'))
      expect(guard).not.toHaveBeenCalled()
    })

    it('never guards a modified click, which opens elsewhere', () => {
      const guard = jest.fn(() => false)
      renderSidebar('/settings', guard)

      fireEvent.click(screen.getByTestId('nav-item-contacts'), { ctrlKey: true })
      expect(guard).not.toHaveBeenCalled()
    })

    it('opens the mobile More menu of secondary workspaces as links, closing on choice', () => {
      const guard = jest.fn(() => true)
      renderSidebar('/content', guard)

      fireEvent.click(screen.getByTestId('nav-more'))
      const settings = screen.getByTestId('mobile-more-settings')
      expect(settings).toHaveAttribute('href', '/settings')
      expect(screen.getByTestId('mobile-more-content')).toHaveAttribute('aria-current', 'page')

      fireEvent.click(settings)
      expect(guard).toHaveBeenCalledWith('settings')
      expect(screen.queryByTestId('mobile-more-settings')).not.toBeInTheDocument()
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
