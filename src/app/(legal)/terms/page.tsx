import type { Metadata } from 'next'
import Link from 'next/link'

import { legalInfo } from '../legalInfo'
import styles from '../legal.module.css'

export const metadata: Metadata = {
  title: 'Terms of use | AI4L CRM',
  description: 'Terms for authorised use of AI4L CRM and its social publishing connections.',
}

export default function TermsPage() {
  return (
    <article className={styles.article}>
      <p className={styles.eyebrow}>AI4L CRM · Legal information</p>
      <h1>Terms of use</h1>
      <p className={styles.intro}>These terms describe the permitted use of the private AI4L CRM operated by {legalInfo.operator}.</p>
      <p className={styles.updated}>Last updated: 10 October 2026</p>

      <section>
        <h2>Access</h2>
        <p>Use of the CRM is limited to people invited and approved by an administrator. Keep your account secure and use only the access and business information you are authorised to handle.</p>
      </section>

      <section>
        <h2>Connected accounts</h2>
        <p>Connect a Facebook Page, Instagram business account or other service only if you have permission to manage it. The administrator who connects an account is responsible for selecting the correct business assets and permissions. Access can be removed from Settings in the CRM or from the connected provider.</p>
      </section>

      <section>
        <h2>Content and publishing</h2>
        <p>Review drafts, including AI-assisted drafts, before publication. Users are responsible for checking facts, rights to images and other materials, destinations, links and the rules of the connected platform before approving or publishing content.</p>
      </section>

      <section>
        <h2>Third-party services</h2>
        <p>Use of Meta and other connected services remains subject to those services&apos; own terms and policies. Availability of a connection or a publishing action can change when a provider changes its API or permissions.</p>
      </section>

      <section>
        <h2>Privacy and contact</h2>
        <p>Read our <Link href="/privacy">privacy notice</Link> and <Link href="/data-deletion">data deletion instructions</Link> to understand the information associated with this service.</p>
        <p>Questions about these terms can be sent to <a href={`mailto:${legalInfo.contactEmail}`}>{legalInfo.contactEmail}</a>.</p>
      </section>
    </article>
  )
}
