'use client'

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { gsap } from 'gsap'
import { useGSAP } from '@gsap/react'

import styles from '@/app/page.module.css'
import Sidebar from '@/components/Sidebar'
import { prefersReducedMotion } from '@/lib/motion'

import { CrmProvider, useCrm } from './CrmContext'

/**
 * The CRM chrome around every workspace route: the background, the sidebar and the main
 * area. Shared by src/app/(crm)/layout.tsx, so moving between workspaces keeps the shell
 * and its reference data and only swaps the page.
 */
export default function CrmShell({ children }: { children: ReactNode }) {
  return (
    <CrmProvider>
      <ShellFrame>{children}</ShellFrame>
    </CrmProvider>
  )
}

/** Campaigns waiting for approval, for the sidebar badge. Re-read on every route change. */
function useAwaitingApproval(pathname: string | null): number {
  const [awaiting, setAwaiting] = useState(0)

  useEffect(() => {
    let cancelled = false
    // A failure keeps the last count: the badge is a nudge, and an error here must not
    // disturb the workspace.
    fetch('/api/campaigns?status=in_review&pageSize=1')
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!cancelled && body && typeof body.total === 'number') setAwaiting(body.total)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [pathname])

  return awaiting
}

function ShellFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const mainRef = useRef<HTMLElement>(null)
  const { confirmLeave } = useCrm()
  const awaitingApproval = useAwaitingApproval(pathname)

  useGSAP(
    () => {
      // Decorative entrance only; skipping it leaves the panes at their final state.
      if (prefersReducedMotion() || !mainRef.current) return
      const targets = mainRef.current.children
      if (targets.length === 0) return
      gsap.fromTo(
        targets,
        { opacity: 0, y: 15 },
        { opacity: 1, y: 0, duration: 0.45, stagger: 0.05, ease: 'power2.out', clearProps: 'transform,opacity' }
      )
    },
    { dependencies: [pathname], scope: mainRef }
  )

  return (
    <div className={styles.appContainer}>
      <div className={styles.gridOverlay} />
      <div className={styles.ambientBlur1} />
      <div className={styles.ambientBlur2} />
      <div className={styles.ambientBlur3} />

      <Sidebar badges={{ campaigns: awaitingApproval }} onBeforeNavigate={() => confirmLeave()} />

      <main ref={mainRef} className={styles.mainContent}>
        {children}
      </main>
    </div>
  )
}
