'use client'

import { useId, useRef, useState } from 'react'

import Dialog from './Dialog'
import styles from './ContentStudio.module.css'

type PromptDialogProps = {
  title: string
  hint?: string
  label: string
  placeholder?: string
  confirmLabel: string
  /** A blank answer is refused. */
  required?: boolean
  busy?: boolean
  error?: string | null
  onSubmit: (value: string) => void
  onClose: () => void
}

/** A dialog that asks for one piece of text: a rejection reason, a rewrite instruction. */
export default function PromptDialog({
  title,
  hint,
  label,
  placeholder,
  confirmLabel,
  required = false,
  busy = false,
  error = null,
  onSubmit,
  onClose,
}: PromptDialogProps) {
  const [value, setValue] = useState('')
  const [touched, setTouched] = useState(false)
  const fieldId = useId()
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const missing = required && value.trim().length === 0

  const submit = () => {
    setTouched(true)
    if (missing) return
    onSubmit(value.trim())
  }

  return (
    <Dialog
      title={title}
      hint={hint}
      busy={busy}
      onClose={onClose}
      initialFocusRef={fieldRef}
      footer={
        <>
          <button type="button" className={styles.secondaryBtn} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={styles.primaryBtn} onClick={submit} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <label className={styles.field} htmlFor={fieldId}>
        <span className={styles.label}>
          {label}
          {required ? '' : ' (optional)'}
        </span>
        <textarea
          id={fieldId}
          ref={fieldRef}
          className={styles.textarea}
          rows={3}
          value={value}
          placeholder={placeholder}
          aria-invalid={touched && missing}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      {touched && missing && (
        <p className={styles.fieldError} role="alert">
          {label} is required.
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </Dialog>
  )
}
