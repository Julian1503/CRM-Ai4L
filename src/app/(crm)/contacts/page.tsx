import { Suspense } from 'react'

import ContactsView from '@/components/contacts/ContactsView'

export default function ContactsPage() {
  // Search, filters, sort and page live in the URL; Suspense is required around useSearchParams.
  return (
    <Suspense fallback={null}>
      <ContactsView />
    </Suspense>
  )
}
