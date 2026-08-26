/**
 * Spreadsheet header -> CRM field guessing for the contact importer.
 *
 * Every import still goes through the mapping screen, so this only has to produce a
 * good first guess. What it must not do is produce a *confidently wrong* one: the
 * previous inline heuristic scanned each header with a chain of `includes()` checks and
 * let the last match win, so an Apollo export whose columns run
 * `Company Name ... Company Address, Company City, Company State, Company Country`
 * ended up filing "Company Country" as the organisation name.
 *
 * Two rules keep that from happening again:
 *  - exact alias matches are resolved before fuzzy `contains` matches, and
 *  - a header is consumed by the first field that claims it, so nothing is overwritten.
 */

/** CRM fields the importer can fill, in the order the mapping screen lists them. */
export const CRM_FIELD_KEYS = [
  'fullName',
  'firstName',
  'lastName',
  'email',
  'preferredName',
  'mobileNumber',
  'workPhone',
  'address',
  'suburb',
  'state',
  'postcode',
  'country',
  'organisationName',
  'jobTypeName',
  'department',
  'position',
  'isCustomer',
  'subscribedToNewsletter',
] as const

export type CrmFieldKey = (typeof CRM_FIELD_KEYS)[number]

/** A CRM field to the spreadsheet header feeding it; an empty string means "not mapped". */
export type ColumnMapping = Record<CrmFieldKey, string>

type FieldRule = {
  field: CrmFieldKey
  /** Normalised headers that identify the field outright. */
  exact: string[]
  /** Normalised fragments accepted once every exact match has been placed. */
  contains?: string[]
  /** Fragments that disqualify a header, checked in both passes. */
  exclude?: string[]
}

/** Fragments that mark a column as describing the employer rather than the person. */
const COMPANY_SCOPED = ['company', 'organisation', 'organization', 'employer', 'account']

/**
 * Rules in mapping-screen order.
 *
 * Order only decides ties -- two fields wanting the same header -- so the earlier field
 * wins. That is why `fullName` sits above the split-name fields but is dropped again
 * afterwards when both are present.
 */
const FIELD_RULES: FieldRule[] = [
  {
    field: 'fullName',
    exact: ['full name', 'name', 'contact name', 'contact', 'person name', 'display name'],
    contains: ['full name'],
    exclude: [...COMPANY_SCOPED, 'first', 'last', 'file', 'user', 'job', 'type', 'domain'],
  },
  {
    field: 'firstName',
    exact: ['first name', 'fname', 'given name', 'first'],
    contains: ['first name'],
    exclude: COMPANY_SCOPED,
  },
  {
    field: 'lastName',
    exact: ['last name', 'lname', 'surname', 'family name', 'last'],
    contains: ['last name', 'surname', 'family name'],
    exclude: COMPANY_SCOPED,
  },
  {
    field: 'email',
    exact: [
      'email',
      'e mail',
      'email address',
      'e mail address',
      'primary email',
      'work email',
      'business email',
    ],
    contains: ['email', 'e mail'],
    // Apollo and most enrichment tools ship deliverability metadata beside the address.
    exclude: [
      'status',
      'confidence',
      'verified',
      'validation',
      'bounce',
      'unsubscrib',
      'opt',
      'score',
      'source',
    ],
  },
  {
    field: 'preferredName',
    exact: ['preferred name', 'preferred first name', 'nickname', 'known as', 'goes by'],
    contains: ['preferred name', 'nickname'],
  },
  {
    field: 'mobileNumber',
    exact: [
      'mobile',
      'mobile number',
      'mobile phone',
      'cell',
      'cell phone',
      'personal phone',
      'phone',
      'phone number',
      'telephone',
      'contact number',
    ],
    contains: ['mobile', 'cell'],
    exclude: [...COMPANY_SCOPED, 'work', 'office', 'corporate', 'business', 'fax', 'hq'],
  },
  {
    field: 'workPhone',
    exact: [
      'work phone',
      'corporate phone',
      'office phone',
      'company phone',
      'business phone',
      'work number',
      'direct dial',
      'direct phone',
    ],
    contains: [
      'work phone',
      'corporate phone',
      'office phone',
      'company phone',
      'business phone',
    ],
  },
  {
    field: 'address',
    exact: [
      'address',
      'street',
      'street address',
      'address line 1',
      'address 1',
      'postal address',
      'physical address',
      'site address',
    ],
    contains: ['street address', 'address'],
    // Company-scoped for the same reason as the fields below it: an Apollo row can put
    // the employer's head office in Houston next to a contact living in Perth, and
    // writing that street onto the contact contradicts the suburb/state/country beside
    // it. The operator can still pick the column by hand.
    exclude: [...COMPANY_SCOPED, 'email', 'url', 'ip', 'web', 'domain'],
  },
  {
    field: 'suburb',
    exact: ['suburb', 'city', 'town', 'locality'],
    contains: ['suburb', 'city', 'locality'],
    exclude: COMPANY_SCOPED,
  },
  {
    field: 'state',
    exact: ['state', 'province', 'region', 'state province'],
    contains: ['state'],
    exclude: [...COMPANY_SCOPED, 'email', 'real estate'],
  },
  {
    field: 'postcode',
    exact: ['postcode', 'post code', 'zip', 'zip code', 'postal code', 'postal'],
    contains: ['postcode', 'post code', 'zip code', 'postal code'],
    exclude: COMPANY_SCOPED,
  },
  {
    field: 'country',
    exact: ['country', 'nation'],
    contains: ['country'],
    exclude: COMPANY_SCOPED,
  },
  {
    field: 'organisationName',
    exact: [
      'company',
      'company name',
      'organisation',
      'organization',
      'organisation name',
      'organization name',
      'employer',
      'account name',
      'business name',
    ],
    contains: ['company name', 'organisation name', 'organization name', 'employer'],
    // Everything an enrichment export hangs off the company besides its name.
    exclude: [
      'address',
      'city',
      'state',
      'country',
      'postcode',
      'zip',
      'phone',
      'linkedin',
      'facebook',
      'twitter',
      'url',
      'website',
      'domain',
      'email',
      'employees',
      'size',
      'industry',
      'revenue',
      'founded',
      'id',
      'keywords',
      'description',
      'technolog',
      'sic',
      'naics',
    ],
  },
  {
    field: 'jobTypeName',
    exact: ['job type', 'trade', 'industry', 'category', 'work category', 'sector'],
    contains: ['job type', 'trade', 'industry'],
  },
  {
    field: 'department',
    exact: ['department', 'dept', 'division', 'departments'],
    contains: ['department', 'dept'],
  },
  {
    field: 'position',
    exact: ['title', 'job title', 'position', 'role', 'job role', 'seniority'],
    contains: ['job title', 'position'],
    exclude: COMPANY_SCOPED,
  },
  {
    field: 'isCustomer',
    exact: ['is customer', 'customer', 'is client', 'client', 'is active client', 'active client'],
    contains: ['is customer', 'is client'],
    exclude: ['id', 'number', 'name', 'since', 'email', 'count'],
  },
  {
    field: 'subscribedToNewsletter',
    exact: [
      'newsletter',
      'subscribed',
      'subscribe',
      'subscribed to newsletter',
      'newsletter subscription',
      'marketing opt in',
      'opt in',
    ],
    contains: ['newsletter', 'subscrib', 'opt in'],
  },
]

