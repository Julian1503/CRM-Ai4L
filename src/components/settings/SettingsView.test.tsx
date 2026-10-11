import { act, fireEvent, render, screen } from '@testing-library/react'

import SettingsView from './SettingsView'

// Each panel has its own suite; here they only need to show which one is mounted.
jest.mock('@/components/operations/OperationsPanel', () => ({
  __esModule: true,
  default: () => <p>Operations panel</p>,
}))
jest.mock('./EmailOctopusSettings', () => ({
  __esModule: true,
  default: ({ onSaved }: { onSaved: (status: null) => void }) => (
    <button type="button" onClick={() => onSaved(null)}>
      EmailOctopus panel
    </button>
  ),
}))
jest.mock('./SocialConnectionsSettings', () => ({
  __esModule: true,
  default: () => <p>Social panel</p>,
}))
jest.mock('./JobTypesSettings', () => ({
  __esModule: true,
  default: ({ onChanged }: { onChanged: () => void }) => (
    <button type="button" onClick={onChanged}>
      Job types panel
    </button>
  ),
}))
jest.mock('./OrganisationSettings', () => ({
  __esModule: true,
  default: ({ onChanged }: { onChanged: () => void }) => (
    <button type="button" onClick={onChanged}>
      Organisations panel
    </button>
  ),
}))
jest.mock('./BrandProfileSettings', () => ({
  __esModule: true,
  default: ({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) => (
    <div>
      <p>Brand panel</p>
      <button type="button" onClick={() => onDirtyChange(true)}>
        Make brand dirty
      </button>
    </div>
  ),
}))

function setup(search = '') {
  window.history.replaceState(null, '', `/${search}`)
  const props = {
    emailOctopusStatus: null,
    onEmailOctopusSaved: jest.fn(),
    onJobTypesChanged: jest.fn(),
    onOrganisationsChanged: jest.fn(),
    onOpenStudio: jest.fn(),
    onDirtyChange: jest.fn(),
  }
  render(<SettingsView {...props} />)
  return props
}

const nav = () => screen.getByRole('navigation', { name: 'Settings sections' })
const section = () => new URL(window.location.href).searchParams.get('section')

describe('SettingsView', () => {
  afterEach(() => window.history.replaceState(null, '', '/'))

  it('opens on Overview and moves between sections, recording each in the URL', () => {
    const props = setup()

    expect(screen.getByRole('heading', { name: 'Overview', level: 2 })).toBeInTheDocument()
    expect(screen.getByText('Operations panel')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')

    fireEvent.click(screen.getByRole('link', { name: 'Job types' }))
    expect(screen.getByRole('heading', { name: 'Job types', level: 2 })).toBeInTheDocument()
    expect(screen.queryByText('Operations panel')).not.toBeInTheDocument()
    expect(section()).toBe('job-types')
    expect(new URL(window.location.href).searchParams.get('view')).toBe('settings')
    fireEvent.click(screen.getByRole('button', { name: 'Job types panel' }))
    expect(props.onJobTypesChanged).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('link', { name: 'Organisations' }))
    fireEvent.click(screen.getByRole('button', { name: 'Organisations panel' }))
    expect(props.onOrganisationsChanged).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('link', { name: 'System' }))
    expect(screen.getByRole('region', { name: 'Database configuration' })).toHaveTextContent('Configured')

    // Clicking the active section again changes nothing.
    const length = window.history.length
    fireEvent.click(screen.getByRole('link', { name: 'System' }))
    expect(window.history.length).toBe(length)
  })

  it('leaves modified clicks to the browser, so a section can open in a new tab', () => {
    setup()
    const link = screen.getByRole('link', { name: 'Connections' })
    expect(link).toHaveAttribute('href', '?view=settings&section=connections')

    fireEvent.click(link, { ctrlKey: true })
    expect(screen.getByRole('heading', { name: 'Overview', level: 2 })).toBeInTheDocument()
  })

  it('opens the section named in the URL, and falls back to Overview for an unknown one', () => {
    setup('?view=settings&section=connections')
    expect(screen.getByRole('heading', { name: 'Connections', level: 2 })).toBeInTheDocument()
  })

  it('treats an unknown section as Overview', () => {
    setup('?view=settings&section=nope')
    expect(screen.getByRole('heading', { name: 'Overview', level: 2 })).toBeInTheDocument()
  })

  it('follows the browser back and forward buttons', () => {
    setup()
    fireEvent.click(screen.getByRole('link', { name: 'System' }))

    act(() => {
      window.history.replaceState(null, '', '/?view=settings&section=brand')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(screen.getByRole('heading', { name: 'Brand profile', level: 2 })).toBeInTheDocument()
  })

  it('switches sections from the small-screen picker and the overview shortcuts', () => {
    setup()
    fireEvent.change(screen.getByLabelText('Settings section'), { target: { value: 'organisations' } })
    expect(screen.getByRole('heading', { name: 'Organisations', level: 2 })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Settings section'), { target: { value: 'overview' } })
    fireEvent.click(screen.getByRole('button', { name: /Edit brand profile/ }))
    expect(screen.getByRole('heading', { name: 'Brand profile', level: 2 })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Settings section'), { target: { value: 'overview' } })
    fireEvent.click(screen.getByRole('button', { name: /Manage connections/ }))
    expect(screen.getByRole('heading', { name: 'Connections', level: 2 })).toBeInTheDocument()
  })

  it('switches connection tabs by click and keyboard', () => {
    const props = setup('?section=connections')
    const social = screen.getByRole('tab', { name: 'Social accounts' })
    const email = screen.getByRole('tab', { name: 'Email marketing' })

    expect(social).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Social panel')).toBeVisible()

    fireEvent.keyDown(social, { key: 'ArrowRight' })
    expect(email).toHaveAttribute('aria-selected', 'true')
    expect(email).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'EmailOctopus panel' }))
    expect(props.onEmailOctopusSaved).toHaveBeenCalledWith(null)

    fireEvent.keyDown(email, { key: 'Home' })
    expect(social).toHaveAttribute('aria-selected', 'true')
    expect(social).toHaveFocus()

    fireEvent.keyDown(social, { key: 'a' })
    fireEvent.keyDown(email, { key: 'b' })
    fireEvent.click(email)
    expect(email).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(social)
    expect(social).toHaveAttribute('aria-selected', 'true')
  })

  it('keeps the brand draft mounted while other sections are open', () => {
    setup('?section=brand')
    fireEvent.click(screen.getByRole('link', { name: 'System' }))
    // Hidden, not unmounted: the unsaved draft survives the detour.
    expect(screen.getByText('Brand panel', { selector: 'p' })).not.toBeVisible()
  })

  it('opens Content Studio straight away when the brand is clean', () => {
    const props = setup('?section=brand')
    fireEvent.click(screen.getByRole('button', { name: 'Open Content Studio' }))
    expect(props.onOpenStudio).toHaveBeenCalled()
  })

  it('asks in a dialog before leaving unsaved brand changes for Content Studio', () => {
    const props = setup('?section=brand')
    fireEvent.click(screen.getByRole('button', { name: 'Make brand dirty' }))
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(true)

    fireEvent.click(screen.getByRole('button', { name: 'Open Content Studio' }))
    expect(screen.getByTestId('confirm-dialog')).toHaveTextContent('Discard brand changes?')
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(props.onOpenStudio).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Open Content Studio' }))
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
    expect(props.onOpenStudio).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('confirm-dialog')).toBeNull()
  })

  it('names its navigation landmark', () => {
    setup()
    expect(nav()).toBeInTheDocument()
  })
})
