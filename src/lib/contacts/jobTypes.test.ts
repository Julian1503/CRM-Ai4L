import {
  JOB_TYPE_NAME_MAX_LENGTH,
  cleanJobTypeName,
  findDuplicateJobType,
  isUuid,
  normaliseJobTypeName,
  validateJobTypeName,
} from './jobTypes'

describe('job type names', () => {
  it('cleans surrounding and repeated whitespace', () => {
    expect(cleanJobTypeName('  Learning   and\tDevelopment ')).toBe('Learning and Development')
  })

  it('normalises like the lower(btrim(name)) index', () => {
    expect(normaliseJobTypeName('  RTO ')).toBe('rto')
  })

  it('accepts a name at the length limit and refuses one past it', () => {
    const atLimit = 'x'.repeat(JOB_TYPE_NAME_MAX_LENGTH)

    expect(validateJobTypeName(atLimit)).toEqual({ ok: true, name: atLimit })
    expect(validateJobTypeName(`${atLimit}x`).ok).toBe(false)
  })

  it.each([undefined, null, 3, '', '   '])('refuses %p', (value) => {
    expect(validateJobTypeName(value).ok).toBe(false)
  })

  it('finds a duplicate ignoring case and spaces, but not the row being renamed', () => {
    const options = [
      { id: 'a', name: 'Learning and Development' },
      { id: 'b', name: 'RTO' },
    ]

    expect(findDuplicateJobType(' rto ', options)).toEqual(options[1])
    expect(findDuplicateJobType('rto', options, 'b')).toBeNull()
    expect(findDuplicateJobType('Other', options)).toBeNull()
  })

  it('recognises uuids only', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true)
    expect(isUuid('abc')).toBe(false)
  })
})
