/**
 * Australian states and territories.
 *
 * The client base is Australian (AUD pricing, state-based segmentation), so the state
 * filter is a fixed list rather than free text — it keeps the filter reliable even
 * when imported spreadsheets spell things inconsistently.
 */
export const AU_STATES = [
  { code: 'ACT', name: 'Australian Capital Territory' },
  { code: 'NSW', name: 'New South Wales' },
  { code: 'NT', name: 'Northern Territory' },
  { code: 'QLD', name: 'Queensland' },
  { code: 'SA', name: 'South Australia' },
  { code: 'TAS', name: 'Tasmania' },
  { code: 'VIC', name: 'Victoria' },
  { code: 'WA', name: 'Western Australia' },
] as const

export const AU_STATE_CODES = AU_STATES.map((state) => state.code)

/** Both spellings of every state, keyed by their comparison form. */
const STATE_LOOKUP = new Map<string, string>(
  AU_STATES.flatMap((state) => [
    [comparable(state.code), state.code] as const,
    [comparable(state.name), state.code] as const,
  ])
)

function comparable(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Folds a state value to the code the rest of the system segments on.
 *
 * Spreadsheet exports write the full name — Apollo ships "New South Wales", never
 * "NSW" — while segments filter on the code from `AU_STATES`. Stored unfolded, a
 * contact matches no state segment at all and quietly drops out of every campaign
 * targeted that way, with nothing on screen to say why.
 *
 * An unrecognised value is returned as-is rather than dropped: a non-Australian
 * contact is not bad data, it is just not segmentable by state.
 */
export function normaliseAuState(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim()

  if (!trimmed) return undefined

  return STATE_LOOKUP.get(comparable(trimmed)) ?? trimmed
}
