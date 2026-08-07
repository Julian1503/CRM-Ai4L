import * as XLSX from 'xlsx';
import { parseExcelBuffer, mapAndValidateRows } from './excelParser';

// Helper function to create a mock excel file buffer
function createExcelBuffer(headers: string[], rows: any[][]): Buffer {
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
