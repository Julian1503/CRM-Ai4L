'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { INITIAL_LOGIN_STATE, login, type LoginState } from './actions'
import styles from './login.module.css'

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
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={styles.input}
          aria-invalid={passwordError ? true : undefined}
          aria-describedby={passwordError ? 'password-error' : undefined}
        />
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
