import Link from 'next/link'
import type { ReactNode } from 'react'

import styles from './legal.module.css'

const links = [
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
  { href: '/data-deletion', label: 'Data deletion' },
] as const

export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/login" aria-label="AI4L CRM sign in">AI4L<span aria-hidden="true">.</span> CRM</Link>
        <nav className={styles.nav} aria-label="Legal information">
          {links.map((link) => <Link key={link.href} href={link.href}>{link.label}</Link>)}
        </nav>
      </header>
      <main className={styles.main}>{children}</main>
      <footer className={styles.footer}>
        <span>AI4L CRM</span>
        <nav aria-label="Footer legal information">
          {links.map((link) => <Link key={link.href} href={link.href}>{link.label}</Link>)}
        </nav>
      </footer>
    </div>
  )
}
