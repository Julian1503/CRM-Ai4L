'use client'

import { useEffect, useRef, useState } from 'react'

import styles from '../book.module.css'

/** The only origin Calendly's embed posts from. Messages from anywhere else are ignored. */
export const CALENDLY_ORIGIN = 'https://calendly.com'
export const SCHEDULED_EVENT = 'calendly.event_scheduled'

/** True for Calendly's "an appointment was booked" message, from Calendly, from our frame. */
export function isScheduledMessage(event: MessageEvent, frame: Window | null): boolean {
  if (event.origin !== CALENDLY_ORIGIN) return false
  if (frame && event.source !== frame) return false
  const data = event.data as { event?: unknown } | null
  return typeof data === 'object' && data !== null && data.event === SCHEDULED_EVENT
}

type SchedulingStepProps = {
  calendlyHref: string
  /** Where Calendly sends the calendar invitation; the contact's own address. */
  email: string
}

/**
 * Step 2 of the public booking: choose a time in Calendly (UX plan P4.5).
 *
 * When Calendly reports the booking, the page shows its own confirmation straight away
 * instead of leaving the person on Calendly's screen. That message is display-only: it
 * is never sent to the server and changes nothing. The Calendly webhook remains the only
 * thing that marks the booking scheduled, and the operator screens read that.
 */
export default function SchedulingStep({ calendlyHref, email }: SchedulingStepProps) {
  const [scheduled, setScheduled] = useState(false)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (isScheduledMessage(event, frameRef.current?.contentWindow ?? null)) setScheduled(true)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  useEffect(() => {
    // The frame is replaced: move focus to the news, so it is announced and not lost.
    if (scheduled) headingRef.current?.focus()
  }, [scheduled])

  return (
    <>
      <ol className={styles.stepper} aria-label="Booking steps">
        <li className={styles.stepDone}>
          <span>1</span> Free offer confirmed
        </li>
        <li className={scheduled ? styles.stepDone : styles.stepActive} aria-current={scheduled ? undefined : 'step'}>
          <span>2</span> Choose a time
        </li>
      </ol>

      {scheduled ? (
        <div role="status">
          <h1 ref={headingRef} tabIndex={-1} className={styles.title}>
            You&apos;re booked in
          </h1>
          <p className={styles.lede}>
            Your free consultation is scheduled. Calendly is emailing a calendar invitation to <strong>{email}</strong> with the date,
            time and time zone you chose — it usually arrives within a few minutes.
          </p>
          <p className={styles.fineprint}>Need to change it? Use the reschedule link in that invitation.</p>
        </div>
      ) : (
        <>
          <h1 className={styles.title}>Choose a time that suits you</h1>
          <p className={styles.lede}>Pick any 30-minute slot below. You will get a calendar invitation straight away.</p>
          <iframe ref={frameRef} className={styles.calendlyFrame} src={calendlyHref} title="Choose a consultation time" loading="eager" />
        </>
      )}
    </>
  )
}
