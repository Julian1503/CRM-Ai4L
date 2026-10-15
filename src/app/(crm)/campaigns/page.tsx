import { Suspense } from 'react'

import { CampaignsWorkspace } from '@/components/crm/Workspaces'

export default function Page() {
  // The workspace reads its state from the URL; Suspense keeps the rest of the route static.
  return (
    <Suspense fallback={null}>
      <CampaignsWorkspace />
    </Suspense>
  )
}
