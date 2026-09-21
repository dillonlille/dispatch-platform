const cell = (value: string | number | null | undefined) =>
  `"${String(value ?? '').replaceAll('"', '""')}"`;

/**
 * Saves rows as a CSV file that spreadsheet applications open as UTF-8. Header names are
 * written as given, so they must not contain a comma or a quote.
 */
export function downloadCsv(
  filename: string,
  header: string[],
  rows: (string | number | null | undefined)[][],
) {
  const lines = [header.join(','), ...rows.map((row) => row.map(cell).join(','))];
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv' }));
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}
