import type { Metadata } from 'next'
import Link from 'next/link'

import { legalInfo } from '../legalInfo'
import styles from '../legal.module.css'

export const metadata: Metadata = {
  title: 'Privacy notice | AI4L CRM',
  description: 'How AI4L CRM handles information, including Facebook Pages and connected Instagram business accounts.',
}

export default function PrivacyPage() {
  return (
    <article className={styles.article}>
      <p className={styles.eyebrow}>AI4L CRM · Legal information</p>
      <h1>Privacy notice</h1>
      <p className={styles.intro}>This notice explains how {legalInfo.operator}, operating in {legalInfo.country}, uses information in its private CRM and in the connection to Facebook Pages and Instagram business accounts.</p>
      <p className={styles.updated}>Last updated: 10 October 2026</p>

      <section>
        <h2>Information we handle</h2>
        <p>The CRM stores information entered by authorised staff, including business contact records, campaign materials, content briefs, drafts, approvals and publication history. Staff sign in with an invited account.</p>
        <p>When an administrator connects Meta, the integration receives the selected Page or Instagram business account identifier and name, granted permissions, and credentials needed to publish. Publishing credentials are stored encrypted. The integration may also record publication identifiers, links and operational errors.</p>
      </section>

      <section>
        <h2>Why we use it</h2>
        <ul>
          <li>To give authorised staff access to the CRM and manage customer relationships.</li>
          <li>To let staff prepare, review and publish content to accounts they are authorised to manage.</li>
          <li>To keep a record of connection status, publishing attempts and the content published from the CRM.</li>
        </ul>
        <p>Connecting a Meta account authorises access to selected business assets for publishing. It does not make Facebook Login the sign-in method for CRM staff.</p>
      </section>

      <section>
        <h2>Who processes the information</h2>
        <p>Authorised CRM staff can access data needed for their role. The application uses hosting, database, content generation and delivery providers to operate these features. Content selected for publishing is sent to Meta through its APIs. The applicable provider may also process the information under its own terms and privacy notice.</p>
      </section>

      <section>
        <h2>Keeping and removing information</h2>
        <p>Disconnecting a social account makes its stored publishing credentials unusable. Account details and publication history may remain in the CRM for operational records. Requests to remove other associated data are reviewed against the information we hold and any applicable retention requirements.</p>
        <p>See the <Link href="/data-deletion">data deletion instructions</Link> for a request method. Removing the app from your Meta account also revokes its access at Meta, but does not itself erase CRM records.</p>
      </section>

      <section>
        <h2>Questions and requests</h2>
        <p>Contact {legalInfo.operator} at <a href={`mailto:${legalInfo.contactEmail}`}>{legalInfo.contactEmail}</a> for privacy questions or requests about your information.</p>
      </section>
    </article>
  )
}
