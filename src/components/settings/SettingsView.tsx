'use client'

import { useEffect, useState } from 'react'
import OperationsPanel from '@/components/operations/OperationsPanel'
import ConfirmDialog from '@/components/ui/ConfirmDialog'
import IntegrationHealth from './IntegrationHealth'
import EmailOctopusSettings, { type EmailOctopusStatus } from './EmailOctopusSettings'
import SocialConnectionsSettings from './SocialConnectionsSettings'
import BrandProfileSettings from './BrandProfileSettings'
import JobTypesSettings from './JobTypesSettings'
import OrganisationSettings from './OrganisationSettings'
import styles from './SettingsView.module.css'

export type SettingsSection = 'overview' | 'brand' | 'connections' | 'job-types' | 'organisations' | 'system'

const SECTIONS: { id: SettingsSection; label: string; description: string }[] = [
  { id: 'overview', label: 'Overview', description: 'Operational health and the settings that need attention.' },
  { id: 'brand', label: 'Brand profile', description: 'The voice, facts and rules behind Content Studio.' },
  { id: 'connections', label: 'Connections', description: 'Email marketing credentials and social publishing accounts.' },
  { id: 'job-types', label: 'Job types', description: 'The catalogue used across contacts and segments.' },
  { id: 'organisations', label: 'Organisations', description: 'Manage the sectors attached to your organisations.' },
  { id: 'system', label: 'System', description: 'Read-only deployment configuration.' },
]

function readSection(): SettingsSection {
  if (typeof window === 'undefined') return 'overview'
  const value = new URLSearchParams(window.location.search).get('section')
  return SECTIONS.find((item) => item.id === value)?.id ?? 'overview'
}

type Props = {
  emailOctopusStatus: EmailOctopusStatus | null
  onEmailOctopusSaved: (status: EmailOctopusStatus | null) => void
  onJobTypesChanged: () => void
  onOrganisationsChanged: () => void
  onOpenStudio: () => void
  onDirtyChange?: (dirty: boolean) => void
}

export default function SettingsView({ emailOctopusStatus, onEmailOctopusSaved, onJobTypesChanged, onOrganisationsChanged, onOpenStudio, onDirtyChange }: Props) {
  const [section, setSection] = useState<SettingsSection>(readSection)
  const [connectionsTab, setConnectionsTab] = useState<'social' | 'email'>('social')
  const [brandDirty, setBrandDirty] = useState(false)
  const [confirmingLeave, setConfirmingLeave] = useState(false)

  useEffect(() => { onDirtyChange?.(brandDirty) }, [brandDirty, onDirtyChange])

  useEffect(() => {
    const sync = () => setSection(readSection())
    window.addEventListener('popstate', sync)
    return () => window.removeEventListener('popstate', sync)
  }, [])

  const select = (next: SettingsSection) => {
    if (next === section) return
    setSection(next)
    const url = new URL(window.location.href)
    url.searchParams.set('section', next)
    window.history.pushState(null, '', url)
  }

  const active = SECTIONS.find((item) => item.id === section)!

  return (
    <div className={styles.settings}>
      <header className={styles.header}>
        <h1>Settings</h1>
        <p>Manage your brand, connections and CRM configuration.</p>
      </header>
      <div className={styles.layout}>
        <nav className={styles.navigation} aria-label="Settings sections">
          {SECTIONS.map((item) => (
            <a
              key={item.id}
              href={`/settings?section=${item.id}`}
              aria-current={section === item.id ? 'page' : undefined}
              className={`${styles.navLink} ${section === item.id ? styles.navActive : ''}`}
              onClick={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
                event.preventDefault()
                select(item.id)
              }}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <label className={styles.mobilePicker}>
          <span>Settings section</span>
          <select value={section} onChange={(event) => select(event.target.value as SettingsSection)}>
            {SECTIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <div className={styles.content}>
          <div className={styles.sectionHeading}>
            <div>
              <h2>{active.label}</h2>
              <p>{active.description}</p>
            </div>
            {section === 'brand' && <button type="button" className={styles.studioLink} onClick={() => { if (brandDirty) setConfirmingLeave(true); else onOpenStudio() }}>Open Content Studio</button>}
          </div>

          {section === 'overview' && (
            <div className={styles.panelStack}>
              <OperationsPanel />
              <IntegrationHealth />
              <div className={styles.shortcutList}>
                <button type="button" onClick={() => select('connections')}>Manage connections <span aria-hidden="true">→</span></button>
                <button type="button" onClick={() => select('brand')}>Edit brand profile <span aria-hidden="true">→</span></button>
              </div>
            </div>
          )}
          <div className={styles.brandPanel} hidden={section !== 'brand'}><BrandProfileSettings compact onDirtyChange={setBrandDirty} /></div>
          {section === 'connections' && <div className={styles.panelStack}>
            <div className={styles.connectionTabs} role="tablist" aria-label="Connection type">
              <button id="connections-social-tab" type="button" role="tab" aria-selected={connectionsTab === 'social'} aria-controls="connections-social-panel" tabIndex={connectionsTab === 'social' ? 0 : -1} onClick={() => setConnectionsTab('social')} onKeyDown={(event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'End') { event.preventDefault(); setConnectionsTab('email'); document.getElementById('connections-email-tab')?.focus() } }}>Social accounts</button>
              <button id="connections-email-tab" type="button" role="tab" aria-selected={connectionsTab === 'email'} aria-controls="connections-email-panel" tabIndex={connectionsTab === 'email' ? 0 : -1} onClick={() => setConnectionsTab('email')} onKeyDown={(event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'Home') { event.preventDefault(); setConnectionsTab('social'); document.getElementById('connections-social-tab')?.focus() } }}>Email marketing</button>
            </div>
            <div id="connections-social-panel" role="tabpanel" aria-labelledby="connections-social-tab" hidden={connectionsTab !== 'social'}><SocialConnectionsSettings allowMock={process.env.NODE_ENV !== 'production'} /></div>
            <div id="connections-email-panel" role="tabpanel" aria-labelledby="connections-email-tab" hidden={connectionsTab !== 'email'}><EmailOctopusSettings status={emailOctopusStatus} onSaved={onEmailOctopusSaved} /></div>
          </div>}
          {section === 'job-types' && <JobTypesSettings onChanged={onJobTypesChanged} />}
          {section === 'organisations' && <OrganisationSettings onChanged={onOrganisationsChanged} />}
          {section === 'system' && (
            <div className={styles.panelStack}>
              {/* Cards replace the raw endpoint and key fields (UX plan P1.6): what matters is
                  whether the platform works; its values stay in the deployment environment. */}
              <IntegrationHealth
                only={['database', 'signup', 'cron']}
                title="Platform"
                description="The database, who may sign up, and the scheduled jobs. Values are managed in the deployment environment."
              />
            </div>
          )}
        </div>
      </div>
      {confirmingLeave && (
        <ConfirmDialog
          title="Discard brand changes?"
          confirmLabel="Discard and open Content Studio"
          cancelLabel="Keep editing"
          onConfirm={() => {
            setConfirmingLeave(false)
            onOpenStudio()
          }}
          onClose={() => setConfirmingLeave(false)}
        >
          <p>The brand profile has unsaved changes. Opening Content Studio drops them.</p>
        </ConfirmDialog>
      )}
    </div>
  )
}
