import { autoMapHeaders } from './columnMapping'

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

  it('maps title to position and industry to job type', () => {
    expect(mapping.position).toBe('Title')
    expect(mapping.jobTypeName).toBe('Industry')
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
