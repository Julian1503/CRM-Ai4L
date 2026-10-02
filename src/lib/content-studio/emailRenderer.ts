/**
 * Email HTML and plain text for Content Studio emails (plan §8.3).
 *
 * Deliberately simple and conservative: one 600px table column, inline styles, explicit
 * image dimensions, alt text, a text-only preheader, and a footer with the single
 * preferences link (`{{PrefsUrl}}`, docs/EMAILOCTOPUS_SETUP.md). The message still reads
 * with images blocked: the main text is text, never a picture of text.
 *
 * Every value is escaped. Links must be public https URLs; images must be published
 * Content Studio copies (a local preview may name its own signed preview URL) — never
 * `blob:`, `data:`, localhost or a signed preview. A rejected URL throws rather than being
 * dropped, so a broken email is never produced silently.
 *
 * Pure and client-safe: the dialog renders the same HTML locally for its preview, which
 * is labelled as a local render, not the provider's.
 */

import { imageProblem, linkProblem, type CtaMode } from '@/lib/marketing/templateContracts'

export const EMAIL_WIDTH = 600
export const PREFS_URL_TAG = '{{PrefsUrl}}'

export type EmailImage = { url: string; alt: string; width: number; height: number }

export type EmailRenderInput = {
  subject: string
  preheader: string
  headline: string
  intro: string
  body: string
  ctaMode: CtaMode
  ctaLabel?: string | null
  ctaUrl?: string | null
  image?: EmailImage | null
  brandName?: string
}

export type RenderOptions = {
  /** content-public prefix email images must start with (templateContracts.contentPublicPrefix). */
  imagePrefix: string | null
  /** Preview only: show each image as its alt text, as a client that blocks images would. */
  blockImages?: boolean
  /**
   * Preview only: also accept these exact image URLs (a member's short-lived signed
   * preview, before the image is published). Never used for anything that is stored.
   */
  previewImageUrls?: readonly string[]
}

export class EmailRenderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmailRenderError'
  }
}

const COLORS = { text: '#1f2933', muted: '#52606d', bg: '#f4f5f7', card: '#ffffff', accent: '#0b5cad', line: '#e4e7eb' }
const FONT = "Arial, 'Helvetica Neue', Helvetica, sans-serif"

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function paragraphsHtml(text: string, style: string): string {
  return text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `<p style="${style}">${escapeHtml(part).replace(/\n/g, '<br>')}</p>`)
    .join('\n')
}

function checkedLink(url: string, what: string): string {
  const problem = linkProblem(url)
  if (problem) throw new EmailRenderError(`The ${what} ${problem}`)
  return url
}

function checkedImage(image: EmailImage, prefix: string | null, previewUrls: readonly string[] = []): EmailImage {
  if (/^(blob|data|javascript):/i.test(image.url)) throw new EmailRenderError('The image must be a published link, not embedded data.')
  // Only our published copies (or, in a member's local preview, the exact signed preview
  // URL it names). Any other URL, however public, is refused.
  if (!previewUrls.includes(image.url) && imageProblem(image.url, prefix)) {
    throw new EmailRenderError('The image must be a published Content Studio image.')
  }
  if (!image.alt.trim()) throw new EmailRenderError('The image needs a description (alt text).')
  return image
}

/** Scales to the column width, keeping the aspect ratio; both dimensions are always set. */
export function fitImage(width: number, height: number): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: EMAIL_WIDTH, height: Math.round(EMAIL_WIDTH * 0.5625) }
  const scale = Math.min(1, EMAIL_WIDTH / width)
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

