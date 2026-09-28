import { isArchiveRuleError, lifecyclePatch, readLifecycleAction } from './lifecycle'

describe('readLifecycleAction', () => {
  it('is absent when the body touches neither flag', () => {
    expect(readLifecycleAction({ name: 'x' })).toEqual({ kind: 'none' })
  })

  it('reads archive and restore', () => {
    expect(readLifecycleAction({ archived: true })).toEqual({ kind: 'archive' })
    expect(readLifecycleAction({ archived: false })).toEqual({ kind: 'restore' })
  })

  it('reads remove', () => {
    expect(readLifecycleAction({ removed: true })).toEqual({ kind: 'remove' })
  })

  it('refuses to un-remove, because a removal is final for the application', () => {
    expect(readLifecycleAction({ removed: false })).toMatchObject({ kind: 'invalid' })
  })

  it('refuses a non-boolean flag', () => {
    expect(readLifecycleAction({ archived: 'yes' })).toMatchObject({ kind: 'invalid' })
  })

  it('refuses both flags, or a flag mixed with an edit', () => {
    expect(readLifecycleAction({ archived: true, removed: true })).toMatchObject({ kind: 'invalid' })
    expect(readLifecycleAction({ archived: true, name: 'x' })).toMatchObject({ kind: 'invalid' })
  })
})

describe('lifecyclePatch', () => {
  const NOW = '2026-09-30T00:00:00.000Z'

  it('archives', () => {
    expect(lifecyclePatch('archive', { archived_at: null }, 'u1', NOW)).toEqual({ archived_at: NOW })
  })

  it('restores', () => {
    expect(lifecyclePatch('restore', { archived_at: NOW }, 'u1', NOW)).toEqual({ archived_at: null })
  })

  it('removes, archiving too and keeping an earlier archive date', () => {
    expect(lifecyclePatch('remove', { archived_at: '2026-01-01T00:00:00.000Z' }, 'u1', NOW)).toEqual({
      archived_at: '2026-01-01T00:00:00.000Z',
      removed_at: NOW,
      removed_by: 'u1',
    })
    expect(lifecyclePatch('remove', { archived_at: null }, 'u1', NOW)).toMatchObject({ archived_at: NOW })
  })
})

describe('isArchiveRuleError', () => {
  it('recognises the database refusal by its SQLSTATE', () => {
    expect(isArchiveRuleError({ code: 'CRM01', message: 'x' })).toBe(true)
    expect(isArchiveRuleError({ code: '23505', message: 'x' })).toBe(false)
    expect(isArchiveRuleError(null)).toBe(false)
  })
})
