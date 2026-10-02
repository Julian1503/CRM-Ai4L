'use client'

import { useId, useState } from 'react'

import styles from './EmailPreview.module.css'

type EmailPreviewProps = {
  /** The rendered email HTML. */
  html: string
  /** The same email as a client that blocks images shows it; enables the toggle. */
  htmlImagesOff?: string
  title?: string
}

/**
 * A local render of an email, in a sandboxed frame (no scripts, no same-origin access).
 *
 * Labelled for what it is: the CRM's own render. The email EmailOctopus delivers comes
 * from the Automation's template, so this is not a capture of it.
 */
export default function EmailPreview({ html, htmlImagesOff, title = 'Email preview' }: EmailPreviewProps) {
  const [imagesOff, setImagesOff] = useState(false)
  const toggleId = useId()
  const shown = imagesOff && htmlImagesOff ? htmlImagesOff : html

  return (
    <div className={styles.preview}>
      <div className={styles.previewBar}>
        <p className={styles.previewLabel}>Local render by the CRM, not a capture of the email EmailOctopus sends.</p>
        {htmlImagesOff !== undefined && (
          <label className={styles.toggle} htmlFor={toggleId}>
            <input id={toggleId} type="checkbox" checked={imagesOff} onChange={(event) => setImagesOff(event.target.checked)} />
            Images blocked
          </label>
        )}
      </div>
      <iframe className={styles.frame} title={title} sandbox="" srcDoc={shown} data-testid="email-preview-frame" />
    </div>
  )
}
