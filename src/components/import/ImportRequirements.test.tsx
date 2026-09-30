import { fireEvent, render, screen } from '@testing-library/react'

import { IMPORT_REQUIREMENT_OPTIONS } from '@/lib/contacts/importFields'

import ImportRequirements from './ImportRequirements'

function setup() {
  render(<ImportRequirements />)
  const trigger = screen.getByRole('button', { name: /which columns do i need/i })
  const tooltip = screen.getByRole('tooltip', { hidden: true })
  return { trigger, tooltip }
}

describe('ImportRequirements', () => {
  it('is described by the tooltip without relying on title', () => {
    const { trigger, tooltip } = setup()

    expect(trigger).toHaveAttribute('aria-describedby', tooltip.id)
    expect(trigger).not.toHaveAttribute('title')
    expect(trigger).toHaveAccessibleDescription(/Email \+ First Name \+ Last Name/)
    expect(tooltip).not.toBeVisible()
  })

  it('lists the same requirement options the mapping validation checks', () => {
    const { tooltip } = setup()

    for (const option of IMPORT_REQUIREMENT_OPTIONS) {
      expect(tooltip).toHaveTextContent(option.label)
    }
    expect(tooltip).toHaveTextContent(/first and a last name/)
    expect(tooltip).toHaveTextContent(/never erase/)
    expect(tooltip).toHaveTextContent('VIP; Workshop 2026')
    expect(tooltip).toHaveTextContent(/80 characters per tag and 50 tags per contact/)
  })

  it('opens on keyboard focus and closes with Escape', () => {
    const { trigger, tooltip } = setup()

    fireEvent.focus(trigger)
    expect(tooltip).toBeVisible()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(tooltip).not.toBeVisible()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens on hover and closes when the pointer leaves', () => {
    const { tooltip } = setup()
    const wrapper = screen.getByTestId('import-requirements')

    fireEvent.pointerEnter(wrapper)
    expect(tooltip).toBeVisible()

    fireEvent.pointerLeave(wrapper)
    expect(tooltip).not.toBeVisible()
  })

  it('toggles on click or tap, for screens without hover', () => {
    const { trigger, tooltip } = setup()

    fireEvent.click(trigger)
    expect(tooltip).toBeVisible()

    fireEvent.click(trigger)
    expect(tooltip).not.toBeVisible()
  })

  it('closes a pinned panel on a tap elsewhere', () => {
    const { trigger, tooltip } = setup()

    fireEvent.click(trigger)
    fireEvent.pointerDown(document.body)

    expect(tooltip).not.toBeVisible()
  })

  it('stays pinned when the pointer leaves after a click', () => {
    const { trigger, tooltip } = setup()
    const wrapper = screen.getByTestId('import-requirements')

    fireEvent.pointerEnter(wrapper)
    fireEvent.click(trigger)
    fireEvent.pointerLeave(wrapper)

    expect(tooltip).toBeVisible()
  })

  it('reopens on the next focus after Escape', () => {
    const { trigger, tooltip } = setup()

    fireEvent.focus(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.blur(trigger)
    fireEvent.focus(trigger)

    expect(tooltip).toBeVisible()
  })
})
