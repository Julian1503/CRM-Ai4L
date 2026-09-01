import { CAMPAIGN_COPY_FIELDS } from './mergeFields'
import { BUILT_IN_TEMPLATE_SLOTS, parseTemplateSlots } from './templates'

describe('BUILT_IN_TEMPLATE_SLOTS', () => {
  it('mirrors the merge-field contract instead of restating it', () => {
    // Derived, not copied: a template registered today must ask the copywriter for
    // exactly the tags the validator and the list setup checklist know about.
    expect(BUILT_IN_TEMPLATE_SLOTS.map((slot) => slot.tag)).toEqual(
      CAMPAIGN_COPY_FIELDS.map((field) => field.tag)
    )
    expect(BUILT_IN_TEMPLATE_SLOTS).toHaveLength(7)
  })

  it('satisfies its own parser', () => {
    expect(parseTemplateSlots(BUILT_IN_TEMPLATE_SLOTS)).toEqual(BUILT_IN_TEMPLATE_SLOTS)
  })
})

describe('parseTemplateSlots', () => {
  const slot = { tag: 'Headline', label: 'Headline', description: 'A line.', maxLength: 80 }

  it('accepts a well-formed slot and trims it', () => {
    expect(parseTemplateSlots([{ ...slot, tag: '  Headline  ' }])).toEqual([slot])
  })

  it('rejects an empty array, which would generate an empty email', () => {
    expect(parseTemplateSlots([])).toBeNull()
  })

  it('rejects a non-array', () => {
    expect(parseTemplateSlots({ tag: 'Headline' })).toBeNull()
    expect(parseTemplateSlots(null)).toBeNull()
  })

  it('rejects a slot with no tag or no label', () => {
    expect(parseTemplateSlots([{ ...slot, tag: '   ' }])).toBeNull()
    expect(parseTemplateSlots([{ ...slot, label: '' }])).toBeNull()
  })

  it('rejects a maxLength that could not cap anything', () => {
    expect(parseTemplateSlots([{ ...slot, maxLength: 0 }])).toBeNull()
    expect(parseTemplateSlots([{ ...slot, maxLength: 12.5 }])).toBeNull()
    expect(parseTemplateSlots([{ ...slot, maxLength: '80' }])).toBeNull()
  })

  it('rejects a duplicated tag, which would drop one slot from the tool schema', () => {
    expect(parseTemplateSlots([slot, { ...slot, tag: 'headline' }])).toBeNull()
  })

  it('defaults a missing description rather than failing the row', () => {
    const { description: _unused, ...withoutDescription } = slot

    expect(parseTemplateSlots([withoutDescription])).toEqual([{ ...slot, description: '' }])
  })
})
