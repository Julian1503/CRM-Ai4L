import type { Metadata } from 'next'
import Link from 'next/link'

import { legalInfo } from '../legalInfo'
import styles from '../legal.module.css'

export const metadata: Metadata = {
  title: 'Data deletion instructions | AI4L CRM',
  description: 'How to disconnect a Meta account and request removal of information held by AI4L CRM.',
}

export default function DataDeletionPage() {
  return (
    <article className={styles.article}>
      <p className={styles.eyebrow}>AI4L CRM · Legal information</p>
      <h1>Data deletion instructions</h1>
      <p className={styles.intro}>You can remove the CRM&apos;s access to a connected Meta business account and request deletion of information held by {legalInfo.operator}.</p>
      <p className={styles.updated}>Last updated: 10 October 2026</p>

      <section>
        <h2>Disconnect a Page or Instagram account</h2>
        <ol>
          <li>Ask an AI4L CRM administrator to open <strong>Settings → Connections</strong>.</li>
          <li>Select the connected account and choose <strong>Disconnect</strong>.</li>
          <li>The CRM marks the account as disconnected and clears its stored publishing credentials. You can also remove the app&apos;s access in your Meta account settings.</li>
        </ol>
        <p className={styles.callout}>Disconnecting stops future publishing through that connection. It does not automatically erase account details or past publication records in the CRM.</p>
      </section>

      <section>
        <h2>Request deletion of stored information</h2>
        <p>Email <a href={`mailto:${legalInfo.contactEmail}?subject=AI4L%20CRM%20data%20deletion%20request`}>{legalInfo.contactEmail}</a> with the subject “AI4L CRM data deletion request”. Include the Page or Instagram business account name and the information you want removed.</p>
        <p>Do not send passwords, access tokens or other credentials. We may ask for information needed to confirm your authority over the account. We will review the CRM records associated with the request, remove or de-identify data where appropriate, and explain any information that must be retained.</p>
      </section>

      <section>
        <h2>More information</h2>
        <p>Our <Link href="/privacy">privacy notice</Link> describes the data handled by the CRM and the Meta connection. Requests about information held by Meta itself should be made through Meta&apos;s own account and privacy controls.</p>
      </section>
    </article>
  )
}
