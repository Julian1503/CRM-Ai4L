'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'

import { login } from './actions'
import { INITIAL_LOGIN_STATE, type LoginState } from './state'
import styles from './login.module.css'

// Decorative: the button carries the accessible name, so the icons are hidden from AT.
function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  )
}

function EyeOffIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        d="M10.6 5.1A10.6 10.6 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function SubmitButton() {
  const { pending } = useFormStatus()

  return (
    <button type="submit" className={styles.submit} disabled={pending}>
      {pending ? 'Signing in…' : 'Sign in'}
    </button>
  )
}

export default function LoginForm({ nextPath }: { nextPath: string }) {
  const [state, formAction] = useActionState<LoginState, FormData>(
    login,
    INITIAL_LOGIN_STATE
  )

  const [showPassword, setShowPassword] = useState(false)

  const emailError = state.fieldErrors?.email
  const passwordError = state.fieldErrors?.password

  return (
    <form action={formAction} className={styles.form} noValidate>
      <input type="hidden" name="next" value={nextPath} />

      {state.error && (
        <div className={styles.formError} role="alert" data-testid="login-error">
          {state.error}
        </div>
      )}

      <div className={styles.field}>
        <label htmlFor="email" className={styles.label}>
          Email address
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          autoFocus
          required
          className={styles.input}
          aria-invalid={emailError ? true : undefined}
          aria-describedby={emailError ? 'email-error' : undefined}
        />
        {emailError && (
          <span id="email-error" className={styles.fieldError} role="alert">
            {emailError}
          </span>
        )}
      </div>

      <div className={styles.field}>
        <label htmlFor="password" className={styles.label}>
          Password
        </label>
        {/* One input whose type flips, rather than two inputs swapped in and out: the
            typed value, the password manager's attachment and the error wiring all
            belong to this element and must survive a reveal. */}
        <div className={styles.passwordWrap}>
          <input
            id="password"
            name="password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            required
            className={`${styles.input} ${styles.passwordInput}`}
            aria-invalid={passwordError ? true : undefined}
            aria-describedby={passwordError ? 'password-error' : undefined}
          />
          <button
            type="button"
            className={styles.reveal}
            onClick={() => setShowPassword((shown) => !shown)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            aria-pressed={showPassword}
            aria-controls="password"
          >
            {showPassword ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </div>
        {passwordError && (
          <span id="password-error" className={styles.fieldError} role="alert">
            {passwordError}
          </span>
        )}
      </div>

      <SubmitButton />
    </form>
  )
}
