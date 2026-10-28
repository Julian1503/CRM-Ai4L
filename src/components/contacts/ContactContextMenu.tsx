'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

import Portal from '@/components/ui/Portal'

import styles from './ContactContextMenu.module.css'

export type ContextMenuItem = {
  id: string
  label: string
  onSelect: () => void
  tone?: 'danger'
  /** Draws a divider above the item. */
  separated?: boolean
}

export interface ContactContextMenuProps {
  /** Viewport coordinates of the right-click. */
  x: number
  y: number
  label: string
  items: ContextMenuItem[]
  onClose: () => void
}

/** Keeps the menu this far from the viewport edges. */
const EDGE_GAP_PX = 8

/**
 * The right-click menu on a contact row: quick actions on that contact, or on the whole
 * selection when the row is part of it.
 *
 * Behaves like a native menu: focus starts on the first item, arrows move, Enter or a
 * click picks, and Escape, a click elsewhere, scrolling or resizing close it. Focus goes
 * back to where it was. Placed at the pointer and nudged inside the viewport.
 */
export default function ContactContextMenu({ x, y, label, items, onClose }: ContactContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [position, setPosition] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return

    const { width, height } = menu.getBoundingClientRect()
    setPosition({
      left: Math.max(EDGE_GAP_PX, Math.min(x, window.innerWidth - width - EDGE_GAP_PX)),
      top: Math.max(EDGE_GAP_PX, Math.min(y, window.innerHeight - height - EDGE_GAP_PX)),
    })
  }, [x, y])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    itemRefs.current[0]?.focus()

    const closeOnOutside = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose()
    }
    const closeOnKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }

    window.addEventListener('mousedown', closeOnOutside, true)
    window.addEventListener('keydown', closeOnKey, true)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)

    return () => {
      window.removeEventListener('mousedown', closeOnOutside, true)
      window.removeEventListener('keydown', closeOnKey, true)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
      previous?.focus?.()
    }
  }, [onClose])

  const moveFocus = (event: ReactKeyboardEvent) => {
    const keys: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      itemRefs.current[event.key === 'Home' ? 0 : items.length - 1]?.focus()
      return
    }
    if (!(event.key in keys) && event.key !== 'Tab') return

    event.preventDefault()
    const current = itemRefs.current.findIndex((item) => item === document.activeElement)
    const step = event.key === 'Tab' ? (event.shiftKey ? -1 : 1) : keys[event.key]
    const next = (current + step + items.length) % items.length
    itemRefs.current[next]?.focus()
  }

  return (
    <Portal>
      <div
        ref={menuRef}
        className={styles.menu}
        role="menu"
        aria-label={label}
        style={{ left: position.left, top: position.top }}
        onKeyDown={moveFocus}
        onContextMenu={(event) => event.preventDefault()}
        data-testid="contact-context-menu"
      >
        {items.map((item, index) => (
          <button
            key={item.id}
            ref={(node) => {
              itemRefs.current[index] = node
            }}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={`${styles.item} ${item.tone === 'danger' ? styles.danger : ''} ${item.separated ? styles.separated : ''}`}
            onClick={() => {
              onClose()
              item.onSelect()
            }}
            data-testid={`context-${item.id}`}
          >
            {item.label}
          </button>
        ))}
      </div>
    </Portal>
  )
}
