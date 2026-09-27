'use client'

import { useCallback, useEffect, useState } from 'react'

import type { NewsletterTopicRow } from '@/lib/db/types'

import styles from './marketing.module.css'

type Topic = Pick<NewsletterTopicRow, 'id' | 'title' | 'details' | 'position' | 'used_at'>

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => ({}))
  return body.error || `Request failed (HTTP ${response.status})`
}

/**
 * What the next issues of one schedule will be about.
 *
 * Each run takes the first unused topic, top to bottom. Used topics stay listed as
 * history and cannot be edited or removed — they are the record of what an issue was
 * about. An empty queue is allowed: the issue is then written from the goal alone.
 */
export default function NewsletterTopicQueue({ scheduleId }: { scheduleId: string }) {
  const [topics, setTopics] = useState<Topic[]>([])
  const [title, setTitle] = useState('')
  const [details, setDetails] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const base = `/api/newsletter-schedules/${scheduleId}/topics`

  const load = useCallback(async () => {
    try {
      const response = await fetch(base)
      if (!response.ok) throw new Error(await readError(response))
      setTopics((await response.json()).topics ?? [])
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load topics.')
    }
  }, [base])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const act = async (request: () => Promise<Response>, onDone?: () => void) => {
    setError(null)
    setBusy(true)

    try {
      const response = await request()
      if (!response.ok) throw new Error(await readError(response))
      onDone?.()
      await load()
    } catch (actError) {
      setError(actError instanceof Error ? actError.message : 'Could not update topics.')
    } finally {
      setBusy(false)
    }
  }

  const add = () =>
    act(
      () =>
        fetch(base, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, details }),
        }),
      () => {
        setTitle('')
        setDetails('')
      }
    )

  const remove = (topicId: string) => act(() => fetch(`${base}/${topicId}`, { method: 'DELETE' }))

  const queued = topics.filter((topic) => !topic.used_at)
  const used = topics.filter((topic) => topic.used_at)

  return (
    <div className={styles.topicQueue}>
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}

      <div className={styles.formRow}>
        <label className={styles.field}>
          <span className={styles.label}>Topic</span>
          <input
            className={styles.input}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="AI note-taking in meetings"
            data-testid="topic-title"
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Details (optional)</span>
          <input
            className={styles.input}
            value={details}
            onChange={(event) => setDetails(event.target.value)}
            placeholder="Angle, examples, links to mention"
            data-testid="topic-details"
          />
        </label>
      </div>
      <button
        type="button"
        className={styles.secondaryBtn}
        onClick={add}
        disabled={!title.trim() || busy}
        data-testid="add-topic"
      >
        Add to queue
      </button>

      <ol className={styles.topicList}>
        {queued.length === 0 && (
          <li className={styles.empty}>
            No topics queued. The next issue will be written from the goal alone.
          </li>
        )}
        {queued.map((topic, index) => (
          <li key={topic.id} className={styles.topicItem} data-testid={`topic-${topic.id}`}>
            <span className={styles.topicOrder}>{index === 0 ? 'Next' : `#${index + 1}`}</span>
            <span className={styles.topicText}>
              <span className={styles.itemName}>{topic.title}</span>
              {topic.details && <span className={styles.itemMeta}>{topic.details}</span>}
            </span>
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={() => remove(topic.id)}
              disabled={busy}
              data-testid={`remove-topic-${topic.id}`}
            >
              Remove
            </button>
          </li>
        ))}
        {used.map((topic) => (
          <li
            key={topic.id}
            className={`${styles.topicItem} ${styles.topicUsed}`}
            data-testid={`topic-${topic.id}`}
          >
            <span className={styles.topicOrder}>Used</span>
            <span className={styles.topicText}>
              <span className={styles.itemName}>{topic.title}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}
