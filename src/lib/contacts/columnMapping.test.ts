import {
  analyseHeaders,
  autoMapHeaders,
  describeMissingRequirements,
  emptyColumnMapping,
  isMappingComplete,
  type ColumnMapping,
} from './columnMapping'
import { CRM_FIELDS, IMPORT_REQUIREMENT_OPTIONS } from './importFields'

/** Header row of `apollo-contacts-export_REQUIRED FIELDS`, in its real order. */
const APOLLO_HEADERS = [
  'First Name',
  'Last Name',
  'Title',
  'Company Name',
  'Email',
  'Corporate Phone',
  '# Employees',
  'Industry',
  'Person Linkedin Url',
  'Website',
  'Company Linkedin Url',
  'Facebook Url',
  'Twitter Url',
  'City',
  'State',
  'Country',
  'Company Address',
  'Company City',
  'Company State',
  'Company Country',
]

describe('autoMapHeaders - Apollo export', () => {
  const mapping = autoMapHeaders(APOLLO_HEADERS)

  it('maps the identity columns', () => {
    expect(mapping.firstName).toBe('First Name')
    expect(mapping.lastName).toBe('Last Name')
    expect(mapping.email).toBe('Email')
  })

  it('keeps the company name out of the company address columns', () => {
    // The previous keyword scan let "Company Country" (the last match) win.
    expect(mapping.organisationName).toBe('Company Name')
  })

  it('reads a corporate phone as a work phone, not a mobile', () => {
    expect(mapping.workPhone).toBe('Corporate Phone')
    expect(mapping.mobileNumber).toBe('')
  })

  it('maps the person location columns, not the company ones', () => {
    expect(mapping.suburb).toBe('City')
    expect(mapping.state).toBe('State')
    expect(mapping.country).toBe('Country')
  })

  it('leaves the address unmapped rather than filing the head office on the person', () => {
    // Row 1 of the real export is a Perth contact whose employer sits in Houston.
    expect(mapping.address).toBe('')
  })

  it('maps title to position but leaves industry for the operator to decide', () => {
    // Industry is the organisation's sector, not the contact's job type: an old file
    // must not be silently reinterpreted either way.
    expect(mapping.position).toBe('Title')
    expect(mapping.jobTypeName).toBe('')
    expect(analyseHeaders(APOLLO_HEADERS).ambiguous.map(({ header }) => header)).toEqual(['Industry'])
  })

  it('leaves social and metadata columns unmapped', () => {
    const assigned = Object.values(mapping).filter(Boolean)
    expect(assigned).not.toContain('Person Linkedin Url')
    expect(assigned).not.toContain('Website')
    expect(assigned).not.toContain('# Employees')
    expect(assigned).not.toContain('Facebook Url')
  })

  it('never assigns one column to two fields', () => {
    const assigned = Object.values(mapping).filter(Boolean)
    expect(new Set(assigned).size).toBe(assigned.length)
  })
})

describe('autoMapHeaders - general spreadsheets', () => {
  it('maps a full-name sheet with the CRM synonyms', () => {
    const mapping = autoMapHeaders([
      'Full Name',
      'Email Address',
      'Company',
      'Job Type',
      'State',
      'Newsletter',
      'Is Active Client',
    ])

    expect(mapping.fullName).toBe('Full Name')
    expect(mapping.email).toBe('Email Address')
    expect(mapping.organisationName).toBe('Company')
    expect(mapping.jobTypeName).toBe('Job Type')
    expect(mapping.state).toBe('State')
    expect(mapping.subscribedToNewsletter).toBe('Newsletter')
    expect(mapping.isCustomer).toBe('Is Active Client')
  })

  it('maps the two consents to separate columns', () => {
    const mapping = autoMapHeaders(['Email', 'Newsletter', 'Courses & Training'])

    expect(mapping.subscribedToNewsletter).toBe('Newsletter')
    expect(mapping.subscribedToPrograms).toBe('Courses & Training')
  })

  it('does not let the newsletter rule claim a programmes column', () => {
    // Both rules fuzzy-match `subscrib`, and the two consents are not interchangeable:
    // a header claimed by the wrong one grants or withdraws the wrong permission.
    const mapping = autoMapHeaders(['Email', 'Subscribed to programs'])

    expect(mapping.subscribedToPrograms).toBe('Subscribed to programs')
    expect(mapping.subscribedToNewsletter).toBe('')
  })

  it('prefers split name columns over a full-name column when both exist', () => {
    const mapping = autoMapHeaders(['Name', 'First Name', 'Last Name', 'Email'])

    expect(mapping.firstName).toBe('First Name')
    expect(mapping.lastName).toBe('Last Name')
    // A full-name split would overwrite the split columns during validation.
    expect(mapping.fullName).toBe('')
  })

  it('separates mobile from work phone when a sheet carries both', () => {
    const mapping = autoMapHeaders(['Email', 'Mobile', 'Work Phone'])

    expect(mapping.mobileNumber).toBe('Mobile')
    expect(mapping.workPhone).toBe('Work Phone')
  })

  it('treats a bare Phone column as the mobile number', () => {
    const mapping = autoMapHeaders(['Email', 'Phone'])

    expect(mapping.mobileNumber).toBe('Phone')
    expect(mapping.workPhone).toBe('')
  })

  it('ignores email metadata columns when picking the email', () => {
    const mapping = autoMapHeaders(['Email Status', 'Email Confidence', 'Email'])

    expect(mapping.email).toBe('Email')
  })

  it('matches headers regardless of case, spacing and underscores', () => {
    const mapping = autoMapHeaders(['  FIRST_NAME ', 'last_name', 'E-Mail', 'POST CODE'])

    expect(mapping.firstName).toBe('  FIRST_NAME ')
    expect(mapping.lastName).toBe('last_name')
    expect(mapping.email).toBe('E-Mail')
    expect(mapping.postcode).toBe('POST CODE')
  })

  it('returns every CRM field as an empty string for an unrecognised sheet', () => {
    const mapping = autoMapHeaders(['alpha', 'beta'])

    expect(Object.values(mapping).every((value) => value === '')).toBe(true)
    expect(mapping.email).toBe('')
  })

  it('returns a mapping for an empty header row', () => {
    expect(autoMapHeaders([]).email).toBe('')
  })
})

