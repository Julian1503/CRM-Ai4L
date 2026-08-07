/**
 * Post-login redirect handling.
 *
 * proxy.ts round-trips the intended destination through `?next=`. That parameter is
 * attacker-controlled, so it is validated here before being used. An unvalidated value
 * turns the login page into an open redirect: send a victim to
 * `/login?next=https://lookalike.example`, they authenticate genuinely, and land on a
 * clone that harvests whatever they do next.
 */

const DEFAULT_PATH = '/'

/** Control characters, written as escapes — literal bytes here would be invisible in an editor. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export function sanitizeNextPath(value: string | null | undefined): string {
  if (typeof value !== 'string') {
    return DEFAULT_PATH
  }

  const candidate = value.trim()

  if (candidate === '') {
    return DEFAULT_PATH
  }

  // Tab, newline and NUL are stripped by some URL parsers, which lets a payload like
  // `ja<TAB>vascript:` slip past a naive scheme check. Reject outright.
  if (CONTROL_CHARS.test(candidate)) {
    return DEFAULT_PATH
  }

  // Must be a site-relative path.
  if (!candidate.startsWith('/')) {
    return DEFAULT_PATH
  }

  // '//host' and '/\host' are protocol-relative and resolve cross-origin. Browsers
  // treat a backslash as a slash in the authority position.
  if (candidate.startsWith('//') || candidate.startsWith('/\\')) {
    return DEFAULT_PATH
  }

  // A backslash anywhere can be normalised to a slash, so '/\/evil.example.com'
  // becomes protocol-relative after parsing.
  if (candidate.includes('\\')) {
    return DEFAULT_PATH
  }

  // Percent-encoded slashes can decode into an authority section.
  if (/%2f%2f/i.test(candidate)) {
    return DEFAULT_PATH
  }

  // Belt and braces: resolving against an arbitrary origin must stay on that origin.
  try {
    const probeOrigin = 'https://crm.invalid'
    const resolved = new URL(candidate, probeOrigin)

    if (resolved.origin !== probeOrigin) {
      return DEFAULT_PATH
    }
  } catch {
    return DEFAULT_PATH
  }

  return candidate
}
