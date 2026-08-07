import { CSV_BOM, escapeCsvValue, toCsv } from './csv'

describe('escapeCsvValue', () => {
  describe('RFC 4180 quoting', () => {
    it('leaves a plain value unquoted', () => {
      expect(escapeCsvValue('Ada Lovelace')).toBe('Ada Lovelace')
    })

    it('quotes a value containing a comma', () => {
      expect(escapeCsvValue('Lovelace, Ada')).toBe('"Lovelace, Ada"')
    })

    it('quotes and doubles an embedded double quote', () => {
      expect(escapeCsvValue('Ada "The Enchantress" Lovelace')).toBe(
        '"Ada ""The Enchantress"" Lovelace"'
      )
    })

    it.each([
      ['newline', 'line one\nline two'],
      ['carriage return', 'line one\rline two'],
      ['CRLF', 'line one\r\nline two'],
    ])('quotes a value containing a %s', (_label, value) => {
      expect(escapeCsvValue(value)).toBe(`"${value}"`)
    })

    it('renders null and undefined as an empty field', () => {
      expect(escapeCsvValue(null)).toBe('')
      expect(escapeCsvValue(undefined)).toBe('')
    })

    it('renders booleans and numbers without quoting', () => {
      expect(escapeCsvValue(true)).toBe('true')
      expect(escapeCsvValue(0)).toBe('0')
      expect(escapeCsvValue(42)).toBe('42')
    })
  })

  describe('formula injection', () => {
    // Opening an export in Excel or Sheets executes a leading =, +, - or @ as a
    // formula. A contact named =HYPERLINK(...) becomes remote code the moment the
    // client opens their own export. Prefixing with an apostrophe forces text; Excel
    // does not display the apostrophe.
    it.each([
      ['equals', '=1+1'],
      ['plus', '+1+1'],
      ['minus', '-1+1'],
      ['at', '@SUM(A1)'],
      ['tab', '\tcmd'],
      ['carriage return', '\rcmd'],
    ])('neutralises a leading %s', (_label, value) => {
      expect(escapeCsvValue(value).replace(/^"|"$/g, '')).toMatch(/^'/)
    })

    it('neutralises a real-world DDE payload', () => {
      const payload = '=cmd|\' /C calc\'!A0'
      const result = escapeCsvValue(payload)

      expect(result.startsWith(`"'`) || result.startsWith(`'`)).toBe(true)
      expect(result).not.toMatch(/^=/)
    })

    it('escapes before quoting, so quoting cannot hide the payload', () => {
      // A field that needs both must end up as "'=1,2" — not "=1,2" with the
      // apostrophe outside the quotes, which Excel would still evaluate.
      const result = escapeCsvValue('=1,2')

      expect(result).toBe(`"'=1,2"`)
    })

    it('leaves a value alone when the dangerous character is not leading', () => {
      expect(escapeCsvValue('total=5')).toBe('total=5')
      expect(escapeCsvValue('a+b')).toBe('a+b')
    })

    it('neutralises a leading dangerous character after whitespace', () => {
      // Excel trims leading whitespace before evaluating.
      expect(escapeCsvValue('  =1+1')).toMatch(/'/)
    })

    it('still escapes an Australian phone number, which is acceptable', () => {
      // '+61...' is escaped because it is indistinguishable from a formula. Excel
      // renders it as text without showing the apostrophe, so this is the right
      // trade against executing it.
      expect(escapeCsvValue('+61400000000')).toBe(`'+61400000000`)
    })
  })
})

describe('toCsv', () => {
  const columns = [
    { key: 'first_name', header: 'First Name' },
    { key: 'email', header: 'Email' },
  ]

  it('writes a header row followed by data rows', () => {
    const csv = toCsv([{ first_name: 'Ada', email: 'ada@example.com' }], columns)

    expect(csv).toBe('First Name,Email\r\nAda,ada@example.com')
  })

  it('uses CRLF line endings per RFC 4180', () => {
    const csv = toCsv(
      [
        { first_name: 'Ada', email: 'a@example.com' },
        { first_name: 'Grace', email: 'g@example.com' },
      ],
      columns
    )

    expect(csv.split('\r\n')).toHaveLength(3)
    expect(csv).not.toMatch(/[^\r]\n/)
  })

  it('emits only the header when there are no rows', () => {
    expect(toCsv([], columns)).toBe('First Name,Email')
  })

  it('emits only the columns requested, in order', () => {
    const csv = toCsv([{ email: 'a@example.com', first_name: 'Ada', secret: 'x' }], columns)

    expect(csv).not.toContain('secret')
    expect(csv).toBe('First Name,Email\r\nAda,a@example.com')
  })

  it('renders a missing key as an empty field rather than "undefined"', () => {
    const csv = toCsv([{ first_name: 'Ada' }], columns)

    expect(csv).toBe('First Name,Email\r\nAda,')
  })

  it('escapes headers too', () => {
    const csv = toCsv([], [{ key: 'a', header: 'Name, Full' }])

    expect(csv).toBe('"Name, Full"')
  })

  it('escapes every cell', () => {
    const csv = toCsv([{ first_name: '=cmd', email: 'a,b@example.com' }], columns)

    expect(csv).toContain(`'=cmd`)
    expect(csv).toContain('"a,b@example.com"')
  })

  it('exposes a UTF-8 BOM so Excel renders non-ASCII names correctly', () => {
    // Without the BOM, Excel on Windows reads the file as the system codepage and
    // mangles any name with an accent.
    //
    // Asserted by code point rather than against another literal — comparing two
    // invisible characters passes even when both are wrong.
    expect(CSV_BOM).toHaveLength(1)
    expect(CSV_BOM.codePointAt(0)).toBe(0xfeff)
    expect(Array.from(Buffer.from(CSV_BOM, 'utf8'))).toEqual([0xef, 0xbb, 0xbf])
  })
})
