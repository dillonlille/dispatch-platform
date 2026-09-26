/**
 * Quote a cell and force values that spreadsheet programs can interpret as formulas to text.
 * Leading whitespace is included because some importers discard it before checking the first
 * meaningful character.
 */
export const csvCell = (value: string | number | null | undefined) => {
  const text = String(value ?? '');
  const safe =
    /^[=+\-@]/.test(text.trimStart()) || /^[\u0000-\u001f\u007f]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
};

export const csvText = (header: string[], rows: (string | number | null | undefined)[][]) =>
  [header.map(csvCell).join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\r\n');

/**
 * Saves rows as a CSV file that spreadsheet applications open as UTF-8.
 */
export function downloadCsv(
  filename: string,
  header: string[],
  rows: (string | number | null | undefined)[][],
) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([`﻿${csvText(header, rows)}`], { type: 'text/csv' }));
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}
