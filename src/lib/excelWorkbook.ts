import 'server-only';

import * as XLSX from 'xlsx';

import type { RawParsedSpreadsheet } from '@/lib/excelParser';

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
