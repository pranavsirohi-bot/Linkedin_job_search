// Source: the LinkedIn page the user has open, as already read by the content script (job cards loaded in the list +
// the open job's details). The popup takes that snapshot when the user presses Start and hands it to the run
// controller, which saves it in small batches with live progress and Stop support.
//
// This source NEVER touches LinkedIn: it does not fetch, click, scroll, open jobs or change pages. It has exactly one
// "page" (the snapshot); continuing to more results is the user's own navigation followed by another Start.
const JOB_ID_RE = /^\d{5,20}$/;
export const LINKEDIN_PAGE_LIMITS = Object.freeze({ maxRecords: 500, batchSize: 5 });

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const empty = (v) => v == null || v === "" || (Array.isArray(v) && v.length === 0);

// A card and the open job can be the same job; keep one record, letting non-empty detail values win.
function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) if (!empty(v)) out[k] = v;
  if (a.source === "detail" || b.source === "detail") out.source = "detail";
  // Status and warnings describe the detail read; a card's "partial / card-only" never overrides them.
  const d = b.source === "detail" ? b : a.source === "detail" ? a : null;
  if (d) { out.extractionStatus = d.extractionStatus; out.extractionWarnings = d.extractionWarnings || []; }
  return out;
}

export function createLinkedInPageSource() {
  return {
    id: "linkedin-page",
    // Cannot fetch or page anything by itself: it only replays job records already read from the user's screen.
    automatic: false,
    label: "Jobs loaded on the current LinkedIn page",
    heavyParams: ["records"], // stored once, separately from the per-batch checkpoint
    detailBatch: LINKEDIN_PAGE_LIMITS.batchSize, // save in small batches so progress updates promptly

    validateParams(params) {
      const input = params && Array.isArray(params.records) ? params.records : null;
      if (!input || input.length === 0) return { ok: false, errors: ["No jobs were found on this page."] };
      if (input.length > LINKEDIN_PAGE_LIMITS.maxRecords * 2) return { ok: false, errors: ["Too many records in one page snapshot."] };
      const byId = new Map();
      let invalid = 0;
      for (const r of input) {
        if (!isPlainObject(r) || typeof r.jobId !== "string" || !JOB_ID_RE.test(r.jobId)) { invalid++; continue; }
        const { provider, externalId, ...rec } = r; // eslint-disable-line no-unused-vars -- identity is the LinkedIn job id only
        byId.set(r.jobId, byId.has(r.jobId) ? merge(byId.get(r.jobId), rec) : rec);
      }
      const records = [...byId.values()].slice(0, LINKEDIN_PAGE_LIMITS.maxRecords);
      if (!records.length) return { ok: false, errors: ["None of the jobs on this page had a valid LinkedIn job id."] };
      const pageUrl = typeof params.pageUrl === "string" && /^https:\/\/www\.linkedin\.com\//.test(params.pageUrl) ? params.pageUrl.slice(0, 500) : "";
      // stats are display-only (shown as "found on page" / "with full details" in the popup).
      const stats = { found: records.length, withDetails: records.filter((r) => r.source !== "card" && r.description).length, invalid };
      return { ok: true, params: { records, pageUrl, stats } };
    },

    async search(params, cursor, { pageSize }) {
      const offset = cursor && Number.isInteger(cursor.o) && cursor.o >= 0 ? cursor.o : 0;
      const slice = params.records.slice(offset, offset + pageSize);
      const next = offset + pageSize < params.records.length ? { o: offset + pageSize } : null;
      return { refs: slice.map((r, i) => ({ externalId: r.jobId, index: offset + i })), nextCursor: next, total: params.records.length };
    },

    describeCursor(cursor) {
      return `record ${cursor.o + 1} of this page`;
    },

    async getDetails(ref, { params }) {
      const r = params.records[ref.index];
      return r && r.jobId === ref.externalId ? r : null;
    },

    // Already in the extraction record shape the database mapper expects (no provider = LinkedIn).
    normalize(raw) {
      return raw && typeof raw === "object" ? raw : null;
    },
  };
}
