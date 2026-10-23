// Export orchestration for the saved-jobs page (CSV and Excel). Read-only: it never deletes or edits saved jobs.
// The dependency-free helpers live in download.js (also used by the popup) and are re-exported here.
import { csvBlob } from "./csv.js";
import { EXPORT_FORMATS } from "./download.js";
import { xlsxBlob } from "./xlsx.js";

export { EXPORT_FORMATS, downloadBlob, exportFileName, fetchAllJobs } from "./download.js";

export async function buildExport(jobs, format) {
  if (!EXPORT_FORMATS[format]) throw new Error(`Unsupported export format: ${format}`);
  return format === "csv" ? csvBlob(jobs) : xlsxBlob(jobs);
}
