/** @jest-environment node */
import { createDbMock, createQueryBuilderMock } from '@/test/supabaseMock'

import { recordAudit } from './audit'
import { IDS } from './testFixtures'

describe('recordAudit', () => {
  it('records the event through record_content_audit, which takes the actor from the session', async () => {
    const db = createDbMock(createQueryBuilderMock())

    const ok = await recordAudit(db as never, {
      actorId: IDS.user,
      action: 'item.created',
      subjectType: 'content_item',
      subjectId: IDS.item,
      details: { title: 'Launch' },
    })

    expect(ok).toBe(true)
    expect(db.from).not.toHaveBeenCalled()
    expect(db.rpc).toHaveBeenCalledWith('record_content_audit', {
      p_action: 'item.created',
      p_subject_type: 'content_item',
      p_subject_id: IDS.item,
      p_details: { title: 'Launch' },
    })
  })

  it('reports a failure without throwing', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const db = createDbMock(createQueryBuilderMock())
    db.rpc.mockResolvedValue({ data: null, error: { message: 'denied' } })

    try {
      const ok = await recordAudit(db as never, {
        actorId: IDS.user,
        action: 'asset.archived',
        subjectType: 'content_asset',
        subjectId: IDS.asset,
      })

      expect(ok).toBe(false)
      expect(db.rpc.mock.calls[0][1]).toMatchObject({ p_details: {} })
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})
