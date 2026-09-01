'use client'

import { useCallback, useEffect, useState } from 'react'

import type { CampaignTemplateRow } from '@/lib/db/types'

import { describeAutomationCheck, type AutomationStatus } from './AutomationConnectionField'
import styles from './marketing.module.css'

/**
 * Names for EmailOctopus automations.
 *
 * EmailOctopus has no endpoint that lists automations — verified against the live v2
 * API on 2026-08-31 — so a campaign could only be pointed at one by pasting a raw UUID,
 * and a wrong paste stayed invisible until every recipient of a send failed. This
 * screen answers both halves: a name is recorded once here and picked by name
 * afterwards, and the ID is checked against EmailOctopus before it is saved.
 */

type Template = Pick<
  CampaignTemplateRow,
  'id' | 'name' | 'description' | 'provider_automation_id' | 'archived_at'
>

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => ({}))
  return body.error || `Request failed (HTTP ${response.status})`
}

export default function EmailTemplateRegistry() {
  const [templates, setTemplates] = useState<Template[]>([])
  const [checks, setChecks] = useState<Record<string, AutomationStatus>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [automationId, setAutomationId] = useState('')

  const check = useCallback(async (ids: string[]) => {
    const wanted = [...new Set(ids.map((id) => id.trim()).filter((id) => id !== ''))]

    if (wanted.length === 0) return

    setChecks((current) => ({
      ...current,
      ...Object.fromEntries(wanted.map((id) => [id, { status: 'checking' } as AutomationStatus])),
    }))

    try {
      const response = await fetch('/api/integrations/emailoctopus/automations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ automationIds: wanted }),
      })

      const body = await response.json().catch(() => ({}))
      // A failed check reports `unknown`, never `invalid`: "we could not ask" and
      // "EmailOctopus does not have this" lead an operator to opposite actions.
      const fallback: AutomationStatus = {
        status: 'unknown',
        error: typeof body?.error === 'string' ? body.error : 'The check failed.',
      }
      const results = (response.ok ? (body?.results ?? {}) : {}) as Record<
        string,
        AutomationStatus
      >

      setChecks((current) => ({
        ...current,
        ...Object.fromEntries(wanted.map((id) => [id, results[id] ?? fallback])),
      }))
    } catch {
      setChecks((current) => ({
        ...current,
        ...Object.fromEntries(
          wanted.map((id) => [
            id,
            { status: 'unknown', error: 'EmailOctopus could not be reached.' } as AutomationStatus,
          ])
        ),
      }))
    }
  }, [])

  const load = useCallback(async () => {
    try {
      // Archived rows included: this screen is where they are restored from, which is
      // the only place they can be seen at all.
      const response = await fetch('/api/templates?includeArchived=true')

      if (!response.ok) throw new Error(await readError(response))

      const body = await response.json()
      const loaded: Template[] = body.templates ?? []

      setTemplates(loaded)
      void check(
        loaded
          .filter((template) => !template.archived_at)
          .map((template) => template.provider_automation_id ?? '')
      )
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load templates.')
    }
  }, [check])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const register = async () => {
    setError(null)
    setBusy('create')

    try {
      const response = await fetch('/api/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, providerAutomationId: automationId }),
      })

      if (!response.ok) throw new Error(await readError(response))

      setName('')
      setDescription('')
      setAutomationId('')
      await load()
    } catch (createError) {
      setError(
        createError instanceof Error ? createError.message : 'Could not register the template.'
      )
    } finally {
      setBusy(null)
    }
  }

  const setArchived = async (template: Template, archived: boolean) => {
    setError(null)
    setBusy(template.id)

    try {
      const response = await fetch(`/api/templates/${template.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived }),
      })

      if (!response.ok) throw new Error(await readError(response))

      await load()
    } catch (archiveError) {
      setError(
        archiveError instanceof Error ? archiveError.message : 'Could not update the template.'
      )
    } finally {
      setBusy(null)
    }
  }

  const draftCheck = checks[automationId.trim()]
  const draftMessage = describeAutomationCheck(draftCheck)

  return (
    <section className={styles.panel} aria-labelledby="templates-heading">
      <h2 id="templates-heading" className={styles.panelTitle}>
        Email templates
      </h2>
      <p className={styles.panelHint}>
        EmailOctopus offers no way to list automations, so each one is named here once
        and then picked by name when a campaign is created.
      </p>

      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}

      <div className={styles.formRow}>
        <label className={styles.field}>
          <span className={styles.label}>Template name</span>
          <input
            className={styles.input}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="August free courses"
            data-testid="template-name"
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Description</span>
          <input
            className={styles.input}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Seasonal offer, booking button"
            data-testid="template-description"
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>EmailOctopus automation ID</span>
          <input
            className={styles.input}
            value={automationId}
            onChange={(event) => setAutomationId(event.target.value)}
            placeholder="b690d44a-a0dd-11f1-9fa9-7381a1ee33bd"
            data-testid="template-automation"
          />
          {draftMessage && (
            <span
              className={
                draftCheck?.status === 'valid'
                  ? styles.checkOk
                  : draftCheck?.status === 'checking'
                    ? styles.fieldHint
                    : styles.checkFailed
              }
              data-testid="template-check"
            >
              {draftMessage}
            </span>
          )}
        </label>
      </div>

      <div className={styles.templateActions}>
        <button
          type="button"
          className={styles.secondaryBtn}
          onClick={() => void check([automationId])}
          disabled={!automationId.trim() || busy !== null}
          data-testid="verify-template"
        >
          Check ID
        </button>
        <button
          type="button"
          className={styles.primaryBtn}
          onClick={register}
          disabled={!name.trim() || !automationId.trim() || busy !== null}
          data-testid="create-template"
        >
          {busy === 'create' ? 'Saving…' : 'Register template'}
        </button>
      </div>

      <ul className={styles.list}>
        {templates.length === 0 && <li className={styles.empty}>No templates registered yet.</li>}
        {templates.map((template) => {
          const status = checks[template.provider_automation_id ?? '']
          const message = describeAutomationCheck(status)

          return (
            <li key={template.id} className={styles.campaignItem}>
              <div className={styles.campaignMain}>
                <span className={styles.itemName}>{template.name}</span>
                <span className={styles.itemMeta}>
                  {template.description ? `${template.description} · ` : ''}
                  {template.provider_automation_id}
                  {template.archived_at && ' · archived'}
                </span>
                {message && !template.archived_at && (
                  <span
                    className={status?.status === 'valid' ? styles.checkOk : styles.checkFailed}
                    data-testid={`template-status-${template.id}`}
                  >
                    {message}
                  </span>
                )}
              </div>

              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  onClick={() => void check([template.provider_automation_id ?? ''])}
                  disabled={busy !== null || Boolean(template.archived_at)}
                  data-testid={`recheck-${template.id}`}
                >
                  Re-check
                </button>
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  onClick={() => setArchived(template, !template.archived_at)}
                  disabled={busy !== null}
                  data-testid={`archive-${template.id}`}
                >
                  {template.archived_at ? 'Restore' : 'Archive'}
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
