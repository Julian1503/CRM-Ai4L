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
  linkedin: styles.channelLinkedin,
  email: styles.channelEmail,
}

export function ChannelTag({ channel }: { channel: ContentChannel }) {
  return <span className={`${styles.channel} ${CHANNEL_CLASS[channel]}`}>{CHANNEL_LABELS[channel]}</span>
}
