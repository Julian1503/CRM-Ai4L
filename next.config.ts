import type { NextConfig } from 'next'

/**
 * Baseline security headers.
 *
 * This CRM holds client contact data on a private subdomain, so the defaults lean
 * restrictive. A nonce-based Content-Security-Policy is deliberately not set here yet —
 * it needs to be built against the real deployed bundle to avoid breaking GSAP's inline
 * styles, and is scheduled with the rest of the hardening pass.
 */
const securityHeaders = [
  // HSTS. Only honoured over HTTPS, so it is inert in local development.
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=31536000; includeSubDomains',
  },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // No part of the CRM is meant to be framed; blocks clickjacking outright.
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  },
  // Private workspace: keep every route out of search indexes even if a URL leaks.
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
]

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ]
  },
}

export default nextConfig
