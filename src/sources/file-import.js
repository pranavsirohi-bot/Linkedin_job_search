// Source A: import jobs from a local CSV or JSON file the user chooses.
//
// Everything in a file is untrusted data. It is validated, converted to plain text (any HTML is stripped, never
// rendered or executed), size-limited, and de-duplicated before it can be saved. Malformed records are reported
// individually and never cost the valid ones.
import { EMPLOYMENT_TYPES, WORKPLACE_TYPES, safeHttpsUrl } from "../db/job-mapper.js";
import { CsvError, parseCsv } from "./csv.js";
import { htmlToText, plainLine } from "./text.js";

export const FILE_LIMITS = Object.freeze({
  maxBytes: 2 * 1024 * 1024, // raw file size
  maxPayloadChars: 3 * 1000 * 1000, // serialized valid records (keeps checkpoints inside chrome.storage.local quota)
  maxDescriptionChars: 20000,
  maxRecordsHard: 500,
});

const ALLOWED_EXT = /\.(csv|json)$/i;

// Header / key aliases (compared case-insensitively with spaces, dashes and underscores removed).
const ALIASES = {
  title: ["title", "jobtitle", "position", "role", "name"],
  company: ["company", "companyname", "employer", "organization", "organisation"],
  location: ["location", "city", "joblocation"],
  url: ["url", "joburl", "link", "joblink", "applyurl", "applicationurl"],
  description: ["description", "jobdescription", "details", "summary"],
  externalId: ["id", "externalid", "jobid", "reference", "ref", "requisitionid"],
  postedDate: ["posteddate", "dateposted", "date", "published", "publisheddate", "posted"],
  salary: ["salary", "compensation", "pay"],
  employmentType: ["employmenttype", "jobtype", "type", "contracttype"],
  workplaceType: ["workplacetype", "workmode", "remote", "worktype"],
  skills: ["skills", "skill", "tags", "keywords"],
  experience: ["experience", "experiencerequired", "seniority", "level"],
  status: ["applicationstatus", "status"],
  companyUrl: ["companyurl", "companywebsite", "website"],
};
const normKey = (k) => String(k).toLowerCase().replace(/[\s_-]+/g, "");
const KEY_TO_FIELD = new Map(Object.entries(ALIASES).flatMap(([field, keys]) => keys.map((k) => [k, field])));

function pick(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const field = KEY_TO_FIELD.get(normKey(k));
    if (field && out[field] === undefined && v != null && typeof v !== "object") out[field] = v;
    else if (field === "skills" && Array.isArray(v) && out.skills === undefined) out.skills = v;
  }
  return out;
}

