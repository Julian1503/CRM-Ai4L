import type { MetadataRoute } from 'next'

/**
 * The CRM is a private workspace, not a public site. Disallow everything.
 *
 * This is defence in depth alongside the `X-Robots-Tag: noindex` header in
 * next.config.ts — robots.txt is advisory, the header is not.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      disallow: '/',
    },
  }
}
