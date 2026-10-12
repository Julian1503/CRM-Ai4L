/**
 * @jest-environment node
 *
 * Saved groups by tag against the real database: the application's tag criteria
 * (`tag_ids=ov`, `not.tag_ids=ov`) over segment_contacts(), together with the consent
 * gate, manual overrides and the 20261010000000 function.
 */
import { describeIntegration, must, serviceClient, uniqueTag } from '@/test/integration'

import { criteriaToDefinition, EMPTY_CRITERIA } from './segmentCriteria'
import { resolveSegmentAudience } from './segments'

jest.setTimeout(60_000)

describeIntegration('segment tag criteria against Postgres', () => {
  it('selects any-of, leaves out excluded tags, keeps consent and overrides', async () => {
    const db = serviceClient()
    const tag = uniqueTag('segtags')

    const vip = await must(db.from('tags').insert({ name: `VIP ${tag}` }).select('id').single())
    const workshop = await must(db.from('tags').insert({ name: `Workshop ${tag}` }).select('id').single())

    const contact = (name: string, consent: 'newsletter' | 'programs') => ({
      first_name: name,
      last_name: tag,
      email: `${name.toLowerCase()}-${tag}@example.test`,
      subscribed_to_newsletter: consent === 'newsletter',
      subscribed_to_programs: consent === 'programs',
    })
    const [both, vipOnly, none, courses] = await must(
      db
        .from('contacts')
        .insert([contact('Both', 'newsletter'), contact('Vip', 'newsletter'), contact('None', 'newsletter'), contact('Courses', 'programs')])
        .select('id, first_name')
    ).then((rows) => ['Both', 'Vip', 'None', 'Courses'].map((name) => rows.find((row) => row.first_name === name)!.id))

    await must(
      db
        .from('contact_tags')
        .insert([
          { contact_id: both, tag_id: vip.id },
          { contact_id: both, tag_id: workshop.id },
          { contact_id: vipOnly, tag_id: vip.id },
          { contact_id: courses, tag_id: vip.id },
        ])
        .select('contact_id')
    )

    const resolve = async (segmentId: string | null, definition: Record<string, string>) => {
      const page = await resolveSegmentAudience(db, { segmentId, definition, stream: 'newsletter', page: 1, pageSize: 50, search: tag })
      return page.members.map((member) => member.id).sort()
    }

    const anyVip = criteriaToDefinition({ ...EMPTY_CRITERIA, tagIds: [vip.id] })
    expect(await resolve(null, anyVip)).toEqual([both, vipOnly].sort())

    const vipNotWorkshop = criteriaToDefinition({ ...EMPTY_CRITERIA, tagIds: [vip.id], excludeTagIds: [workshop.id] })
    expect(await resolve(null, vipNotWorkshop)).toEqual([vipOnly])

    const notWorkshop = criteriaToDefinition({ ...EMPTY_CRITERIA, excludeTagIds: [workshop.id] })
    expect(await resolve(null, notWorkshop)).toEqual([vipOnly, none].sort())

    // Overrides behave as before: an exclusion removes, an inclusion widens the criteria,
    // never consent (Courses has no newsletter consent).
    const segment = await must(db.from('segments').insert({ name: tag, definition: anyVip }).select('id').single())
    await must(
      db
        .from('segment_overrides')
        .insert([
          { segment_id: segment.id, contact_id: vipOnly, mode: 'exclude' },
          { segment_id: segment.id, contact_id: none, mode: 'include' },
          { segment_id: segment.id, contact_id: courses, mode: 'include' },
        ])
        .select('contact_id')
    )
    expect(await resolve(segment.id, anyVip)).toEqual([both, none].sort())

    // A saved segment naming a tag that no longer matches anyone selects nobody by tag.
    const unknown = criteriaToDefinition({ ...EMPTY_CRITERIA, tagIds: ['dddddddd-dddd-4ddd-8ddd-dddddddddddd'] })
    expect(await resolve(null, unknown)).toEqual([])
  })
})
