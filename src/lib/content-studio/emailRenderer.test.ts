import { EmailRenderError, escapeHtml, fitImage, PREFS_URL_TAG, renderEmail, type EmailRenderInput } from './emailRenderer'

const PREFIX = 'https://proj.supabase.co/storage/v1/object/public/content-public/p/'
const IMAGE_URL = `${PREFIX}0b4f7f36/abc.jpg`

const BASE: EmailRenderInput = {
  subject: 'Term update',
  preheader: 'What changes for you.',
  headline: 'New rules',
  intro: 'A short update.',
  body: 'First paragraph.\n\nSecond paragraph\nwith a line break.',
  ctaMode: 'external_url',
  ctaLabel: 'Read more',
  ctaUrl: 'https://ai4l.com.au/guide',
  image: { url: IMAGE_URL, alt: 'A classroom', width: 1200, height: 800 },
  brandName: 'AI4L',
}

const OPTIONS = { imagePrefix: PREFIX }

describe('renderEmail', () => {
  it('produces table-based HTML with inline styles, the preheader and a preferences footer', () => {
    const { html, text } = renderEmail(BASE, OPTIONS)

    expect(html).toMatch(/^<!DOCTYPE html>/)
    expect(html).toContain('role="presentation"')
    expect(html).toContain('What changes for you.')
    expect(html).toContain(`href="${PREFS_URL_TAG}"`)
    expect(html).toContain('<p style="margin:0 0 16px;')
    expect(html).toContain('Second paragraph<br>with a line break.')
    expect(html).not.toMatch(/<script|<style/i)
    expect(text).toContain('Read more: https://ai4l.com.au/guide')
    expect(text).toContain(`Unsubscribe or choose which emails you receive: ${PREFS_URL_TAG}`)
    expect(text).toContain('[Image: A classroom]')
  })

  it('sizes images explicitly and keeps alt text', () => {
    const { html } = renderEmail(BASE, OPTIONS)

    expect(html).toContain(`<img src="${IMAGE_URL}" alt="A classroom" width="600" height="400"`)
    expect(fitImage(300, 200)).toEqual({ width: 300, height: 200 })
    expect(fitImage(0, 0)).toEqual({ width: 600, height: 338 })
  })

  it('still reads with images blocked: the alt text replaces the picture, all text stays text', () => {
    const { html } = renderEmail(BASE, { ...OPTIONS, blockImages: true })

    expect(html).not.toContain('<img')
    expect(html).toContain('A classroom')
    expect(html).toContain('New rules')
  })

  it('escapes every value', () => {
    const hostile = '<script>alert("x")</script> & \'quotes\''
    const { html } = renderEmail(
      { ...BASE, subject: hostile, preheader: hostile, headline: hostile, intro: hostile, body: hostile, ctaLabel: hostile, image: { ...BASE.image!, alt: hostile } },
      OPTIONS
    )

    expect(html).not.toContain('<script>')
    expect(html).toContain(escapeHtml(hostile))
    expect(escapeHtml(`<a href="x">'&`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;')
  })

  it.each([
    ['blob:', 'blob:https://crm/123'],
    ['data:', 'data:image/png;base64,AAAA'],
    ['localhost', 'https://localhost/a.png'],
    ['plain http', 'http://ai4l.com.au/a.png'],
    ['any other public https', 'https://example.com/a.png'],
    ['a signed library URL', 'https://proj.supabase.co/storage/v1/object/sign/content-library/a.jpg?token=t'],
  ])('refuses a %s image', (_label, url) => {
    expect(() => renderEmail({ ...BASE, image: { ...BASE.image!, url } }, OPTIONS)).toThrow(EmailRenderError)
  })

  it('accepts a signed preview only when the preview names it', () => {
    const preview = 'http://127.0.0.1:54321/storage/v1/object/sign/content-library/a.jpg?token=t'
    expect(() => renderEmail({ ...BASE, image: { ...BASE.image!, url: preview } }, OPTIONS)).toThrow(EmailRenderError)
    expect(renderEmail({ ...BASE, image: { ...BASE.image!, url: preview } }, { ...OPTIONS, previewImageUrls: [preview] }).html).toContain('src="http://127.0.0.1')
  })

  it.each([
    ['an http link', { ctaUrl: 'http://ai4l.com.au' }],
    ['a localhost link', { ctaUrl: 'https://localhost/x' }],
    ['a javascript link', { ctaUrl: 'javascript:alert(1)' }],
    ['no link', { ctaUrl: null }],
    ['no label', { ctaLabel: ' ' }],
  ])('refuses a button with %s', (_label, change) => {
    expect(() => renderEmail({ ...BASE, ...change }, OPTIONS)).toThrow(EmailRenderError)
  })

  it('refuses an image without alt text', () => {
    expect(() => renderEmail({ ...BASE, image: { ...BASE.image!, alt: ' ' } }, OPTIONS)).toThrow(/alt text/)
  })

  it('renders no button for none, and the booking tag for booking', () => {
    const none = renderEmail({ ...BASE, ctaMode: 'none', image: null }, OPTIONS)
    expect(none.html).not.toContain('Read more')
    expect(none.html).not.toContain('BookingUrl')
    expect(none.text).not.toContain('Read more')

    const booking = renderEmail({ ...BASE, ctaMode: 'booking', ctaUrl: null }, OPTIONS)
    expect(booking.html).toContain('href="{{BookingUrl}}"')
  })
})
