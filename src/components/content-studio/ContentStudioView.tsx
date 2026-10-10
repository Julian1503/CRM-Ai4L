'use client'

import { useCallback, useEffect, useState } from 'react'
import type { KeyboardEvent } from 'react'

import BriefForm from './BriefForm'
import CreateEmailDialog from './CreateEmailDialog'
import ItemDetail from './ItemDetail'
import ItemLibrary from './ItemLibrary'
import PublicationHistory from './PublicationHistory'
import styles from './ContentStudio.module.css'

export type StudioSection = 'create' | 'library' | 'review' | 'publications'

const SECTIONS: { id: StudioSection; label: string }[] = [
  { id: 'create', label: 'Create' },
  { id: 'library', label: 'Library' },
  { id: 'review', label: 'Review' },
  { id: 'publications', label: 'Publications' },
]

/** The id in `?item=`, if it looks like one. Read once; the view owns selection after that. */
export function readItemParam(search: string): string | null {
  const value = new URLSearchParams(search).get('item')?.trim()
  return value && /^[A-Za-z0-9-]{1,64}$/.test(value) ? value : null
}

type ContentStudioViewProps = {
  /** Opens Settings, where social accounts are connected. */
  onOpenSettings?: () => void
  /** Notified when a variant's "Create email" is used; the dialog opens here either way. */
  onCreateEmail?: (variantId: string, revisionId: string) => void
  /** Opens a campaign in Campaigns after the email dialog created its draft. */
  onOpenCampaign?: (campaignId: string) => void
  onDirtyChange?: (dirty: boolean) => void
}

/**
 * Content Studio: write a brief, generate per-channel variants, edit and review them,
 * add images and publish. Social accounts are managed in Settings → Connections.
 */
export default function ContentStudioView({ onOpenSettings, onCreateEmail, onOpenCampaign, onDirtyChange }: ContentStudioViewProps = {}) {
  const [section, setSection] = useState<StudioSection>('create')
  const [emailVariantId, setEmailVariantId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [studioDirty, setStudioDirty] = useState(false)

  const confirmLeave = () => !studioDirty || window.confirm('Discard unsaved variant changes?')
  const recordDirty = useCallback((dirty: boolean) => { setStudioDirty(dirty); onDirtyChange?.(dirty) }, [onDirtyChange])
  const selectSection = (next: StudioSection): boolean => {
    if (next === section) return true
    if (!confirmLeave()) return false
    recordDirty(false)
    setSection(next)
    setSelectedId(null)
    const url = new URL(window.location.href)
    for (const parameter of ['item', 'channel', 'variant', 'studioSection']) url.searchParams.delete(parameter)
    window.history.replaceState(null, '', url)
    return true
  }

  useEffect(() => {
    const fromUrl = readItemParam(window.location.search)
    if (!fromUrl) return
    // A deep link to one item; read once, on mount only.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedId(fromUrl)
    setSection(new URLSearchParams(window.location.search).get('studioSection') === 'review' ? 'review' : 'library')
  }, [])

  const open = (itemId: string) => {
    setSelectedId(itemId)
    if (section !== 'review') setSection('library')
    const url = new URL(window.location.href)
    url.searchParams.set('item', itemId)
    url.searchParams.set('view', 'content')
    if (section === 'review') url.searchParams.set('studioSection', 'review')
    else url.searchParams.delete('studioSection')
    window.history.replaceState(null, '', url)
  }

  const closeItem = () => {
    setSelectedId(null)
    const url = new URL(window.location.href)
    url.searchParams.delete('item')
    url.searchParams.delete('channel')
    url.searchParams.delete('variant')
    url.searchParams.delete('studioSection')
    window.history.replaceState(null, '', url)
  }

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const target = event.key === 'Home' ? SECTIONS[0] : SECTIONS[SECTIONS.length - 1]
      if (selectSection(target.id)) document.getElementById(`studio-tab-${target.id}`)?.focus()
      return
    }
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!delta) return
    event.preventDefault()
    const next = SECTIONS[(index + delta + SECTIONS.length) % SECTIONS.length]
    if (selectSection(next.id)) document.getElementById(`studio-tab-${next.id}`)?.focus()
  }

  const showDetail = selectedId !== null && (section === 'library' || section === 'review')

  return (
    <div className={styles.studio}>
      <div className={styles.studioBar}>
        <div className={styles.tabs} role="tablist" aria-label="Content Studio sections">
          {SECTIONS.map((item, index) => (
            <button
              key={item.id}
              id={`studio-tab-${item.id}`}
              type="button"
              role="tab"
              aria-selected={section === item.id}
              aria-controls="studio-panel"
              tabIndex={section === item.id ? 0 : -1}
              className={`${styles.tab} ${section === item.id ? styles.tabActive : ''}`}
              onClick={() => selectSection(item.id)}
              onKeyDown={(event) => onTabKey(event, index)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={styles.connectionsBtn}
          onClick={() => { if (confirmLeave()) { recordDirty(false); onOpenSettings?.() } }}
          disabled={!onOpenSettings}
          title={onOpenSettings ? 'Manage connected social accounts in Settings' : undefined}
        >
          Connections
        </button>
      </div>

      <div id="studio-panel" role="tabpanel" aria-labelledby={`studio-tab-${section}`} className={styles.studioPanel}>
        <div hidden={section !== 'create'}>
          <BriefForm
            onCreated={(item) => {
              open(item.id)
            }}
          />
        </div>
        {showDetail && selectedId && (
          <ItemDetail
            key={selectedId}
            itemId={selectedId}
            reviewFocus={section === 'review'}
            onBack={() => { if (confirmLeave()) { recordDirty(false); closeItem() } }}
            onOpenSettings={() => { if (confirmLeave()) { recordDirty(false); onOpenSettings?.() } }}
            onDirtyChange={recordDirty}
            confirmLeave={confirmLeave}
            onCreateEmail={(variantId, revisionId) => {
              setEmailVariantId(variantId)
              onCreateEmail?.(variantId, revisionId)
            }}
          />
        )}
        {section === 'library' && <div hidden={showDetail}><ItemLibrary onOpen={open} /></div>}
        {section === 'review' && <div hidden={showDetail}><ItemLibrary onOpen={open} reviewOnly /></div>}
        {section === 'publications' && <PublicationHistory />}
      </div>

      {emailVariantId && (
        <CreateEmailDialog
          key={emailVariantId}
          variantId={emailVariantId}
          onClose={() => setEmailVariantId(null)}
          onCreated={(campaignId) => {
            if (!onOpenCampaign) return
            setEmailVariantId(null)
            onOpenCampaign(campaignId)
          }}
        />
      )}
    </div>
  )
}
