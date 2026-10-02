'use client'

import { useCallback, useState } from 'react'

import type { ContentAsset, ContentVariant, SocialAccount, SocialPlatform, SocialPublication } from '@/lib/content-studio/types'

import { ApiError, createPublication, errorMessage, isUnavailable, listAccounts, preflightPublication } from './api'
import Dialog from './Dialog'
import { useIdempotencyKey, useResource } from './hooks'
import { CHANNEL_LABELS, PUBLICATION_STATUS_LABELS, PUBLICATION_TONES, isSocialChannel } from './labels'
import { previewImages } from './revision'
import SocialPreview from './SocialPreview'
import { StatusPill } from './StatusPill'
import styles from './ContentStudio.module.css'
import dialogStyles from './Dialog.module.css'
import jobStyles from './Jobs.module.css'

type PublishDialogProps = {
  variant: ContentVariant
  assets: ContentAsset[]
  onClose: () => void
  onPublished: (publication: SocialPublication) => void
  onOpenSettings?: () => void
}

/**
 * The last step before a post leaves the CRM. The account is chosen explicitly, the
 * server's preflight decides readiness and supplies the exact text, and publishing
 * needs a second, named confirmation. The client never judges readiness itself.
 */
export default function PublishDialog({ variant, assets, onClose, onPublished, onOpenSettings }: PublishDialogProps) {
  const platform = isSocialChannel(variant.channel) ? variant.channel : null
  const revision = variant.current
  const label = CHANNEL_LABELS[variant.channel]

  const accounts = useResource(listAccounts)
  const eligible = (accounts.data?.accounts ?? []).filter((account) => account.platform === platform)
  const connected = eligible.filter((account) => account.status === 'connected')
  const [chosenId, setChosenId] = useState<string | null>(null)
  const accountId = chosenId ?? connected[0]?.id ?? null
  const account = eligible.find((candidate) => candidate.id === accountId) ?? null

  const preflightKey = useIdempotencyKey()
  const publishKey = useIdempotencyKey()
  const revisionId = revision?.id ?? null

  const loadPreflight = useCallback(async () => {
    if (!accountId || !revisionId) return null
    return preflightPublication({ revisionId, accountId, idempotencyKey: preflightKey.keyFor(`${revisionId}:${accountId}`) })
  }, [accountId, revisionId, preflightKey])
  const preflight = useResource(loadPreflight)

  const [armed, setArmed] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [publication, setPublication] = useState<SocialPublication | null>(null)

  const enabled = platform !== null && (accounts.data?.enabledPlatforms ?? []).includes(platform)
  const blocking = (preflight.data?.issues ?? []).filter((issue) => issue.blocking)
  const canPublish =
    enabled && account?.status === 'connected' && preflight.data?.ok === true && blocking.length === 0 && !preflight.loading && !publishing && !publication

  const publish = async () => {
    if (!accountId || !revisionId) return
    setPublishing(true)
    setPublishError(null)
    try {
      const idempotencyKey = publishKey.keyFor(`${revisionId}:${accountId}`)
      const result = await createPublication({ revisionId, accountId, idempotencyKey })
      publishKey.settle()
      setPublication(result)
      onPublished(result)
    } catch (error) {
      setPublishError(describePublishError(error))
      if (error instanceof ApiError && error.code === 'preflight_failed') preflight.reload()
    } finally {
      setPublishing(false)
      setArmed(false)
    }
  }

  const footer = publication ? (
    <button type="button" className={styles.primaryBtn} onClick={onClose}>
      Done
    </button>
  ) : armed && account ? (
    <>
      <span className={jobStyles.confirmText}>
        Publish to <strong>{account.displayName}</strong> on {label} now? This cannot be undone from the CRM.
      </span>
      <button type="button" className={styles.secondaryBtn} onClick={() => setArmed(false)} disabled={publishing}>
        Not yet
      </button>
      <button type="button" className={styles.dangerBtn} onClick={publish} disabled={!canPublish}>
        {publishing ? 'Publishing…' : `Yes, publish to ${account.displayName}`}
      </button>
    </>
  ) : (
    <>
      <button type="button" className={styles.secondaryBtn} onClick={onClose}>
        Cancel
      </button>
      <button type="button" className={styles.primaryBtn} onClick={() => setArmed(true)} disabled={!canPublish}>
        Publish to {label}…
      </button>
    </>
  )

  return (
    <Dialog title={`Publish to ${label}`} hint="Sends this revision to a live account." onClose={onClose} busy={publishing} wide footer={footer}>
      {publication ? (
        <PublicationResult publication={publication} label={label} />
      ) : (
        <>
          <AccountsSection
            platform={platform}
            label={label}
            loading={accounts.loading}
            error={accounts.error}
            enabled={enabled}
            accounts={eligible}
            accountId={accountId}
            onChoose={(id) => {
              setChosenId(id)
              setArmed(false)
            }}
            onOpenSettings={onOpenSettings}
          />

          {Boolean(preflight.error) && (
            <p className={styles.error} role="alert">
              {errorMessage(preflight.error, 'Could not check this post.')}{' '}
              <button type="button" className={styles.linkBtn} onClick={preflight.reload}>
                Check again
              </button>
            </p>
          )}

          {accountId && preflight.loading && <p className={styles.muted} role="status">Checking the post against {label}&apos;s rules…</p>}

          {preflight.data && platform && (
            <section className={dialogStyles.dialogSection} aria-label="Exactly what will be sent">
              <p className={styles.sectionLabel}>
                Exactly what will be sent · {preflight.data.composedText.length.toLocaleString()} / {preflight.data.limits.maxChars.toLocaleString()} characters
              </p>
              <SocialPreview
                platform={platform}
                text={preflight.data.composedText}
                images={previewImages(revision?.assets ?? [], assets)}
                accountName={account?.displayName}
              />
              {preflight.data.issues.length > 0 && (
                <ul className={jobStyles.issueList} aria-label="Preflight issues">
                  {preflight.data.issues.map((issue) => (
                    <li key={issue.code} className={issue.blocking ? jobStyles.issueBlocking : jobStyles.issueWarning}>
                      <strong>{issue.blocking ? 'Blocking' : 'Worth a look'}:</strong> {issue.message}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {publishError && (
            <p className={styles.error} role="alert">
              {publishError}
            </p>
          )}
        </>
      )}
    </Dialog>
  )
}

export function describePublishError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'already_published') return 'This revision is already published to that account.'
    if (error.code === 'not_approved') return 'This revision is no longer approved. Review it again before publishing.'
    if (error.code === 'account_not_connected') return 'The account is not connected any more. Reconnect it in Settings.'
    if (error.code === 'preflight_failed') return `The post no longer passes the checks: ${error.message}`
  }
  return errorMessage(error, 'Publishing failed.')
}

type AccountsSectionProps = {
  platform: SocialPlatform | null
  label: string
  loading: boolean
  error: unknown
  enabled: boolean
  accounts: SocialAccount[]
  accountId: string | null
  onChoose: (id: string) => void
  onOpenSettings?: () => void
}

function AccountsSection({ platform, label, loading, error, enabled, accounts, accountId, onChoose, onOpenSettings }: AccountsSectionProps) {
  const settingsLink = onOpenSettings ? (
    <button type="button" className={styles.linkBtn} onClick={onOpenSettings}>
      Open connections in Settings
    </button>
  ) : null

  if (!platform) return <p className={styles.warningNote}>Email variants are not published to a social network.</p>
  if (loading) return <p className={styles.muted}>Loading connected accounts…</p>
  if (isUnavailable(error)) return <p className={styles.warningNote}>Social publishing is not available in this CRM yet.</p>
  if (error) return <p className={styles.error} role="alert">{errorMessage(error, 'Could not load connected accounts.')}</p>
  if (!enabled) {
    return (
      <p className={styles.warningNote} role="status">
        Publishing to {label} is switched off for this CRM. It is turned on once the {label} connection has been approved
        and tested; until then, copy the text and post it by hand.
      </p>
    )
  }
  if (accounts.length === 0) {
    return (
      <p className={styles.warningNote}>
        No {label} account is connected. {settingsLink}
      </p>
    )
  }

  return (
    <fieldset className={styles.fieldset}>
      <legend className={styles.sectionLabel}>Destination account</legend>
      <div className={jobStyles.accountList}>
        {accounts.map((account) => (
          <label key={account.id} className={jobStyles.accountOption}>
            <input
              type="radio"
              name="publish-account"
              value={account.id}
              checked={account.id === accountId}
              disabled={account.status !== 'connected'}
              onChange={() => onChoose(account.id)}
            />
            <span>
              <strong>{account.displayName}</strong>
              <span className={styles.itemMeta}>
                {' '}
                · {account.authorKind.replace('_', ' ')}
                {account.status !== 'connected' && ` · ${account.status === 'needs_reauth' ? 'needs reconnecting' : 'disconnected'}`}
              </span>
            </span>
          </label>
        ))}
      </div>
      {accounts.some((account) => account.status !== 'connected') && settingsLink}
    </fieldset>
  )
}

function PublicationResult({ publication, label }: { publication: SocialPublication; label: string }) {
  return (
    <div className={jobStyles.result} role="status">
      <StatusPill tone={PUBLICATION_TONES[publication.status]}>{PUBLICATION_STATUS_LABELS[publication.status]}</StatusPill>
      {publication.status === 'published' && <p>Published to {label}.</p>}
      {(publication.status === 'queued' || publication.status === 'dispatching') && (
        <p>Queued. Publishing runs in the background; follow it under Publications.</p>
      )}
      {publication.status === 'uncertain' && (
        <p>{label} did not confirm the result. Check the account before trying again, then record the outcome under Publications.</p>
      )}
      {publication.errorMessage && <p className={styles.inlineError}>{publication.errorMessage}</p>}
      {publication.permalink && (
        <a href={publication.permalink} target="_blank" rel="noopener noreferrer" className={styles.externalLink}>
          View the post ↗
        </a>
      )}
    </div>
  )
}