/**
 * Folds the cosmetic differences between exports.
 *
 * `  FIRST_NAME `, `First-Name` and `first name` all describe the same column, and
 * `E-Mail` only matches `e mail` once the separator is gone. Anything that is not a
 * letter or a digit is a separator here, so `Is Customer?` and `State/Province` reach
 * the alias lists in the same shape as their plainer spellings.
 *
 * PascalCase is split back into words before the case is folded, because an export
 * that simply prints the field names -- `FirstName`, `EmailAddress`, `WorkPhone` --
 * otherwise arrives as one long token that matches no alias at all.
 */
function normalise(header: string): string {
  return header
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    // `WorkPhone` -> `Work Phone`, then `ABNNumber` -> `ABN Number`.
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Word separators removed, so `EMAILADDRESS` still meets `email address`. */
function condense(value: string): string {
  return value.replace(/ /g, '')
}

/** Every CRM field present and unmapped -- the importer's starting state. */
export function emptyColumnMapping(): ColumnMapping {
  return Object.fromEntries(CRM_FIELD_KEYS.map((key) => [key, ''])) as ColumnMapping
}

function isDisqualified(normalised: string, rule: FieldRule): boolean {
  return Boolean(rule.exclude?.some((fragment) => normalised.includes(fragment)))
}

/**
 * Guesses which spreadsheet column feeds which CRM field.
 *
 * Unrecognised columns are simply left out; the mapping screen is where the operator
 * fixes anything this got wrong.
 */
export function autoMapHeaders(headers: string[]): ColumnMapping {
  const mapping = emptyColumnMapping()
  const candidates = headers
    .filter((header) => header.trim() !== '')
    .map((header) => ({ header, normalised: normalise(header) }))
  const used = new Set<string>()

  const claim = (rule: FieldRule, matches: (normalised: string) => boolean): void => {
    if (mapping[rule.field]) return

    const hit = candidates.find(
      ({ header, normalised }) =>
        !used.has(header) && !isDisqualified(normalised, rule) && matches(normalised)
    )

    if (!hit) return

    mapping[rule.field] = hit.header
    used.add(hit.header)
  }

  // Exact aliases first, across all fields, so a fuzzy match can never steal a header
  // that names its field outright.
  for (const rule of FIELD_RULES) {
    claim(rule, (normalised) => rule.exact.includes(normalised))
  }

  // Then the same aliases with the word breaks removed, which catches the run-together
  // spellings (`EMAILADDRESS`, `firstname`) a case-folded header leaves behind.
  for (const rule of FIELD_RULES) {
    const condensed = rule.exact.map(condense)
    claim(rule, (normalised) => condensed.includes(condense(normalised)))
  }

  for (const rule of FIELD_RULES) {
    claim(rule, (normalised) =>
      Boolean(rule.contains?.some((fragment) => normalised.includes(fragment)))
    )
  }

  // A mapped full name is split into first/last during validation and would overwrite
  // the dedicated columns, so it only stands in when there is no first-name column.
  if (mapping.firstName) {
    mapping.fullName = ''
  }

  return mapping
}
