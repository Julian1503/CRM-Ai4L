import { fireEvent, render, screen } from '@testing-library/react'

import AutomationConnectionField, {
  describeAutomationCheck,
  type TemplateOption,
} from './AutomationConnectionField'

const TEMPLATES: TemplateOption[] = [
  {
    id: 't1',
    name: 'August free courses',
    description: null,
    provider_automation_id: 'auto-1',
    consent_stream: 'newsletter',
  },
  {
    id: 't2',
    name: 'Welcome sequence',
    description: null,
    provider_automation_id: 'auto-2',
    consent_stream: 'newsletter',
  },
]

function renderField(props: Partial<React.ComponentProps<typeof AutomationConnectionField>> = {}) {
  const onChange = jest.fn()

  render(
    <AutomationConnectionField
      value=""
      onChange={onChange}
      templates={TEMPLATES}
      testId="campaign-automation"
      {...props}
    />
  )

  return { onChange }
}

describe('AutomationConnectionField', () => {
  it('offers registered templates by name rather than by id', () => {
    // The whole point: EmailOctopus cannot list its automations, so a name only exists
    // here if someone recorded it.
    renderField()

    expect(screen.getByRole('option', { name: 'August free courses' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Welcome sequence' })).toBeInTheDocument()
  })

  it('reports the chosen template as its automation id', () => {
    const { onChange } = renderField()

    fireEvent.change(screen.getByTestId('campaign-automation-picker'), {
      target: { value: 'auto-2' },
    })

    expect(onChange).toHaveBeenCalledWith('auto-2')
  })

  it('names the connected template instead of showing a bare UUID', () => {
    renderField({ value: 'auto-1' })

    // Once as the selected option, once as the status chip beside the label — the
    // chip is what makes the connection readable without opening the picker.
    expect(screen.getAllByText('August free courses')).toHaveLength(2)
    expect(screen.getByTestId('campaign-automation-picker')).toHaveValue('auto-1')
  })

  it('keeps a manual id usable, since a new automation is not registered yet', () => {
    const { onChange } = renderField({ value: 'auto-unregistered' })

    // Not one of the registered names, so the picker sits on the manual option and the
    // id is still editable rather than being silently replaced.
    expect(screen.getByTestId('campaign-automation')).toHaveValue('auto-unregistered')
    expect(screen.getByText('Custom ID')).toBeInTheDocument()

    fireEvent.change(screen.getByTestId('campaign-automation'), {
      target: { value: 'auto-typed' },
    })
    expect(onChange).toHaveBeenCalledWith('auto-typed')
  })

  it('clears the id when the operator switches to manual entry', () => {
    // Leaving the previous template's id under a field labelled "custom" is how a
    // campaign ends up pointing somewhere nobody chose.
    const { onChange } = renderField({ value: 'auto-1' })

    fireEvent.change(screen.getByTestId('campaign-automation-picker'), {
      target: { value: '__manual__' },
    })

    expect(onChange).toHaveBeenCalledWith('')
  })

  it('says an id EmailOctopus does not have is not there', () => {
    renderField({ value: 'auto-1', check: { status: 'invalid', error: 'Journey not found.' } })

    expect(screen.getByTestId('campaign-automation-check')).toHaveTextContent(
      /does not have an automation with this ID/i
    )
  })

  it('confirms a verified id', () => {
    renderField({ value: 'auto-1', check: { status: 'valid' } })

    expect(screen.getByTestId('campaign-automation-check')).toHaveTextContent(/Verified/i)
  })

  it('does not call an unchecked id wrong', () => {
    // A check that could not complete says nothing about the id. Presenting it as a
    // failure would send an operator to change a setting that was correct.
    renderField({ value: 'auto-1', check: { status: 'unknown', error: 'Slow down.' } })

    const message = screen.getByTestId('campaign-automation-check').textContent ?? ''
    expect(message).toMatch(/Could not check/i)
    expect(message).not.toMatch(/does not have/i)
  })

  it('points at the registry when nothing is registered', () => {
    renderField({ templates: [] })

    expect(screen.getByText(/Integrations → Email templates/)).toBeInTheDocument()
  })

  it('ignores a template with no automation id, which cannot send', () => {
    renderField({
      templates: [{ id: 't3', name: 'Half-registered', description: null, provider_automation_id: null, consent_stream: 'newsletter' }],
    })

    expect(screen.queryByRole('option', { name: 'Half-registered' })).not.toBeInTheDocument()
  })
})

describe('describeAutomationCheck', () => {
  it('says nothing when nothing has been checked', () => {
    expect(describeAutomationCheck(undefined)).toBeNull()
  })

  it('distinguishes a rejected key from a missing automation', () => {
    // Same 4xx family, opposite fixes.
    expect(describeAutomationCheck({ status: 'unauthorised', error: 'nope' })).toMatch(
      /API key/i
    )
    expect(describeAutomationCheck({ status: 'invalid', error: 'nope' })).toMatch(
      /does not have/i
    )
  })
})
