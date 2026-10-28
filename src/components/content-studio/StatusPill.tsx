import type { ContentChannel } from '@/lib/content-studio/types'

import { CHANNEL_LABELS, type Tone } from './labels'
import styles from './ContentStudio.module.css'

const TONE_CLASS: Record<Tone, string> = {
  neutral: styles.toneNeutral,
  info: styles.toneInfo,
  success: styles.toneSuccess,
  warning: styles.toneWarning,
  danger: styles.toneDanger,
}

export function StatusPill({ tone, children }: { tone: Tone; children: string }) {
  return <span className={`${styles.pill} ${TONE_CLASS[tone]}`}>{children}</span>
}

const CHANNEL_CLASS: Record<ContentChannel, string> = {
  facebook: styles.channelFacebook,
  instagram: styles.channelInstagram,
  email: styles.channelEmail,
}

export function ChannelTag({ channel }: { channel: ContentChannel }) {
  // Items stored before a channel was dropped (LinkedIn, 2026-10-28) still name it.
  const label = CHANNEL_LABELS[channel] ?? `${channel} (retired)`
  const toneClass = CHANNEL_CLASS[channel] ?? ''

  return <span className={`${styles.channel} ${toneClass}`.trim()}>{label}</span>
}
