import type { MetadataRoute } from 'next'

/**
 * The CRM is a private workspace. Only the public legal notices may be crawled.
 *
 * This is defence in depth alongside the `X-Robots-Tag: noindex` header in
 * next.config.ts — robots.txt is advisory, the header is not.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: ['/privacy', '/terms', '/data-deletion', '/support'],
      disallow: '/',
    },
  }
}
