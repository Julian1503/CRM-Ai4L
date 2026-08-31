'use client'

import styles from './marketing.module.css'

type AutomationConnectionFieldProps = {
  value: string
  onChange: (value: string) => void
  testId: string
}

export default function AutomationConnectionField({ value, onChange, testId }: AutomationConnectionFieldProps) {
  const connected = value.trim().length > 0

  return (
    <div className={styles.automationField}>
      <div className={styles.automationHeading}>
        <span className={styles.label}>Email template connection</span>
        <span className={connected ? styles.connectionReady : styles.connectionMissing}>
          {connected ? 'Connected' : 'Needs setup'}
        </span>
      </div>
      <p className={styles.fieldHint}>
        This campaign sends through an EmailOctopus automation using the “Started via API” trigger.
      </p>
      <details className={styles.automationDetails} open={!connected}>
        <summary>{connected ? 'Change EmailOctopus connection' : 'Connect an EmailOctopus automation'}</summary>
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
            This technical value is only needed once to connect the template.
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
