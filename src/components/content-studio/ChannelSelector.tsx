'use client'

import type { ContentChannel } from '@/lib/content-studio/types'
import { CONTENT_CHANNELS } from '@/lib/content-studio/types'
import { listAccounts } from './api'
import { useResource } from './hooks'
import { CHANNEL_LABELS } from './labels'
import styles from './ContentStudio.module.css'

const MARKS: Record<ContentChannel, string> = { facebook: 'f', instagram: 'ig', linkedin: 'in', email: '@' }

export default function ChannelSelector({ value, onChange, disabled = false, error }: { value: ContentChannel[]; onChange: (value: ContentChannel[]) => void; disabled?: boolean; error?: string }) {
  const accounts = useResource(listAccounts)

  const toggle = (channel: ContentChannel) => onChange(
    value.includes(channel)
      ? value.filter((item) => item !== channel)
      : CONTENT_CHANNELS.filter((item) => item === channel || value.includes(item))
  )

  const status = (channel: ContentChannel) => {
    if (channel === 'email') return 'Create an email draft'
    if (accounts.error) return 'Connection status unavailable'
    if (!accounts.data) return 'Checking connection…'
    if (!accounts.data.enabledPlatforms.includes(channel)) return 'Publishing unavailable'
    const matches = accounts.data.accounts.filter((account) => account.platform === channel)
    if (matches.some((account) => account.status === 'connected')) return 'Connected for publishing'
    if (matches.some((account) => account.status === 'needs_reauth')) return 'Reconnect before publishing'
    return 'Connect before publishing'
  }

  return (
    <fieldset className={styles.channelSelector} aria-describedby={error ? 'channel-selector-error' : undefined} disabled={disabled}>
      <legend>Channels</legend>
      <p>Choose where to generate content. Connect accounts when you publish.</p>
      <div className={styles.channelTiles}>
        {CONTENT_CHANNELS.map((channel) => (
          <label key={channel} className={`${styles.channelTile} ${styles[`tile${channel[0].toUpperCase()}${channel.slice(1)}`]}`}>
            <input type="checkbox" checked={value.includes(channel)} onChange={() => toggle(channel)} />
            <span className={styles.channelMark} aria-hidden="true">{MARKS[channel]}</span>
            <span className={styles.channelCopy}>
              <strong>{CHANNEL_LABELS[channel]}</strong>
              <small>{status(channel)}</small>
            </span>
            <span className={styles.tileCheck} aria-hidden="true" />
          </label>
        ))}
      </div>
      {error && <p className={styles.fieldError} id="channel-selector-error">{error}</p>}
    </fieldset>
  )
}
