import * as XLSX from 'xlsx';

export interface RawParsedSpreadsheet {
  headers: string[];
  rows: Record<string, any>[];
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
    isCustomer: boolean;
    subscribedToNewsletter: boolean;
  };
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseExcelBuffer(buffer: Buffer): RawParsedSpreadsheet {
  // Read workbook from buffer
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  
  if (workbook.SheetNames.length === 0) {
    return { headers: [], rows: [] };
  }

  // Get the first worksheet
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];
  
  // Get raw grid as arrays (including header row)
  const sheetData = XLSX.utils.sheet_to_json<any[]>(worksheet, { header: 1, raw: false });
  
  if (sheetData.length === 0) {
    return { headers: [], rows: [] };
  }

  // Extract non-empty headers from row 0
  const headers = (sheetData[0] || [])
    .map((h) => String(h || '').trim())
    .filter(Boolean);

  // Map remaining rows to objects with header keys
  const rows = sheetData.slice(1).map((rowArray) => {
    const rowObj: Record<string, any> = {};
    sheetData[0].forEach((header, index) => {
      if (header) {
        const headerStr = String(header).trim();
        const cellValue = rowArray[index];
        rowObj[headerStr] = cellValue !== undefined && cellValue !== null ? String(cellValue).trim() : '';
      }
    });
    return rowObj;
  });

  return { headers, rows };
}

function parseBoolean(val: any): boolean {
  if (typeof val === 'boolean') return val;
  if (val === undefined || val === null) return false;
  const str = String(val).trim().toLowerCase();
  return str === 'yes' || str === 'true' || str === '1' || str === 'y';
}

export function mapAndValidateRows(
  rows: Record<string, any>[],
  mapping: Record<string, string>
): MappedContactRow[] {
  return rows.map((row, index) => {
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
    
    const isCustomer = parseBoolean(mapping.isCustomer ? row[mapping.isCustomer] : false);
    const subscribedToNewsletter = parseBoolean(
      mapping.subscribedToNewsletter ? row[mapping.subscribedToNewsletter] : false
    );

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
          }
        : undefined,
    };
  });
}
