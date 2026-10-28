/**
 * Row mapping and validation for contact imports. Pure, with no SheetJS: the import
 * screen runs this in the browser, so pulling the workbook reader in here would ship it
 * to every visitor of /imports (audit M6). Reading the file lives in `excelWorkbook.ts`,
 * on the server.
 */
import {
  describeTagError,
  mergeTagNames,
  parseTagList,
  type TagNameError,
} from '@/lib/contacts/tags';
import { MAX_TAGS_PER_CONTACT } from '@/lib/db/types';

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
    /**
     * The row's `Tags` cell merged with the import's common tags, deduplicated
     * case-insensitively. Undefined when neither supplied any: the import only ever adds
     * tags, so "nothing" keeps the contact's existing ones.
     */
    tagNames?: string[];
  };
}

export type MapAndValidateOptions = {
  /**
   * Tags applied to every accepted row on top of its own `Tags` cell. Part of the
   * validation (a merged list over the limit rejects the row), so the preview and the
   * import see exactly the same tags.
   */
  commonTags?: readonly string[];
};

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

/**
 * The row's tags: its own `Tags` cell (when mapped) plus the common tags, validated as
 * the one list that will end up on the contact. Over-limit lists are errors, never cut.
 */
function resolveRowTags(
  cell: string,
  commonTags: readonly string[],
  errors: string[]
): string[] | undefined {
  const own = parseTagList(cell);
  const report = (error: TagNameError) => errors.push(`Tags: ${describeTagError(error)}`);

  own.errors.forEach(report);
  if (own.errors.length > 0) return undefined;
  if (commonTags.length === 0) return own.names.length > 0 ? own.names : undefined;

  const merged = mergeTagNames(own.names, commonTags);
  merged.errors.forEach((error) =>
    error.kind === 'too_many'
      ? errors.push(
          `Tags: ${error.count} tags once the common tags are added; a contact can have at most ${MAX_TAGS_PER_CONTACT}.`
        )
      : report(error)
  );

  return merged.errors.length === 0 && merged.names.length > 0 ? merged.names : undefined;
}

export function mapAndValidateRows(
  rows: Record<string, string>[],
  mapping: Record<string, string>,
  options: MapAndValidateOptions = {}
): MappedContactRow[] {
  const commonTags = options.commonTags ?? [];

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
    let splitFailed = false;

    // Handle name split if fullName is mapped
    if (mapping.fullName) {
      if (fullName) {
        const parts = fullName.split(/\s+/);
        if (parts.length >= 2) {
          firstName = parts[0];
          lastName = parts.slice(1).join(' ');
        } else {
          firstName = parts[0];
          splitFailed = true;
          errors.push('Full Name must contain a first and a last name separated by a space');
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
    const tagNames = resolveRowTags(getValue('tagNames'), commonTags, errors);

    // Validation checks
    // One message per problem: a Full Name that would not split has already said so.
    if (!firstName || (!lastName && !splitFailed)) {
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
            tagNames,
          }
        : undefined,
    };
  });
}
