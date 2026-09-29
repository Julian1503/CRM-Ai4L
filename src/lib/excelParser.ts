import * as XLSX from 'xlsx';

export interface RawParsedSpreadsheet {
  headers: string[];
  rows: Record<string, string>[];
}

export interface MappedContactRow {
  isValid: boolean;
  errors?: string[];
  data?: {
    firstName: string;
    lastName: string;
    preferredName?: string;
    email: string;
    mobileNumber?: string;
    workPhone?: string;
    address?: string;
    suburb?: string;
    state?: string;
    postcode?: string;
    country?: string;
    organisationName?: string;
    jobTypeName?: string;
    department?: string;
    position?: string;
    /**
     * Undefined when the column is unmapped or the cell is blank: the spreadsheet said
     * nothing, so an existing contact's status is kept (audit H9).
     */
    isCustomer?: boolean;
    /**
     * Undefined when the spreadsheet has no column for this consent — which is not the
     * same as `false`, and the import RPC reads the difference. Absent says nothing
     * about consent and leaves an existing contact's alone; `false` withdraws it.
     * Collapsing the two is how a re-import used to re-subscribe people who had
     * unsubscribed since the last one.
     */
    subscribedToNewsletter?: boolean;
    subscribedToPrograms?: boolean;
  };
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Upload formats the parser accepts.
 *
 * SheetJS reads all of these from the same buffer and tells them apart by their magic
 * bytes, so nothing downstream has to branch on the extension: `.numbers` is an Apple
 * iWork package, `.xls`/`.xlsx` are Excel workbooks and `.csv`/`.tsv` are plain text.
 * The list exists so an unsupported upload is refused with a useful message instead of
 * whatever SheetJS happens to throw when it fails to recognise the container.
 */
export const SUPPORTED_SPREADSHEET_EXTENSIONS = [
  '.xlsx',
  '.xlsm',
  '.xls',
  '.csv',
  '.tsv',
  '.numbers',
] as const;

/** True when the uploaded filename carries an extension the parser can read. */
export function isSupportedSpreadsheetName(fileName: string): boolean {
  const lower = fileName.trim().toLowerCase();

  return SUPPORTED_SPREADSHEET_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * Cleans a single cell or header.
 *
 * Two artefacts of how spreadsheets round-trip text have to go, or they end up in the
 * database:
 *  - a UTF-8 BOM, which Excel writes at the start of a CSV and which would otherwise
 *    become part of the first header's key, so every mapping lookup against that column
 *    silently misses; and
 *  - the leading apostrophe a spreadsheet uses to force a value to text. Apollo writes
 *    phone numbers as `'+61 2 8263 4000` to stop Excel eating the plus sign. It is only
 *    stripped ahead of a digit or a plus, so a name like `'Round Midnight` survives.
 */
function cleanCell(value: string): string {
  const withoutBom = value.replace(/^﻿/, '');
  const unescaped = withoutBom.replace(/^'(?=[+\d])/, '');

  return unescaped.trim();
}

export function parseExcelBuffer(buffer: Buffer): RawParsedSpreadsheet {
  // Read workbook from buffer. Excel, CSV and Apple Numbers all land here; SheetJS
  // sniffs the container itself.
  const workbook = XLSX.read(buffer, { type: 'buffer' });

  if (workbook.SheetNames.length === 0) {
    return { headers: [], rows: [] };
  }

  // Get the first worksheet
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];

  // Get raw grid as arrays (including header row)
  const sheetData = XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, raw: false });

  if (sheetData.length === 0) {
    return { headers: [], rows: [] };
  }

  // Header row, cleaned once and reused as the key for every data row.
  const headerCells = (sheetData[0] || []).map((cell) =>
    cell === undefined || cell === null ? '' : cleanCell(String(cell))
  );
  const headers = headerCells.filter(Boolean);

  // Map remaining rows to objects with header keys
  const rows = sheetData.slice(1).map((rowArray) => {
    const rowObj: Record<string, string> = {};
    headerCells.forEach((header, index) => {
      if (header) {
        const cellValue = rowArray[index];
        rowObj[header] =
          cellValue !== undefined && cellValue !== null ? cleanCell(String(cellValue)) : '';
      }
    });
    return rowObj;
  });

