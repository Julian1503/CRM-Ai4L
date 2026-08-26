import * as XLSX from 'xlsx';
import {
  parseExcelBuffer,
  mapAndValidateRows,
  isSupportedSpreadsheetName,
  SUPPORTED_SPREADSHEET_EXTENSIONS,
} from './excelParser';

// Helper function to create a mock excel file buffer
function createExcelBuffer(headers: string[], rows: string[][]): Buffer {
  const wb = XLSX.utils.book_new();
  const wsData = [headers, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

describe('excelParser - parseExcelBuffer', () => {
  it('should parse a valid Excel sheet and return headers and raw rows', () => {
    const headers = ['Full Name', 'Email Address', 'Company', 'Role'];
    const dataRows = [
      ['Emil Kowalski', 'emil@kowalski.design', 'Animations Dev', 'Chief Architect'],
      ['Linus Torvalds', 'linus@linux.org', 'Linux Foundation', 'Fellow'],
    ];
    const buffer = createExcelBuffer(headers, dataRows);
    const result = parseExcelBuffer(buffer);

    expect(result.headers).toEqual(headers);
    expect(result.rows.length).toBe(2);
    expect(result.rows[0]['Full Name']).toBe('Emil Kowalski');
    expect(result.rows[1]['Email Address']).toBe('linus@linux.org');
  });

  it('should handle empty spreadsheets gracefully', () => {
    const buffer = createExcelBuffer([], []);
    const result = parseExcelBuffer(buffer);
    expect(result.headers).toEqual([]);
    expect(result.rows).toEqual([]);
  });
});

describe('excelParser - mapAndValidateRows', () => {
  const mapping = {
    fullName: 'Full Name',
    email: 'Email Address',
    organisationName: 'Company',
    position: 'Role',
    isCustomer: 'Is Active Client',
    subscribedToNewsletter: 'Sync Newsletter',
  };

  it('should successfully map and validate correct rows', () => {
    const rawRows = [
      {
        'Full Name': 'Emil Kowalski',
        'Email Address': 'emil@kowalski.design',
        Company: 'Animations Dev',
        Role: 'Chief Architect',
        'Is Active Client': 'Yes',
        'Sync Newsletter': 'true',
      },
    ];

    const results = mapAndValidateRows(rawRows, mapping);
    expect(results[0].isValid).toBe(true);
    expect(results[0].errors).toBeUndefined();
    expect(results[0].data).toEqual({
      firstName: 'Emil',
      lastName: 'Kowalski',
      email: 'emil@kowalski.design',
      organisationName: 'Animations Dev',
      position: 'Chief Architect',
      isCustomer: true,
      subscribedToNewsletter: true,
    });
  });

  it('should automatically split full name into first and last name', () => {
    const rawRows = [
      { 'Full Name': 'SingleName', 'Email Address': 'test@test.com' },
      { 'Full Name': 'First Last Name', 'Email Address': 'test2@test.com' },
    ];

    const results = mapAndValidateRows(rawRows, mapping);
    // SingleName: missing last name
    expect(results[0].isValid).toBe(false);
    expect(results[0].errors).toContain('Last Name is required when using Full Name split');

    // First Last Name: split correctly
    expect(results[1].isValid).toBe(true);
    expect(results[1].data?.firstName).toBe('First');
    expect(results[1].data?.lastName).toBe('Last Name');
  });

  it('should flag errors for invalid emails or missing required fields', () => {
    const rawRows = [
      { 'Full Name': 'John Doe', 'Email Address': 'bad-email' }, // Bad email
      { 'Full Name': '', 'Email Address': 'test@test.com' },     // Missing Name
      { 'Full Name': 'Jane Doe', 'Email Address': '' },          // Missing Email
    ];

    const results = mapAndValidateRows(rawRows, mapping);

    expect(results[0].isValid).toBe(false);
    expect(results[0].errors).toContain('Invalid Email address format');

    expect(results[1].isValid).toBe(false);
    expect(results[1].errors).toContain('First Name and Last Name (or Full Name) are required');

    expect(results[2].isValid).toBe(false);
    expect(results[2].errors).toContain('Email address is required');
  });

  it('should handle explicit firstName and lastName mapping', () => {
    const customMapping = {
      firstName: 'First Name',
      lastName: 'Last Name',
      email: 'Email',
    };
    const rawRows = [
      { 'First Name': 'Ada', 'Last Name': 'Lovelace', Email: 'ada@lovelace.dev' },
    ];

    const results = mapAndValidateRows(rawRows, customMapping);
    expect(results[0].isValid).toBe(true);
    expect(results[0].data?.firstName).toBe('Ada');
    expect(results[0].data?.lastName).toBe('Lovelace');
  });
});


describe('excelParser - non-Excel workbook containers', () => {
  it('parses a CSV upload through the same entry point', () => {
    const csv = 'First Name,Email\nAda,ada@example.com\n';
    const result = parseExcelBuffer(Buffer.from(csv, 'utf8'));

    expect(result.headers).toEqual(['First Name', 'Email']);
    expect(result.rows[0]).toEqual({ 'First Name': 'Ada', Email: 'ada@example.com' });
  });

  it('does not leak a UTF-8 BOM into the first header', () => {
    // Excel on Windows writes the BOM; left in place it becomes part of the header key
    // and every mapping lookup against that column silently misses.
    const csv = 'First Name,Email\nJosé,jose@example.com\n';
    const buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csv, 'utf8')]);
    const result = parseExcelBuffer(buffer);

    expect(result.headers[0]).toBe('First Name');
    expect(result.rows[0]['First Name']).toBe('José');
  });

  it('strips the leading apostrophe spreadsheets use to force a number to text', () => {
    // Apollo exports phone numbers as '+61 2 8263 4000 so Excel keeps the leading plus.
    const csv = 'First Name,Phone\nAda,"\'+61 2 8263 4000"\n';
    const result = parseExcelBuffer(Buffer.from(csv, 'utf8'));

    expect(result.rows[0].Phone).toBe('+61 2 8263 4000');
  });

  it('keeps an apostrophe that is part of the value', () => {
    const csv = 'First Name,Company\nAda,"\'Round Midnight"\n';
    const result = parseExcelBuffer(Buffer.from(csv, 'utf8'));

    expect(result.rows[0].Company).toBe("'Round Midnight");
  });
});

describe('excelParser - isSupportedSpreadsheetName', () => {
  it.each(['contacts.xlsx', 'contacts.XLS', 'contacts.csv', 'apollo export.numbers'])(
    'accepts %s',
    (name) => {
      expect(isSupportedSpreadsheetName(name)).toBe(true);
    }
  );

  it.each(['contacts.pdf', 'contacts.docx', 'contacts.numbers.exe', 'contacts', ''])(
    'rejects %s',
    (name) => {
      expect(isSupportedSpreadsheetName(name)).toBe(false);
    }
  );

  it('lists the Apple Numbers extension among the supported formats', () => {
    expect(SUPPORTED_SPREADSHEET_EXTENSIONS).toContain('.numbers');
  });
});