function imageHtml(image: EmailImage, blockImages: boolean): string {
  const size = fitImage(image.width, image.height)
  if (blockImages) {
    return (
      `<div style="width:100%;max-width:${size.width}px;padding:24px 16px;border:1px dashed ${COLORS.line};` +
      `color:${COLORS.muted};font-family:${FONT};font-size:14px;text-align:center;box-sizing:border-box;">` +
      `${escapeHtml(image.alt)}</div>`
    )
  }
  return (
    `<img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.alt)}" width="${size.width}" height="${size.height}" ` +
    `style="display:block;width:100%;max-width:${size.width}px;height:auto;border:0;outline:none;` +
    `color:${COLORS.muted};font-family:${FONT};font-size:14px;">`
  )
}

function ctaHtml(label: string, url: string): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr>` +
    `<td style="border-radius:4px;background:${COLORS.accent};">` +
    `<a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:16px;` +
    `font-weight:bold;color:#ffffff;text-decoration:none;border-radius:4px;">${escapeHtml(label)}</a>` +
    `</td></tr></table>`
  )
}

function resolveCta(input: EmailRenderInput): { label: string; url: string } | null {
  if (input.ctaMode === 'none') return null
  const label = input.ctaLabel?.trim()
  if (!label) throw new EmailRenderError('The button needs a label.')
  if (input.ctaMode === 'booking') {
    // The booking link is minted per recipient at send time; the HTML carries the tag.
    return { label, url: '{{BookingUrl}}' }
  }
  if (!input.ctaUrl) throw new EmailRenderError('The button needs a link.')
  return { label, url: checkedLink(input.ctaUrl.trim(), 'button link') }
}

export function renderEmail(input: EmailRenderInput, options: RenderOptions): { html: string; text: string } {
  const image = input.image ? checkedImage(input.image, options.imagePrefix, options.previewImageUrls) : null
  const cta = resolveCta(input)
  const brand = input.brandName?.trim() || 'AI4L'
  const p = `margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:1.5;color:${COLORS.text};`

  const html = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(input.subject)}</title>`,
    '</head>',
    `<body style="margin:0;padding:0;background:${COLORS.bg};">`,
    // Preheader: shown in the inbox list, hidden in the body.
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:${COLORS.bg};">${escapeHtml(input.preheader)}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLORS.bg};">`,
    '<tr><td align="center" style="padding:24px 12px;">',
    `<table role="presentation" width="${EMAIL_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${EMAIL_WIDTH}px;background:${COLORS.card};">`,
    image ? `<tr><td style="padding:0;">${imageHtml(image, Boolean(options.blockImages))}</td></tr>` : '',
    '<tr><td style="padding:32px 32px 8px;">',
    `<h1 style="margin:0 0 16px;font-family:${FONT};font-size:26px;line-height:1.25;color:${COLORS.text};">${escapeHtml(input.headline)}</h1>`,
    paragraphsHtml(input.intro, p),
    paragraphsHtml(input.body, p),
    cta ? ctaHtml(cta.label, cta.url) : '',
    '</td></tr>',
    `<tr><td style="padding:16px 32px 32px;border-top:1px solid ${COLORS.line};font-family:${FONT};font-size:12px;line-height:1.5;color:${COLORS.muted};">`,
    `<p style="margin:0 0 8px;">You are receiving this email from ${escapeHtml(brand)}.</p>`,
    `<p style="margin:0;"><a href="${PREFS_URL_TAG}" style="color:${COLORS.muted};">Unsubscribe or choose which emails you receive</a></p>`,
    '</td></tr>',
    '</table>',
    '</td></tr>',
    '</table>',
    '</body>',
    '</html>',
  ]
    .filter(Boolean)
    .join('\n')

  const text = [
    input.headline.trim(),
    '',
    input.intro.trim(),
    '',
    input.body.trim(),
    ...(image ? ['', `[Image: ${image.alt.trim()}]`] : []),
    ...(cta ? ['', `${cta.label}: ${cta.url}`] : []),
    '',
    '--',
    `You are receiving this email from ${brand}.`,
    `Unsubscribe or choose which emails you receive: ${PREFS_URL_TAG}`,
  ].join('\n')

  return { html, text }
}
