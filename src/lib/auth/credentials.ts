/**
 * Login form validation.
 *
 * Kept separate from the Server Action so the rules are unit-testable without a
 * React or Supabase runtime.
 */

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * The single message shown for every authentication failure.
 *
 * Distinguishing "no such account" from "wrong password" would let anyone enumerate
 * valid users against the login form, which matters more than usual here because the
 * CRM is invite-only — the set of valid emails is itself sensitive.
 */
export const AUTH_FAILED_MESSAGE = 'Invalid email or password.'

export type LoginInput =
  | { ok: true; email: string; password: string }
  | { ok: false; fieldErrors: { email?: string; password?: string } }

export function validateLoginInput(email: unknown, password: unknown): LoginInput {
  const fieldErrors: { email?: string; password?: string } = {}

  const rawEmail = typeof email === 'string' ? email.trim().toLowerCase() : ''
  // Passwords are not trimmed: leading and trailing spaces are valid characters,
  // and silently stripping them would reject a correct password.
  const rawPassword = typeof password === 'string' ? password : ''

  if (!rawEmail) {
    fieldErrors.email = 'Enter your email address.'
  } else if (!EMAIL_REGEX.test(rawEmail)) {
    fieldErrors.email = 'Enter a valid email address.'
  }

  if (!rawPassword) {
    fieldErrors.password = 'Enter your password.'
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors }
  }

  return { ok: true, email: rawEmail, password: rawPassword }
}