/**
 * Header row of the CRM's own field names as a spreadsheet exports them: one
 * PascalCase word per column, no separators.
 */
const PASCAL_CASE_HEADERS = [
  'FirstName',
  'LastName',
  'EmailAddress',
  'PreferredName',
  'MobileNumber',
  'WorkPhone',
  'Address',
  'Suburb',
  'State',
  'Postcode',
  'Country',
  'OrganisationName',
  'JobType',
  'Department',
  'Position',
  'IsCustomer',
  'SubscribedToNewsletter',
]

describe('autoMapHeaders - glued headers', () => {
  const mapping = autoMapHeaders(PASCAL_CASE_HEADERS)

  it('maps every PascalCase column, not just the identity three', () => {
    // Only firstname/lastname/emailaddress happened to be spelled out as aliases, so
    // an export with no separators used to arrive with 14 of 17 columns unmapped.
    expect(mapping).toMatchObject({
      firstName: 'FirstName',
      lastName: 'LastName',
      email: 'EmailAddress',
      preferredName: 'PreferredName',
      mobileNumber: 'MobileNumber',
      workPhone: 'WorkPhone',
      address: 'Address',
      suburb: 'Suburb',
      state: 'State',
      postcode: 'Postcode',
      country: 'Country',
      organisationName: 'OrganisationName',
      jobTypeName: 'JobType',
      department: 'Department',
      position: 'Position',
      isCustomer: 'IsCustomer',
      subscribedToNewsletter: 'SubscribedToNewsletter',
    })
  })

  it('never assigns one column to two fields', () => {
    const assigned = Object.values(mapping).filter(Boolean)
    expect(new Set(assigned).size).toBe(assigned.length)
  })

  it('reads run-together and acronym-prefixed headers', () => {
    const mapping = autoMapHeaders(['EMAILADDRESS', 'firstname', 'SURNAME', 'MOBILENUMBER'])

    expect(mapping.email).toBe('EMAILADDRESS')
    expect(mapping.firstName).toBe('firstname')
    expect(mapping.lastName).toBe('SURNAME')
    expect(mapping.mobileNumber).toBe('MOBILENUMBER')
  })

  it('drops punctuation the mapping screen labels carry', () => {
    const mapping = autoMapHeaders(['Is Customer?', 'Subscribed to Newsletter?', 'State/Province'])

    expect(mapping.isCustomer).toBe('Is Customer?')
    expect(mapping.subscribedToNewsletter).toBe('Subscribed to Newsletter?')
    expect(mapping.state).toBe('State/Province')
  })

  it('keeps a prefixed location column on the person, not the company', () => {
    const mapping = autoMapHeaders([
      'EmailAddress',
      'PostalAddress',
      'PostalSuburb',
      'PostalState',
      'PostalPostcode',
      'PostalCountry',
      'CompanyState',
    ])

    expect(mapping.address).toBe('PostalAddress')
    expect(mapping.suburb).toBe('PostalSuburb')
    expect(mapping.state).toBe('PostalState')
    expect(mapping.postcode).toBe('PostalPostcode')
    expect(mapping.country).toBe('PostalCountry')
  })
})

