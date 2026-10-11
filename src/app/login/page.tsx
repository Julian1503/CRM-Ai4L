import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { getSession } from '@/lib/auth/dal'
import { sanitizeNextPath } from '@/lib/auth/redirect'
import { isSupabaseConfigured } from '@/lib/supabase/config'

import LoginForm from './LoginForm'
import styles from './login.module.css'

export const metadata: Metadata = {
  title: 'Sign in | Ai4LCRM',
  // The CRM is private; keep it out of indexes even if the URL leaks.
  robots: { index: false, follow: false },
}

export default async function LoginPage({
  searchParams,
}: {
  // searchParams is a Promise in Next.js 16 — synchronous access was removed.
  searchParams: Promise<{ next?: string; reason?: string }>
}) {
  const params = await searchParams
  const nextPath = sanitizeNextPath(params.next)

  // Already signed in? Skip the form.
  const session = await getSession()
  if (session) {
    redirect(nextPath)
  }

  const configured = isSupabaseConfigured()
  const sessionExpired = params.reason === 'expired'
  const notApproved = params.reason === 'not-approved'

  return (
    <main className={styles.page}>
      <div className={styles.ambient} aria-hidden="true" />

      <div className={styles.card}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>Ai4L</span>
          <span className={styles.brandDot}>.</span>
        </div>

        <h1 className={styles.title}>Sign in</h1>
        <p className={styles.subtitle}>
          This workspace is private. Accounts are created by an administrator.
        </p>

        {sessionExpired && (
          <div className={styles.notice} role="status">
            Your session expired. Please sign in again.
          </div>
        )}

        {notApproved && (
          <div className={styles.notice} role="status" data-testid="not-approved">
            This account is not approved for CRM access. Ask an administrator to invite you.
          </div>
        )}

        {configured ? (
          <LoginForm nextPath={nextPath} />
        ) : (
          <div className={styles.formError} role="alert" data-testid="config-error">
            <strong>Supabase is not configured.</strong> Set{' '}
            <code>NEXT_PUBLIC_SUPABASE_URL</code> and{' '}
            <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in <code>.env.local</code>, then
            restart the server. Sign-in is disabled until then.
          </div>
        )}
        <nav className={styles.legalLinks} aria-label="Legal information">
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/data-deletion">Data deletion</Link>
          <Link href="/support">Support</Link>
        </nav>
      </div>
    </main>
  )
}
