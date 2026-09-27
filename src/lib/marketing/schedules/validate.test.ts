import { parseScheduleInput, parseTopicInput } from './validate'

const VALID = {
  name: ' Monthly newsletter ',
  templateId: 'tpl-1',
  segmentId: 'seg-1',
  frequency: 'monthly',
  firstRunDate: '2026-10-01',
  sendTime: '08:00',
  goal: ' Keep readers informed ',
  tone: ' Warm ',
  cta: '',
  mustInclude: null,
  avoid: 'Hype',
}

describe('parseScheduleInput — create', () => {
  it('normalises a complete schedule', () => {
    const result = parseScheduleInput(VALID, 'create')

    expect(result).toEqual({
      ok: true,
      value: {
        name: 'Monthly newsletter',
        template_id: 'tpl-1',
        segment_id: 'seg-1',
        frequency: 'monthly',
        timezone: 'Australia/Sydney',
        // 08:00 in Sydney on 1 October (AEST, +10; DST starts on the 4th).
        next_run_at: '2026-09-30T22:00:00.000Z',
        goal: 'Keep readers informed',
        tone: 'Warm',
        cta: null,
        must_include: null,
        avoid: 'Hype',
      },
    })
  })

  it.each([
    ['name', { name: '  ' }],
    ['templateId', { templateId: '' }],
    ['segmentId', { segmentId: undefined }],
    ['goal', { goal: '' }],
  ])('requires %s', (_field, override) => {
    expect(parseScheduleInput({ ...VALID, ...override }, 'create').ok).toBe(false)
  })

  it('rejects an unknown frequency', () => {
    expect(parseScheduleInput({ ...VALID, frequency: 'daily' }, 'create')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/weekly, fortnightly or monthly/),
    })
  })

  it.each(['2026-13-01', '01/10/2026', '2026-02-30', ''])('rejects the date %p', (firstRunDate) => {
    expect(parseScheduleInput({ ...VALID, firstRunDate }, 'create').ok).toBe(false)
  })

  it.each(['25:00', '8am', '08:60'])('rejects the time %p', (sendTime) => {
    expect(parseScheduleInput({ ...VALID, sendTime }, 'create').ok).toBe(false)
  })

  it('keeps a monthly schedule on days every month has', () => {
    // A monthly issue on the 31st would have to move in most months; refusing it up
    // front is clearer than a date that silently drifts.
    expect(parseScheduleInput({ ...VALID, firstRunDate: '2026-10-31' }, 'create')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/1st and the 28th/),
    })
    expect(
      parseScheduleInput({ ...VALID, frequency: 'weekly', firstRunDate: '2026-10-31' }, 'create').ok
    ).toBe(true)
  })

  it('rejects a zone the runtime does not know', () => {
    expect(parseScheduleInput({ ...VALID, timezone: 'Mars/Olympus' }, 'create').ok).toBe(false)
  })

  it('caps free text so a pasted document cannot become the prompt', () => {
    expect(parseScheduleInput({ ...VALID, goal: 'x'.repeat(2001) }, 'create').ok).toBe(false)
  })
})

describe('parseScheduleInput — update', () => {
  it('takes only the fields that were sent', () => {
    expect(parseScheduleInput({ tone: 'Plain', isActive: false }, 'update')).toEqual({
      ok: true,
      value: { tone: 'Plain', is_active: false },
    })
  })

  it('needs both date and time to move the next run', () => {
    expect(parseScheduleInput({ firstRunDate: '2026-11-01' }, 'update').ok).toBe(false)
    expect(parseScheduleInput({ firstRunDate: '2026-11-02', sendTime: '09:30' }, 'update')).toEqual({
      ok: true,
      value: { next_run_at: '2026-11-01T22:30:00.000Z' },
    })
  })

  it('still refuses to blank a required field', () => {
    expect(parseScheduleInput({ goal: ' ' }, 'update').ok).toBe(false)
  })

  it('archives and restores', () => {
    expect(parseScheduleInput({ archived: true }, 'update')).toMatchObject({
      ok: true,
      value: { archived_at: expect.any(String) },
    })
    expect(parseScheduleInput({ archived: false }, 'update')).toEqual({
      ok: true,
      value: { archived_at: null },
    })
  })

  it('rejects an update that changes nothing', () => {
    expect(parseScheduleInput({}, 'update').ok).toBe(false)
  })
})

describe('parseTopicInput', () => {
  it('normalises a topic', () => {
    expect(parseTopicInput({ title: ' AI tools ', details: ' ', position: 3 }, 'create')).toEqual({
      ok: true,
      value: { title: 'AI tools', details: null, position: 3 },
    })
  })

  it('requires a title on create', () => {
    expect(parseTopicInput({ details: 'x' }, 'create').ok).toBe(false)
  })

  it('rejects a non-integer position', () => {
    expect(parseTopicInput({ title: 'x', position: 1.5 }, 'create').ok).toBe(false)
  })
})
