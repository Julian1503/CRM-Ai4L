import { AU_STATE_CODES, normaliseAuState } from './states'

describe('normaliseAuState', () => {
  it('returns a code unchanged', () => {
    expect(normaliseAuState('NSW')).toBe('NSW')
  })

  it('folds a full state name to its code', () => {
    // Apollo, Salesforce and most enrichment exports write the full name. The segment
    // filter compares against codes, so an unfolded value can never match and the
    // contact is invisible to state segmentation.
    expect(normaliseAuState('New South Wales')).toBe('NSW')
    expect(normaliseAuState('Western Australia')).toBe('WA')
    expect(normaliseAuState('Australian Capital Territory')).toBe('ACT')
  })

  it.each([
    ['  queensland  ', 'QLD'],
    ['VICTORIA', 'VIC'],
    ['new  south   wales', 'NSW'],
    ['vic', 'VIC'],
  ])('folds %s regardless of case and spacing', (input, expected) => {
    expect(normaliseAuState(input)).toBe(expected)
  })

  it('keeps a value it does not recognise, rather than discarding the data', () => {
    // A non-Australian export is not wrong, just unsegmentable by state.
    expect(normaliseAuState('Texas')).toBe('Texas')
    expect(normaliseAuState('  Île-de-France ')).toBe('Île-de-France')
  })

  it('returns undefined for nothing', () => {
    expect(normaliseAuState('')).toBeUndefined()
    expect(normaliseAuState('   ')).toBeUndefined()
    expect(normaliseAuState(undefined)).toBeUndefined()
  })

  it('produces a code the segment filter accepts', () => {
    expect(AU_STATE_CODES).toContain(normaliseAuState('South Australia'))
  })
})
