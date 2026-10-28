'use client'

import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'

import type { TableContact } from '@/components/ContactTable'
import { useToast } from '@/components/ui/Toast'
import type { BulkLifecycleAction } from '@/lib/contacts/bulkLifecycle'

import BulkLifecycleDialog, { describeBulkLifecycle, type BulkLifecycleRequest } from './BulkLifecycleDialog'
import ContactContextMenu, { type ContextMenuItem } from './ContactContextMenu'

type Selection = {
  selected: ReadonlySet<string>
  list: readonly string[]
  clear: () => void
  toggle: (id: string, on: boolean) => void
}

type MenuState = { contact: TableContact; x: number; y: number }

export interface ContactQuickActionsOptions {
  selection: Selection
  onOpen: (contact: TableContact) => void
  /** Re-reads the list and counts after a change. */
  refresh: () => Promise<void>
  /** The drawer's contact, closed if it was just archived or removed. */
  openContactId?: string | null
  onCloseContact?: () => void
}

const fullName = (contact: TableContact) => `${contact.firstName} ${contact.lastName}`.trim() || contact.email

/**
 * Archive and Remove for many contacts at once: from the pinned selection toolbar, or
 * from a row's right-click menu. A right-click on a ticked row acts on the whole
 * selection — what a file manager does — and on that row alone otherwise.
 */
export function useContactQuickActions({ selection, onOpen, refresh, openContactId, onCloseContact }: ContactQuickActionsOptions) {
  const { notify } = useToast()
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [request, setRequest] = useState<BulkLifecycleRequest | null>(null)

  const openMenu = useCallback((contact: TableContact, position: { x: number; y: number }) => {
    setMenu({ contact, ...position })
  }, [])
  const closeMenu = useCallback(() => setMenu(null), [])

  const requestForSelection = useCallback(
    (action: BulkLifecycleAction) => setRequest({ action, contactIds: [...selection.list] }),
    [selection.list]
  )

  const done = ({ action, updated, skipped }: { action: BulkLifecycleAction; updated: number; skipped: number }) => {
    const affected = request?.contactIds ?? []
    const wasSelection = affected.length > 0 && affected.every((id) => selection.selected.has(id)) && affected.length === selection.list.length

    if (wasSelection) selection.clear()
    else affected.forEach((id) => selection.toggle(id, false))
    if (openContactId && affected.includes(openContactId)) onCloseContact?.()

    setRequest(null)
    const alreadyGone = skipped > 0 ? ` ${skipped} ${skipped === 1 ? 'was' : 'were'} already archived or removed.` : ''
    notify({ tone: 'success', message: `${describeBulkLifecycle(action, updated, 'done')}.${alreadyGone}` })
    void refresh()
  }

  let menuElement: ReactNode = null
  if (menu) {
    const { contact } = menu
    const isTicked = selection.selected.has(contact.id)
    const targets = isTicked && selection.list.length > 1 ? [...selection.list] : [contact.id]
    const many = targets.length > 1
    const subject = many ? undefined : fullName(contact)

    const items: ContextMenuItem[] = [
      { id: 'open', label: 'Open', onSelect: () => onOpen(contact) },
      {
        id: 'select',
        label: isTicked ? 'Deselect' : 'Select',
        onSelect: () => selection.toggle(contact.id, !isTicked),
      },
      {
        id: 'archive',
        label: many ? `Archive ${targets.length} selected` : 'Archive',
        separated: true,
        onSelect: () => setRequest({ action: 'archive', contactIds: targets, subject }),
      },
      {
        id: 'remove',
        label: many ? `Remove ${targets.length} selected…` : 'Remove…',
        tone: 'danger',
        onSelect: () => setRequest({ action: 'remove', contactIds: targets, subject }),
      },
    ]

    menuElement = (
      <ContactContextMenu
        x={menu.x}
        y={menu.y}
        label={many ? `${targets.length} selected contacts` : fullName(contact)}
        items={items}
        onClose={closeMenu}
      />
    )
  }

  const dialogElement = <BulkLifecycleDialog request={request} onClose={() => setRequest(null)} onDone={done} />

  return { openMenu, requestForSelection, menuElement, dialogElement }
}
