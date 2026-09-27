'use client'

import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Renders an overlay at the end of `document.body`.
 *
 * Overlays inside the app's main column cannot cover the sidebar however high their
 * z-index: `.mainContent` is a flex item with its own z-index, which makes it a
 * stacking context, so everything inside it is layered as one unit below the sidebar.
 * Moving the overlay to the body takes it out of that context.
 *
 * Only mounted after a user action, so `document` always exists; the guard covers a
 * server render anyway rather than throwing.
 */
export default function Portal({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined') return null

  return createPortal(children, document.body)
}
