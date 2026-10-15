import type { ReactNode } from 'react'

import CrmShell from '@/components/crm/CrmShell'

/** Every CRM workspace route shares one shell: sidebar, background and reference data. */
export default function CrmLayout({ children }: { children: ReactNode }) {
  return <CrmShell>{children}</CrmShell>
}
