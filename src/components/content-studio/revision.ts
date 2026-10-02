import type { ContentAsset, ContentRevision, RevisionAssetRef, RevisionContent } from '@/lib/content-studio/types'

import type { PreviewImage } from './SocialPreview'

/** The editable part of a revision, copied so edits never touch the loaded one. */
export function contentOf(revision: ContentRevision | null): RevisionContent {
  return {
    body: revision?.body ?? '',
    hashtags: [...(revision?.hashtags ?? [])],
    callToAction: revision?.callToAction ?? null,
    linkUrl: revision?.linkUrl ?? null,
    fields: { ...(revision?.fields ?? {}) },
    assets: (revision?.assets ?? []).map((ref) => ({ ...ref })),
  }
}

/** Refs sorted by their order, renumbered 0..n-1 so the saved order has no gaps. */
export function normaliseOrder(refs: RevisionAssetRef[]): RevisionAssetRef[] {
  return [...refs].sort((left, right) => left.order - right.order).map((ref, order) => ({ ...ref, order }))
}

export function moveRef(refs: RevisionAssetRef[], assetId: string, delta: -1 | 1): RevisionAssetRef[] {
  const ordered = normaliseOrder(refs)
  const from = ordered.findIndex((ref) => ref.assetId === assetId)
  const to = from + delta
  if (from < 0 || to < 0 || to >= ordered.length) return ordered
  const next = [...ordered]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next.map((ref, order) => ({ ...ref, order }))
}

export function previewImages(refs: RevisionAssetRef[], assets: ContentAsset[]): PreviewImage[] {
  return normaliseOrder(refs).map((ref) => {
    const asset = assets.find((candidate) => candidate.id === ref.assetId)
    return {
      id: ref.assetId,
      url: asset?.previewUrl ?? null,
      alt: ref.alt,
      width: asset?.width ?? null,
      height: asset?.height ?? null,
    }
  })
}

export function assetLabel(asset: ContentAsset): string {
  return asset.originalFilename || asset.generationPrompt || asset.altText || 'Image'
}
