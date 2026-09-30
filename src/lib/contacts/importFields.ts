/**
 * What the contact importer can fill, and what it needs, described once.
 *
 * The mapping screen, the "required columns" help and the mapping validation all read
 * from here, so the help cannot promise something the validation then refuses.
 * Per-row content checks (a valid address, a Full Name that splits in two) stay in
 * `excelParser.ts`, which is the only place that sees cell values.
 */
import { MAX_TAGS_PER_CONTACT, TAG_NAME_MAX_LENGTH, TAG_SEPARATOR } from '@/lib/db/types'

import type { CrmFieldKey } from './columnMapping'

export type CrmFieldMeta = {
  key: CrmFieldKey
  label: string
  description: string
  /** Short requirement badge for the mapping screen; absent for optional fields. */
  requirement?: string
}

/** Mapping-screen rows, in display order. */
export const CRM_FIELDS: CrmFieldMeta[] = [
  {
    key: 'fullName',
    label: 'Full Name (Split)',
    description: 'Splits by space into First/Last name',
    requirement: 'Required unless First + Last Name are mapped',
  },
  {
    key: 'firstName',
    label: 'First Name',
    description: 'Contact first name',
    requirement: 'Required with Last Name, unless Full Name is mapped',
  },
  {
    key: 'lastName',
    label: 'Last Name',
    description: 'Contact last name',
    requirement: 'Required with First Name, unless Full Name is mapped',
  },
  { key: 'email', label: 'Email Address', description: 'Primary contact email', requirement: 'Required' },
  { key: 'preferredName', label: 'Preferred Name', description: 'Nickname / Preferred Name' },
  { key: 'mobileNumber', label: 'Mobile Number', description: 'Mobile phone number' },
  { key: 'workPhone', label: 'Work Phone', description: 'Work office phone' },
  { key: 'address', label: 'Address', description: 'Street address' },
  { key: 'suburb', label: 'Suburb', description: 'Suburb' },
  { key: 'state', label: 'State', description: 'State (e.g. NSW)' },
  { key: 'postcode', label: 'Postcode', description: 'Postal code' },
  { key: 'country', label: 'Country', description: 'Country' },
  { key: 'organisationName', label: 'Organisation Name', description: 'Company / Employer name' },
  {
    key: 'jobTypeName',
    label: 'Job Type',
    description: "Trade / work category used for segmentation (not the organisation's industry)",
  },
  { key: 'department', label: 'Department', description: 'Business department' },
  { key: 'position', label: 'Position / Title', description: 'Job position' },
  { key: 'isCustomer', label: 'Is Customer?', description: 'True/False flag' },
  { key: 'subscribedToNewsletter', label: 'Subscribed to Newsletter?', description: 'Sync subscription state' },
  { key: 'subscribedToPrograms', label: 'Subscribed to Courses?', description: 'Course and training consent' },
  {
    key: 'tagNames',
    label: 'Tags',
    description: `Separated by "${TAG_SEPARATOR}", e.g. VIP${TAG_SEPARATOR} Workshop 2026. Added to existing tags.`,
  },
]

/** Label of a field as the mapping screen shows it. */
export function fieldLabel(key: CrmFieldKey): string {
  return CRM_FIELDS.find((field) => field.key === key)?.label ?? key
}

export type ImportRequirementOption = {
  id: 'split-name' | 'full-name'
  /** Fields that must all be mapped for this option to be satisfied. */
  fields: readonly CrmFieldKey[]
  label: string
  note?: string
}

/**
 * The column sets an import accepts: satisfying any one option is enough.
 * Email is in both on purpose — it is how an import matches existing contacts.
 */
export const IMPORT_REQUIREMENT_OPTIONS: readonly ImportRequirementOption[] = [
  {
    id: 'split-name',
    fields: ['email', 'firstName', 'lastName'],
    label: 'Email + First Name + Last Name',
  },
  {
    id: 'full-name',
    fields: ['email', 'fullName'],
    label: 'Email + Full Name',
    note: 'Full Name must hold a first and a last name separated by a space (e.g. "Ada Lovelace"); rows with a single word are rejected.',
  },
]

/** Example value for the Tags column, built from the shared separator. */
export const TAGS_FORMAT_EXAMPLE = `VIP${TAG_SEPARATOR} Workshop 2026`

/** One-sentence description of the Tags column rules, for help text. */
export const TAGS_FORMAT_RULES =
  `Separate tags with "${TAG_SEPARATOR}". Up to ${TAG_NAME_MAX_LENGTH} characters per tag and ` +
  `${MAX_TAGS_PER_CONTACT} tags per contact; rows over a limit are rejected, never cut short. ` +
  'Tags are added to the ones a contact already has — an import never removes tags.'

/** Why blank cells are safe, shared by the help and the preview. */
export const BLANK_CELLS_RULE =
  "Blank cells, and columns you don't map, never erase a contact's existing details."
