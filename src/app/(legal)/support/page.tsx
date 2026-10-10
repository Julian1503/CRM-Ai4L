import type { Metadata } from 'next'
import Link from 'next/link'

import { legalInfo } from '../legalInfo'
import styles from '../legal.module.css'

export const metadata: Metadata = {
  title: 'Support | AI4L CRM',
  description: 'Contact Ai4l for help with the CRM and its connected social accounts.',
}

export default function SupportPage() {
  return (
    <article className={styles.article}>
      <p className={styles.eyebrow}>AI4L CRM · Help</p>
      <h1>Support</h1>
      <p className={styles.intro}>For help with AI4L CRM or a connected Facebook Page or Instagram business account, contact {legalInfo.operator}.</p>

      <section>
        <h2>Contact us</h2>
        <p>Email <a href={`mailto:${legalInfo.contactEmail}`}>{legalInfo.contactEmail}</a>. If your question concerns a social connection, include the Page or Instagram account name and a brief description of the issue. Do not send passwords or access tokens.</p>
      </section>

      <section>
        <h2>Privacy and deletion</h2>
        <p>For requests about your information, see our <Link href="/privacy">privacy notice</Link> and <Link href="/data-deletion">data deletion instructions</Link>.</p>
      </section>
    </article>
  )
}
