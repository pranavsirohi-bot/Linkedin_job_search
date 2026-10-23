// RFC 4180 CSV parser with defensive limits. Handles a UTF-8 BOM, CRLF/LF/CR line endings, quoted fields,
// doubled quotes and embedded newlines. Returns an array of rows (arrays of strings).
export class CsvError extends Error {}

export function parseCsv(text, { maxRows = 10001, maxColumns = 100, maxFieldChars = 200000 } = {}) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let fieldWasQuoted = false;

  const endField = () => {
    if (field.length > maxFieldChars) throw new CsvError("A field is longer than the allowed size.");
    row.push(field);
    if (row.length > maxColumns) throw new CsvError(`Too many columns (limit ${maxColumns}).`);
    field = "";
    fieldWasQuoted = false;
  };
  const endRow = () => {
    endField();
    // Skip completely blank lines (a single empty, unquoted field).
    if (!(row.length === 1 && row[0] === "" && !fieldWasQuoted)) rows.push(row);
    if (rows.length > maxRows) throw new CsvError(`Too many rows (limit ${maxRows - 1}).`);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"' && field === "") {
      inQuotes = true;
      fieldWasQuoted = true;
    } else if (c === ",") endField();
    else if (c === "\r") {
      if (src[i + 1] === "\n") i++;
      endRow();
    } else if (c === "\n") endRow();
    else field += c;
  }
  if (inQuotes) throw new CsvError("The file ends inside a quoted field (unbalanced quotes).");
  if (field !== "" || row.length) endRow();
  return rows;
}
