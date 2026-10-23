// Export helpers with no third-party dependencies, so they can be loaded directly by the popup (which is not bundled).
// Read-only: these only fetch and hand over saved jobs; they never delete or edit them.

export const EXPORT_FORMATS = Object.freeze({
  csv: { extension: "csv", mime: "text/csv;charset=utf-8" },
  xlsx: { extension: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
});

const PAGE_SIZE = 200; // the data layer's maximum page size
const MAX_ROWS = 20000; // safety cap for one export

// Fetches every page for the given filters. fetchPage({ ...filters, limit, offset, includeDescription }) must
// resolve to { jobs, total }. Rows are de-duplicated by id in case the list shifts while paging.
export async function fetchAllJobs(fetchPage, filters = {}, { onProgress, maxRows = MAX_ROWS } = {}) {
  const out = [];
  const seen = new Set();
  let offset = 0;
  let total = Infinity;
  while (offset < total && out.length < maxRows) {
    const page = await fetchPage({ ...filters, limit: PAGE_SIZE, offset, includeDescription: true });
    const jobs = (page && page.jobs) || [];
    if (typeof page.total === "number") total = page.total;
    for (const j of jobs) {
      const key = j.id || j.jobId;
      if (!seen.has(key)) { seen.add(key); out.push(j); }
    }
    offset += PAGE_SIZE;
    if (onProgress) onProgress(Math.min(out.length, total), Number.isFinite(total) ? total : out.length);
    if (jobs.length < PAGE_SIZE) break;
  }
  return out.slice(0, maxRows);
}

export function exportFileName(format, { filtered = false, now = new Date() } = {}) {
  const day = now.toISOString().slice(0, 10);
  return `linkedin-saved-jobs-${day}${filtered ? "-filtered" : ""}.${EXPORT_FORMATS[format].extension}`;
}

// Browser download of a Blob via a temporary link.
export function downloadBlob(blob, filename, doc = document) {
  const url = URL.createObjectURL(blob);
  const a = doc.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
