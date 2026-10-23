// CSV export (RFC 4180): CRLF line endings, quotes doubled, fields quoted when needed, UTF-8 BOM so Excel
// opens non-ASCII text (for example the rupee sign) correctly.
import { EXPORT_COLUMNS } from "./columns.js";

// Spreadsheet applications evaluate cells that start with = + - @ (or a tab / carriage return) as formulas.
// Saved jobs contain text copied from the web, so such cells are prefixed with an apostrophe to force plain text.
export function neutralizeFormula(s) {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

export function csvField(value) {
  const s = neutralizeFormula(value == null ? "" : String(value));
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(jobs, columns = EXPORT_COLUMNS) {
  const lines = [columns.map((c) => csvField(c.header)).join(",")];
  for (const job of jobs || []) lines.push(columns.map((c) => csvField(c.get(job || {}))).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export const csvBlob = (jobs, columns) => new Blob([toCsv(jobs, columns)], { type: "text/csv;charset=utf-8" });