// Deterministic id from a URL so re-importing the same file never creates duplicates (FNV-1a, 64 bits as two 32).
function hashId(s) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ s.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return `url-${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

const vocab = (value, allowed) => {
  const t = String(value || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  return allowed.find((a) => a.toLowerCase() === t || a.toLowerCase().replace("-", "") === t.replace("-", "")) || "";
};

function normalizeWorkplace(value) {
  const v = vocab(value, WORKPLACE_TYPES);
  if (v) return v;
  const t = String(value || "").toLowerCase();
  if (["true", "yes", "1"].includes(t.trim())) return "Remote"; // a boolean "remote" column
  if (/onsite|on site/.test(t)) return "On-site";
  return "";
}

function toSkills(value) {
  const parts = Array.isArray(value) ? value : String(value || "").split(/[;,|]/);
  return [...new Set(parts.map((s) => plainLine(s, 60).toLowerCase()).filter(Boolean))].slice(0, 100);
}

function toDate(value) {
  const m = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "";
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(+d) && d.toISOString().slice(0, 10) === iso ? iso : "";
}

// One raw object -> { ok: true, record } | { ok: false, reason }. Required: a title and an https URL.
// Also used by the run controller to re-validate records it receives from the UI.
export function sanitizeRecord(raw, now = new Date()) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "not-an-object" };
  // Already-clean records (re-validated by the controller) use canonical names; raw file rows use aliases.
  const f = raw.__canonical ? { ...raw, postedDate: raw.postedDate ?? raw.postedDateApprox, status: raw.status ?? raw.applicationStatus } : pick(raw);
  const title = plainLine(f.title, 500);
  if (!title) return { ok: false, reason: "missing-title" };
  const url = safeHttpsUrl(String(f.url == null ? "" : f.url).trim());
  if (!url) return { ok: false, reason: f.url ? "invalid-url" : "missing-url" };

  let externalId = String(f.externalId == null ? "" : f.externalId).trim();
  externalId = /^[A-Za-z0-9._:/-]{1,200}$/.test(externalId) ? externalId : hashId(url);

  const status = String(f.status || "").trim().toLowerCase();
  const applicationStatus = status === "open" || status === "closed" ? status : "";
  const description = htmlToText(f.description, { maxLength: FILE_LIMITS.maxDescriptionChars });
  const postedDateApprox = toDate(f.postedDate);

  return {
    ok: true,
    record: {
      provider: "file",
      externalId,
      url,
      title,
      company: plainLine(f.company, 500),
      companyUrl: safeHttpsUrl(String(f.companyUrl || "").trim()) || "",
      location: plainLine(f.location, 500),
      postedText: postedDateApprox ? `Posted ${postedDateApprox}` : "",
      postedDateApprox,
      workplaceType: normalizeWorkplace(f.workplaceType),
      employmentType: vocab(f.employmentType, EMPLOYMENT_TYPES),
      applicationStatus,
      applicationStatusText: "",
      description,
      salary: plainLine(f.salary, 200),
      experience: plainLine(f.experience, 200),
      skills: toSkills(f.skills),
      source: "detail",
      collectedAt: now.toISOString(),
      __canonical: true,
    },
  };
}

// Parse a file's text. Returns { ok, format, records, rejected, duplicates, overLimit, total, error? }.
//   rejected: first 200 of [{ row, reason }] (row is 1-based within the data rows); rejectedCount is the full count
export function parseImportFile({ name, size, text }, { maxRecords = 200, now = new Date() } = {}) {
  const fail = (error) => ({ ok: false, error, format: null, records: [], rejected: [], rejectedCount: 0, duplicates: 0, overLimit: 0, total: 0 });
  if (typeof name !== "string" || !ALLOWED_EXT.test(name)) return fail("Only .csv and .json files can be imported.");
  if (typeof text !== "string") return fail("The file could not be read as text.");
  const bytes = Number.isFinite(size) ? size : text.length;
  if (bytes > FILE_LIMITS.maxBytes) return fail(`The file is larger than ${(FILE_LIMITS.maxBytes / 1048576).toFixed(0)} MB.`);
  if (text.trim() === "") return fail("The file is empty.");
  const cap = Math.min(Math.max(Math.floor(maxRecords) || 0, 1), FILE_LIMITS.maxRecordsHard);
  const format = /\.json$/i.test(name) ? "json" : "csv";

  let items;
  try {
    if (format === "json") {
      let data;
      try { data = JSON.parse(text); } catch { return fail("The file is not valid JSON."); }
      items = Array.isArray(data) ? data : data && Array.isArray(data.jobs) ? data.jobs : null;
      if (!items) return fail('JSON must be an array of jobs, or an object with a "jobs" array.');
      if (items.length > 10000) return fail("The file has too many records (limit 10,000).");
    } else {
      const rows = parseCsv(text);
      if (rows.length < 2) return fail("The CSV needs a header row and at least one job.");
      const header = rows[0];
      if (!header.some((h) => KEY_TO_FIELD.has(normKey(h)))) return fail("The CSV header row has no recognised columns (expected title, company, url, ...).");
      items = rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
    }
  } catch (e) {
    if (e instanceof CsvError) return fail(e.message);
    throw e;
  }

  const records = [];
  const rejected = [];
  const seen = new Set();
  let rejectedCount = 0;
  let duplicates = 0;
  let overLimit = 0;
  let payload = 0;
  items.forEach((raw, i) => {
    const res = sanitizeRecord(raw, now);
    if (!res.ok) { rejectedCount++; if (rejected.length < 200) rejected.push({ row: i + 1, reason: res.reason }); return; }
    if (seen.has(res.record.externalId)) { duplicates++; return; }
    if (records.length >= cap) { overLimit++; return; }
    const size = JSON.stringify(res.record).length;
    if (payload + size > FILE_LIMITS.maxPayloadChars) { overLimit++; return; }
    payload += size;
    seen.add(res.record.externalId);
    records.push(res.record);
  });
  return { ok: true, format, records, rejected, rejectedCount, duplicates, overLimit, total: items.length };
}

// Counts from the page's file preview (total rows, invalid rows, ...). Display-only, so they are just sanitised numbers;
// what is actually imported is always decided by re-validating the records themselves.
function cleanStats(stats) {
  if (!stats || typeof stats !== "object") return null;
  const out = {};
  for (const k of ["total", "valid", "invalid", "duplicatesInFile", "overLimit"]) {
    const n = Number(stats[k]);
    out[k] = Number.isInteger(n) && n >= 0 && n <= 1000000 ? n : 0;
  }
  return out;
}

// The adapter used by the run controller. `params.records` must already be sanitized (it is re-checked on start).
export function createFileSource() {
  return {
    id: "file",
    label: "Import CSV / JSON file",
    heavyParams: ["records"], // persisted separately from the small checkpoint
    validateParams(params, { maxJobs = 200 } = {}) {
      const input = Array.isArray(params && params.records) ? params.records : null;
      if (!input) return { ok: false, errors: ["No records to import."] };
      if (input.length === 0) return { ok: false, errors: ["The file has no valid records to import."] };
      if (input.length > FILE_LIMITS.maxRecordsHard) return { ok: false, errors: [`Too many records (limit ${FILE_LIMITS.maxRecordsHard}).`] };
      const records = [];
      const seen = new Set();
      for (const raw of input) {
        const r = sanitizeRecord(raw);
        if (r.ok && !seen.has(r.record.externalId)) { seen.add(r.record.externalId); records.push(r.record); }
      }
      if (!records.length) return { ok: false, errors: ["None of the records are valid."] };
      if (JSON.stringify(records).length > FILE_LIMITS.maxPayloadChars) return { ok: false, errors: ["The records are too large to import in one run."] };
      return { ok: true, params: { records: records.slice(0, Math.max(maxJobs, 1)), fileName: plainLine(params.fileName || "", 120), stats: cleanStats(params.stats) } };
    },
    describeCursor(cursor) {
      return `from record ${cursor.o + 1}`;
    },
    async search(params, cursor, { pageSize }) {
      const offset = cursor && Number.isInteger(cursor.o) && cursor.o >= 0 ? cursor.o : 0;
      const slice = params.records.slice(offset, offset + pageSize);
      const next = offset + pageSize < params.records.length ? { o: offset + pageSize } : null;
      return { refs: slice.map((r, i) => ({ externalId: r.externalId, index: offset + i, title: r.title })), nextCursor: next, total: params.records.length };
    },
    async getDetails(ref, { params }) {
      const record = params.records[ref.index];
      if (!record || record.externalId !== ref.externalId) return null;
      return record;
    },
    normalize(raw) {
      if (!raw) return null;
      const { __canonical, ...rest } = raw; // eslint-disable-line no-unused-vars
      return rest;
    },
  };
}
