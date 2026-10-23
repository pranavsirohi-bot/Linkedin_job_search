// XLSX export. Uses write-excel-file's "universal" build: it zips synchronously, so it needs no Web Workers
// (which this extension's content security policy would block).
import writeXlsxFile from "write-excel-file/universal";
import { EXPORT_COLUMNS } from "./columns.js";

// Excel allows at most 32,767 characters per cell.
const CELL_LIMIT = 32000;
const clip = (s) => (s.length > CELL_LIMIT ? `${s.slice(0, CELL_LIMIT)}... [truncated]` : s);

// Cells are written as typed strings, so text such as "=SUM(A1)" is stored as text and never evaluated.
export function buildSheetData(jobs, columns = EXPORT_COLUMNS) {
  const header = columns.map((c) => ({ value: c.header, type: String, fontWeight: "bold", backgroundColor: "#e8eef4" }));
  const rows = (jobs || []).map((job) =>
    columns.map((c) => {
      const v = clip(c.get(job || {}));
      return v === "" ? null : { value: v, type: String, wrap: v.includes("\n") || v.length > 60 };
    })
  );
  return [header, ...rows];
}

export async function xlsxBlob(jobs, columns = EXPORT_COLUMNS) {
  const data = buildSheetData(jobs, columns);
  const options = { sheet: "Saved jobs", columns: columns.map((c) => ({ width: c.width })), stickyRowsCount: 1 };
  return writeXlsxFile(data, options).toBlob();
}