describe('analyseHeaders - Industry and Sector are ambiguous', () => {
  it.each(['Industry', 'Sector', 'INDUSTRY', 'Company Industry', 'Industry Sector'])(
    'does not map %s to Job Type and reports it for a choice',
    (header) => {
      const { mapping, ambiguous } = analyseHeaders(['Email', header])

      expect(mapping.jobTypeName).toBe('')
      expect(Object.values(mapping)).not.toContain(header)
      expect(ambiguous).toEqual([
        expect.objectContaining({ header, candidates: ['jobTypeName'] }),
      ])
      expect(ambiguous[0].reason).toMatch(/organisation/)
    }
  )

  it('still maps an explicit Job Type column next to an Industry one', () => {
    const { mapping, ambiguous } = analyseHeaders(['Email', 'Industry', 'Job Type'])

    expect(mapping.jobTypeName).toBe('Job Type')
    expect(ambiguous.map(({ header }) => header)).toEqual(['Industry'])
  })

  it('keeps trade and category as job type aliases', () => {
    expect(autoMapHeaders(['Trade']).jobTypeName).toBe('Trade')
    expect(autoMapHeaders(['Work Category']).jobTypeName).toBe('Work Category')
  })

  it('does not flag words that merely contain the letters', () => {
    expect(analyseHeaders(['Industrious Rating', 'Dissector']).ambiguous).toEqual([])
  })

  it('reports nothing for a sheet without such columns', () => {
    expect(analyseHeaders(['Email', 'First Name', 'Last Name']).ambiguous).toEqual([])
  })
})

describe('autoMapHeaders - Tags', () => {
  it.each(['Tags', 'tag', 'Labels', 'Etiquetas', 'Contact Tags', 'TagNames'])('maps %s to tags', (header) => {
    expect(autoMapHeaders(['Email', header]).tagNames).toBe(header)
  })

  it('leaves company tags, hashtags and tag ids alone', () => {
    const mapping = autoMapHeaders(['Email', 'Company Tags', 'Hashtags', 'Tag ID'])

    expect(mapping.tagNames).toBe('')
  })
})

function mapped(fields: Partial<ColumnMapping>): ColumnMapping {
  return { ...emptyColumnMapping(), ...fields }
}

describe('describeMissingRequirements', () => {
  it('accepts Email + First Name + Last Name', () => {
    const mapping = mapped({ email: 'E', firstName: 'F', lastName: 'L' })

    expect(describeMissingRequirements(mapping)).toEqual([])
    expect(isMappingComplete(mapping)).toBe(true)
  })

  it('accepts Email + Full Name', () => {
    expect(isMappingComplete(mapped({ email: 'E', fullName: 'N' }))).toBe(true)
  })

  it('names the email when only the email is missing', () => {
    const missing = describeMissingRequirements(mapped({ firstName: 'F', lastName: 'L' }))

    expect(missing).toEqual([
      { fields: ['email'], message: 'Email Address is not mapped. Every import needs it.' },
    ])
  })

  it('says exactly which name column is missing for each option', () => {
    const [missing] = describeMissingRequirements(mapped({ email: 'E', firstName: 'F' }))

    expect(missing.message).toBe(
      "The contact's name is not mapped: map Last Name (for Email + First Name + Last Name), " +
        'or map Full Name (Split) (for Email + Full Name).'
    )
    expect(missing.fields).toEqual(['lastName', 'fullName'])
  })

  it('lists every gap for an empty mapping', () => {
    const missing = describeMissingRequirements(emptyColumnMapping())

    expect(missing).toHaveLength(2)
    expect(missing[1].message).toContain('map First Name and Last Name (for Email + First Name + Last Name)')
    expect(isMappingComplete(emptyColumnMapping())).toBe(false)
  })

  it('treats a whitespace-only selection as unmapped', () => {
    expect(isMappingComplete(mapped({ email: ' ', fullName: 'N' }))).toBe(false)
  })

  it('is driven by the same options the help lists', () => {
    for (const option of IMPORT_REQUIREMENT_OPTIONS) {
      const mapping = mapped(Object.fromEntries(option.fields.map((field) => [field, 'x'])))
      expect(isMappingComplete(mapping)).toBe(true)
    }
  })
})

describe('CRM_FIELDS', () => {
  it('describes every CRM field once, including Tags', () => {
    const keys = CRM_FIELDS.map(({ key }) => key)

    expect(new Set(keys).size).toBe(keys.length)
    expect([...keys].sort()).toEqual(Object.keys(emptyColumnMapping()).sort())
    expect(CRM_FIELDS.find(({ key }) => key === 'tagNames')?.description).toContain('VIP; Workshop 2026')
  })
})
