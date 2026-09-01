'use client'

import type { AutomationCheck } from '@/lib/marketing/providers/emailOctopus'

import styles from './marketing.module.css'

/** A registered template, as `/api/templates` returns it. */
export type TemplateOption = {
  id: string
  name: string
  description: string | null
  provider_automation_id: string | null
}

/** What the registry knows about an id right now, including "we are still asking". */
export type AutomationStatus = AutomationCheck | { status: 'checking' }

type AutomationConnectionFieldProps = {
  value: string
  onChange: (value: string) => void
  /** Registered templates, newest last. Empty until an operator registers one. */
  templates: TemplateOption[]
  /** The live check for `value`, when one has been made. */
  check?: AutomationStatus
  testId: string
}

/** Sentinel for the "type an id by hand" option, which is not itself an id. */
const MANUAL = '__manual__'

export function describeAutomationCheck(check: AutomationStatus | undefined): string | null {
  switch (check?.status) {
    case 'checking':
      return 'Checking with EmailOctopus…'
    case 'valid':
      return 'Verified with EmailOctopus.'
    case 'invalid':
      return 'EmailOctopus does not have an automation with this ID.'
    case 'unauthorised':
      return 'The saved EmailOctopus API key was rejected, so this ID could not be checked.'
    case 'unknown':
      return `Could not check this ID: ${check.error}`
    default:
      return null
  }
}

/**
 * Picks the EmailOctopus automation a campaign sends through.
 *
 * It is a name picker rather than a text box because EmailOctopus publishes no endpoint
 * that lists automations — verified 2026-08-31, see `src/lib/marketing/templates.ts` —
 * so the only way to see a name instead of `b690d44a-a0dd-11f1-9fa9-7381a1ee33bd` is to
 * have recorded one on this side. Hence the registry in Integrations, and hence the
 * manual field below it: an automation created five minutes ago is not in the registry
 * yet, and that must not block a campaign.
 */
export default function AutomationConnectionField({
  value,
  onChange,
  templates,
  check,
  testId,
}: AutomationConnectionFieldProps) {
  const connected = value.trim().length > 0
  const usable = templates.filter((template) => Boolean(template.provider_automation_id?.trim()))
  const matched = usable.find((template) => template.provider_automation_id === value)

  // Manual whenever the id is not one of the registered names — including a blank id
  // with nothing registered, which would otherwise leave no way to enter anything.
  const manual = connected ? !matched : usable.length === 0
  const checkMessage = describeAutomationCheck(check)

  const handlePick = (picked: string) => {
    if (picked === MANUAL) {
      // Cleared rather than kept: leaving the previous template's id in a field
      // labelled "custom" is how a campaign ends up pointing somewhere nobody chose.
      onChange('')
      return
    }

    onChange(picked)
  }

  return (
    <div className={styles.automationField}>
      <div className={styles.automationHeading}>
        <span className={styles.label}>Email template</span>
        <span className={connected ? styles.connectionReady : styles.connectionMissing}>
          {connected ? matched?.name ?? 'Custom ID' : 'Not connected'}
        </span>
      </div>

      <select
        className={styles.input}
        value={manual ? MANUAL : value}
        onChange={(event) => handlePick(event.target.value)}
        aria-label="Email template"
        data-testid={`${testId}-picker`}
      >
        <option value="">Choose a template</option>
        {usable.map((template) => (
          <option key={template.id} value={template.provider_automation_id as string}>
            {template.name}
          </option>
        ))}
        <option value={MANUAL}>Paste an automation ID instead…</option>
      </select>

      {checkMessage && (
        <p
          className={check?.status === 'invalid' ? styles.checkFailed : styles.fieldHint}
          data-testid={`${testId}-check`}
        >
          {checkMessage}
        </p>
      )}

      {usable.length === 0 && (
        <p className={styles.fieldHint}>
          No templates registered yet. Add one under Integrations → Email templates to
          pick it by name here.
        </p>
      )}

      <details className={styles.automationDetails} open={manual && connected}>
        <summary>{manual ? 'Automation ID' : 'Use a different automation ID'}</summary>
        <ol className={styles.automationSteps}>
          <li>Open the automation in EmailOctopus.</li>
          <li>Copy its ID from the automation details or URL.</li>
          <li>Paste it below, then save this campaign.</li>
        </ol>
        <label className={styles.field}>
          <span className={styles.label}>Automation ID</span>
          <input
            className={styles.input}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Paste the EmailOctopus automation ID"
            aria-describedby={`${testId}-help`}
            data-testid={testId}
          />
          <span id={`${testId}-help`} className={styles.fieldHint}>
            Register it under Integrations to reuse it by name.
          </span>
        </label>
        <a
          className={styles.helpLink}
          href="https://emailoctopus.com/help/automations"
          target="_blank"
          rel="noreferrer"
        >
          Open EmailOctopus automation help
        </a>
      </details>
    </div>
  )
}
