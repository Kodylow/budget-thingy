export function escapeCsvCell(value: string | number): string {
  const text = String(value);
  const literalText = /^[\s\u0000-\u001f\u007f]*[=+\-@]/u.test(text)
    ? `'${text}`
    : text;
  return `"${literalText.replace(/"/g, '""')}"`;
}

export function buildCsv(rows: ReadonlyArray<ReadonlyArray<string | number>>): string {
  return rows
    .map((row) => row.map(escapeCsvCell).join(','))
    .join('\r\n');
}