  return { headers, rows };
}

const TRUE_VALUES = new Set(['yes', 'true', '1', 'y']);
const FALSE_VALUES = new Set(['no', 'false', '0', 'n']);

/**
 * A yes/no cell, keeping three answers apart (audit H9):
 *   blank            undefined — the spreadsheet says nothing; existing data is kept
 *   yes/true/1/y     true
 *   no/false/0/n     false — an explicit change
 * Anything else is `invalid`, so a typo cannot silently read as "no".
 */
export function parseYesNo(val: unknown): { value?: boolean; invalid?: true } {
  if (typeof val === 'boolean') return { value: val };
  if (val === undefined || val === null) return {};
  const str = String(val).trim().toLowerCase();
  if (str === '') return {};
  if (TRUE_VALUES.has(str)) return { value: true };
  if (FALSE_VALUES.has(str)) return { value: false };
  return { invalid: true };
}

export function mapAndValidateRows(
  rows: Record<string, string>[],
  mapping: Record<string, string>
): MappedContactRow[] {
  return rows.map((row) => {
    const errors: string[] = [];
    
    // Extract mapped keys
    const getValue = (key: string): string => {
      const headerName = mapping[key];
      if (!headerName) return '';
      return String(row[headerName] || '').trim();
    };

    let firstName = getValue('firstName');
    let lastName = getValue('lastName');
    const fullName = getValue('fullName');

    // Handle name split if fullName is mapped
    if (mapping.fullName) {
      if (fullName) {
        const parts = fullName.split(/\s+/);
        if (parts.length >= 2) {
          firstName = parts[0];
          lastName = parts.slice(1).join(' ');
        } else {
          firstName = parts[0];
          errors.push('Last Name is required when using Full Name split');
        }
      }
    }

    const email = getValue('email');
    const preferredName = getValue('preferredName') || undefined;
    const mobileNumber = getValue('mobileNumber') || undefined;
    const workPhone = getValue('workPhone') || undefined;
    const address = getValue('address') || undefined;
    const suburb = getValue('suburb') || undefined;
    const state = getValue('state') || undefined;
    const postcode = getValue('postcode') || undefined;
    const country = getValue('country') || undefined;
    const organisationName = getValue('organisationName') || undefined;
    const jobTypeName = getValue('jobTypeName') || undefined;
    const department = getValue('department') || undefined;
    const position = getValue('position') || undefined;
    
    // Unmapped and blank both mean "no information": never a demotion or a withdrawal.
    const yesNo = (key: string, label: string): boolean | undefined => {
      if (!mapping[key]) return undefined;
      const parsed = parseYesNo(row[mapping[key]]);
      if (parsed.invalid) errors.push(`${label} must be yes or no (got "${row[mapping[key]]}")`);
      return parsed.value;
    };
    const isCustomer = yesNo('isCustomer', 'Customer');
    const subscribedToNewsletter = yesNo('subscribedToNewsletter', 'Newsletter');
    const subscribedToPrograms = yesNo('subscribedToPrograms', 'Courses');

    // Validation checks
    if (!firstName || (!lastName && !mapping.fullName)) {
      errors.push('First Name and Last Name (or Full Name) are required');
    }

    if (!email) {
      errors.push('Email address is required');
    } else if (!EMAIL_REGEX.test(email)) {
      errors.push('Invalid Email address format');
    }

    const isValid = errors.length === 0;

    return {
      isValid,
      errors: isValid ? undefined : errors,
      data: isValid
        ? {
            firstName,
            lastName: lastName || '',
            preferredName,
            email,
            mobileNumber,
            workPhone,
            address,
            suburb,
            state,
            postcode,
            country,
            organisationName,
            jobTypeName,
            department,
            position,
            isCustomer,
            subscribedToNewsletter,
            subscribedToPrograms,
          }
        : undefined,
    };
  });
}
