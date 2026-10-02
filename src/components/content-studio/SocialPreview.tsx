'use client'

import { useState } from 'react'

import type { SocialPlatform } from '@/lib/content-studio/types'

import { CHANNEL_LABELS } from './labels'
import styles from './SocialPreview.module.css'

/** Where each network folds a long caption. Cosmetic only: never changes what is sent. */
const PREVIEW_FOLD: Record<SocialPlatform, { chars: number; label: string }> = {
  facebook: { chars: 477, label: 'See more' },
  instagram: { chars: 125, label: 'more' },
  linkedin: { chars: 200, label: '…see more' },
}

/** Instagram crops outside this range and applies the first image's ratio to all. */
const IG_MIN_ASPECT = 0.8
const IG_MAX_ASPECT = 1.91

export type PreviewImage = {
  id: string
  url: string | null
  alt: string
  width: number | null
  height: number | null
}

type SocialPreviewProps = {
  platform: SocialPlatform
  /** Shown verbatim. In the publish dialog this is preflight's composedText. */
  text: string
  images: PreviewImage[]
  accountName?: string | null
}

export function foldText(text: string, limit: number): { head: string; tail: string } {
  if (text.length <= limit) return { head: text, tail: '' }
  const slice = text.slice(0, limit)
  const lastSpace = slice.lastIndexOf(' ')
  const cut = lastSpace > limit * 0.6 ? lastSpace : limit
  return { head: text.slice(0, cut), tail: text.slice(cut) }
}

function withHashtags(text: string) {
  return text
    .split(/(#[\p{L}\p{N}_]+)/gu)
    .map((part, index) => (part.startsWith('#') ? <span key={index} className={styles.hashtag}>{part}</span> : <span key={index}>{part}</span>))
}

function PostText({ text, platform }: { text: string; platform: SocialPlatform }) {
  const [expanded, setExpanded] = useState(false)
  const { chars, label } = PREVIEW_FOLD[platform]
  const { head, tail } = foldText(text, chars)

  if (!text) return <p className={styles.bodyEmpty}>No text yet.</p>

  return (
    <p className={styles.body}>
      {withHashtags(expanded || !tail ? text : head)}
      {tail && !expanded && (
        <>
          {'… '}
          <button type="button" className={styles.more} onClick={() => setExpanded(true)}>
            {label}
          </button>
        </>
      )}
    </p>
  )
}

function Photo({ image, className }: { image: PreviewImage; className?: string }) {
  if (!image.url) return <span className={`${styles.photoMissing} ${className ?? ''}`}>Preview unavailable</span>
  // Signed preview URLs are short-lived and cross-origin; next/image would try to optimise them.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={image.url} alt={image.alt} className={className} loading="lazy" />
}

function Mosaic({ images }: { images: PreviewImage[] }) {
  if (images.length === 0) return null
  if (images.length === 1) return <Photo image={images[0]} className={styles.single} />
  const [lead, ...rest] = images
  const overflow = rest.length - 3
  return (
    <div className={styles.mosaic}>
      <Photo image={lead} className={styles.mosaicLead} />
      <div className={styles.mosaicRest}>
        {rest.slice(0, 3).map((image, index) => (
          <div key={image.id} className={styles.mosaicCell}>
            <Photo image={image} />
            {index === 2 && overflow > 0 && <span className={styles.overflow}>+{overflow}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

export function instagramAspect(image: PreviewImage | undefined): number {
  if (!image || !image.width || !image.height) return 1
  return Math.min(Math.max(image.width / image.height, IG_MIN_ASPECT), IG_MAX_ASPECT)
}

function Carousel({ images }: { images: PreviewImage[] }) {
  const [index, setIndex] = useState(0)
  if (images.length === 0) return <div className={styles.igEmpty}>Instagram needs at least one image.</div>
  const current = images[Math.min(index, images.length - 1)]

  return (
    <div className={styles.igMedia} style={{ aspectRatio: String(instagramAspect(images[0])) }}>
      <Photo image={current} />
      {images.length > 1 && (
        <>
          <button type="button" className={styles.igPrev} onClick={() => setIndex((value) => Math.max(0, value - 1))} disabled={index === 0} aria-label="Previous image">
            ‹
          </button>
          <button
            type="button"
            className={styles.igNext}
            onClick={() => setIndex((value) => Math.min(images.length - 1, value + 1))}
            disabled={index >= images.length - 1}
            aria-label="Next image"
          >
            ›
          </button>
          <span className={styles.igCounter}>
            {index + 1}/{images.length}
          </span>
        </>
      )}
    </div>
  )
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join('')
}

/** An approximation of the post on its network, labelled as such. */
export default function SocialPreview({ platform, text, images, accountName }: SocialPreviewProps) {
  const name = accountName || 'Your account'

  return (
    <figure className={styles.frame} data-platform={platform} aria-label={`${CHANNEL_LABELS[platform]} preview`}>
      <figcaption className={styles.chrome}>Approximate preview · {CHANNEL_LABELS[platform]}</figcaption>
      <article className={styles.post}>
        <header className={styles.postHeader}>
          <span className={styles.avatar} aria-hidden="true">
            {initials(name)}
          </span>
          <span className={styles.author}>{name}</span>
        </header>
        {platform === 'instagram' ? (
          <>
            <Carousel images={images} />
            <PostText text={text} platform={platform} />
          </>
        ) : (
          <>
            <PostText text={text} platform={platform} />
            <Mosaic images={images} />
          </>
        )}
      </article>
    </figure>
  )
}
