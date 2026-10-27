// Data-access layer for saved jobs (Supabase PostgreSQL). Every function takes the supabase client as its first
// argument so the module is testable and contains no global state. Authorization is enforced by RLS in the
// database; this layer never sends user_id.
import { DbError, ERR, toDbError } from "./errors.js";
import {
  APPLICATION_STATUSES, EMPLOYMENT_TYPES, EXTERNAL_ID_RE, FULL_COLUMNS, JOB_ID_RE, PROVIDER_RE, LIST_COLUMNS, WORKPLACE_TYPES,
  DETAIL_FULL_COLUMNS, DETAIL_LIST_COLUMNS, LEGACY_FULL_COLUMNS, LEGACY_LIST_COLUMNS, PROVIDER_COLUMNS, escapeLike, fromRow, mergeRows, text, toRow,
} from "./job-mapper.js";

const TABLE = "saved_jobs";
const SAVE_CHUNK = 50; // rows per RPC call (server cap is 200)
const LOOKUP_CHUNK = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const unwrap = ({ data, error, count }) => {
  if (error) throw toDbError(error);
  return { data, count };
};

async function call(promiseFactory) {
  try {
    return unwrap(await promiseFactory());
  } catch (e) {
    throw toDbError(e);
  }
}

// ---------------------------------------------------------------- schema compatibility
// What the database has been migrated to. Reads ask for the newest columns first; if the database answers "column does
// not exist" the client steps down a level and remembers it (for a minute, so a migration applied meanwhile is noticed):
//   "full"   through 20261023000100 (provider + external_id: jobs from other sources can be stored)
//   "detail" through 20261022000200 (extra detail fields)
//   "legacy" the three originally applied migrations (LinkedIn jobs only)
const LEVEL_TTL_MS = 60 * 1000;
const levels = new WeakMap(); // client -> { level, at }
const COLUMNS = {
  full: [LIST_COLUMNS, FULL_COLUMNS],
  detail: [DETAIL_LIST_COLUMNS, DETAIL_FULL_COLUMNS],
  legacy: [LEGACY_LIST_COLUMNS, LEGACY_FULL_COLUMNS],
};
const isMissingColumn = (e) => !!e && (String(e.code) === "42703" || /column [^ ]+ does not exist/i.test(String(e.message || "")));
const missingColumnName = (e) => { const m = String((e && e.message) || "").match(/column (?:\w+\.)?(\w+) does not exist/i); return m ? m[1] : ""; };
// Which level a "column does not exist" answer points to: only the provider columns missing -> "detail"; any other -> "legacy".
const levelAfter = (level, e) => (level === "full" && PROVIDER_COLUMNS.includes(missingColumnName(e)) ? "detail" : "legacy");
function knownLevel(client) {
  const k = levels.get(client);
  if (!k) return null;
  if (k.level !== "full" && Date.now() - k.at > LEVEL_TTL_MS) { levels.delete(client); return null; }
  return k.level;
}
const setLevel = (client, level) => levels.set(client, { level, at: Date.now() });

async function selectRows(client, full, build) {
  let level = knownLevel(client) || "full";
  for (;;) {
    let res;
    try {
      res = await build(COLUMNS[level][full ? 1 : 0]);
    } catch (e) {
      throw toDbError(e);
    }
    if (res && res.error && level !== "legacy" && isMissingColumn(res.error)) {
      level = levelAfter(level, res.error);
      setLevel(client, level);
      continue;
    }
    return unwrap(res);
  }
}

// Probe once (cheap, read-only): which migrations does this database have? Cached per client.
export async function schemaLevel(client) {
  const known = knownLevel(client);
  if (known) return known;
  // extraction_status comes first so a missing detail column is reported before a missing provider column.
  const level = await call(() => client.from(TABLE).select(`extraction_status,${PROVIDER_COLUMNS.join(",")}`).range(0, 0)).then(
    () => "full",
    (e) => (isMissingColumn(e.cause || e) ? levelAfter("full", e.cause || e) : Promise.reject(e)),
  );
  setLevel(client, level);
  return level;
}
// true when the database can store the extra detail fields (migration 20261022000200 applied).
export const detailColumnsAvailable = async (client) => (await schemaLevel(client)) !== "legacy";
// true when jobs from other sources (imports, APIs) can be stored (migration 20261023000100 applied).
export const providerColumnsAvailable = async (client) => (await schemaLevel(client)) === "full";

function assertUuid(id) {
  if (typeof id !== "string" || !UUID_RE.test(id)) throw new DbError(ERR.VALIDATION, "Invalid job id.");
}

// ---------------------------------------------------------------- save
// Save one or many extraction records. Safe to repeat: existing rows are merged, never blanked.
// Returns { total, inserted, duplicates, rejected: [{ jobId, reason }] }. Invalid records are skipped, not fatal.
export async function saveJobs(client, jobs) {
  const merged = new Map();
  const rejected = [];
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const m = toRow(job);
    if (!m.ok) { rejected.push({ jobId: m.jobId, reason: m.reason }); continue; }
    const key = `${m.row.provider}:${m.row.external_id}`; // identity is (provider, external id), as in the database
    merged.set(key, merged.has(key) ? mergeRows(merged.get(key), m.row) : m.row);
  }
  const rows = [...merged.values()];
  const result = { total: rows.length, inserted: 0, duplicates: 0, rejected };

  for (let i = 0; i < rows.length; i += SAVE_CHUNK) {
    try {
      const { data } = await call(() => client.rpc("upsert_saved_jobs", { p_jobs: rows.slice(i, i + SAVE_CHUNK) }));
      result.inserted += Number(data?.inserted) || 0;
      result.duplicates += Number(data?.duplicates) || 0;
    } catch (e) {
      // Earlier chunks are already committed; tell the caller exactly how far we got.
      throw new DbError(e.code || ERR.UNKNOWN, e.message, { partial: { inserted: result.inserted, duplicates: result.duplicates }, cause: e });
    }
  }
  return result;
}

export const saveJob = (client, job) => saveJobs(client, [job]);

// ---------------------------------------------------------------- duplicates
// Which of these LinkedIn job IDs does the signed-in user already have? Returns an array of IDs.
export async function findDuplicates(client, linkedinJobIds) {
  const ids = [...new Set((linkedinJobIds || []).map(String).filter((id) => JOB_ID_RE.test(id)))];
  const found = [];
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
    const { data } = await call(() => client.from(TABLE).select("linkedin_job_id").in("linkedin_job_id", ids.slice(i, i + LOOKUP_CHUNK)));
    for (const r of data || []) found.push(r.linkedin_job_id);
  }
  return found;
}

// For "Next to save": which of these LinkedIn job IDs are saved, and with full details? -> { id: "full" | "card" }.
// Uses columns of the applied schema only (works before and after the detail-fields migration).
export async function savedDetailStatus(client, linkedinJobIds) {
  const ids = [...new Set((linkedinJobIds || []).map(String).filter((id) => JOB_ID_RE.test(id)))];
  const out = {};
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
    const { data } = await call(() => client.from(TABLE).select("linkedin_job_id,has_full_detail").in("linkedin_job_id", ids.slice(i, i + LOOKUP_CHUNK)));
    for (const r of data || []) out[r.linkedin_job_id] = r.has_full_detail ? "full" : "card";
  }
  return out;
}

// Same, for any provider: which of these external ids has the signed-in user already saved from `provider`?
export async function findDuplicatesBy(client, provider, externalIds) {
  if (!PROVIDER_RE.test(String(provider))) throw new DbError(ERR.VALIDATION, "Invalid provider.");
  const ids = [...new Set((externalIds || []).map(String).filter((id) => EXTERNAL_ID_RE.test(id)))];
  const found = [];
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
    const { data } = await call(() => client.from(TABLE).select("external_id").eq("provider", provider).in("external_id", ids.slice(i, i + LOOKUP_CHUNK)));
    for (const r of data || []) found.push(r.external_id);
  }
  return found;
}

// ---------------------------------------------------------------- read
export async function getJob(client, id) {
  assertUuid(id);
  const { data } = await selectRows(client, true, (cols) => client.from(TABLE).select(cols).eq("id", id).maybeSingle());
  return data ? fromRow(data) : null;
}

export async function getJobByLinkedInId(client, linkedinJobId) {
  if (!JOB_ID_RE.test(String(linkedinJobId))) throw new DbError(ERR.VALIDATION, "Invalid LinkedIn job id.");
  const { data } = await selectRows(client, true, (cols) => client.from(TABLE).select(cols).eq("linkedin_job_id", String(linkedinJobId)).maybeSingle());
  return data ? fromRow(data) : null;
}

export async function countJobs(client) {
  const { count } = await call(() => client.from(TABLE).select("id", { count: "exact", head: true }));
  return count ?? 0;
}

const ORDER = { created_at: "created_at", scraped_at: "scraped_at", title: "job_title", company: "company_name" };

// Search and filter. All filters are optional and ANDed together.
//   query        full-text over title, company and description (websearch syntax: "quoted phrase", -exclude, or)
//   company      case-insensitive substring
//   location     case-insensitive substring
//   workplaceType / employmentType   exact (must be a known value)
//   applicationStatus  "open" | "closed" | "unknown" (unknown = never observed)
//   provider      "linkedin" | "greenhouse" | "file" | ... (exact)
//   skills       job must have ALL listed skills (case-insensitive)
//   detail       "full" (a description was captured) | "card" (list card only)
//   limit/offset pagination (limit capped at 200); orderBy + ascending
// Returns { jobs, total, limit, offset }. Descriptions are omitted unless includeDescription is true.
export async function listJobs(client, opts = {}) {
  const limit = Math.min(Math.max(parseInt(opts.limit ?? 50, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(opts.offset ?? 0, 10) || 0, 0);
  if (opts.workplaceType && !WORKPLACE_TYPES.includes(opts.workplaceType)) throw new DbError(ERR.VALIDATION, "Unknown workplace type.");
  if (opts.employmentType && !EMPLOYMENT_TYPES.includes(opts.employmentType)) throw new DbError(ERR.VALIDATION, "Unknown employment type.");
  if (opts.provider && !PROVIDER_RE.test(String(opts.provider))) throw new DbError(ERR.VALIDATION, "Invalid provider.");
  if (opts.applicationStatus && ![...APPLICATION_STATUSES, "unknown"].includes(opts.applicationStatus)) throw new DbError(ERR.VALIDATION, "Unknown application status.");
  if (opts.detail && !["full", "card"].includes(opts.detail)) throw new DbError(ERR.VALIDATION, "Unknown details filter.");

  const { data, count } = await selectRows(client, !!opts.includeDescription, (cols) => {
    let q = client.from(TABLE).select(cols, { count: "exact" });
    const query = text(opts.query, 200);
    if (query) q = q.textSearch("search_tsv", query, { type: "websearch", config: "english" });
    const company = text(opts.company, 200);
    if (company) q = q.ilike("company_name", `%${escapeLike(company)}%`);
    const location = text(opts.location, 200);
    if (location) q = q.ilike("location", `%${escapeLike(location)}%`);
    if (opts.provider) q = q.eq("provider", opts.provider);
    if (opts.workplaceType) q = q.eq("workplace_type", opts.workplaceType);
    if (opts.employmentType) q = q.eq("employment_type", opts.employmentType);
    if (opts.applicationStatus === "unknown") q = q.is("application_status", null);
    else if (opts.applicationStatus) q = q.eq("application_status", opts.applicationStatus);
    if (opts.detail) q = q.eq("has_full_detail", opts.detail === "full");
    const skills = (Array.isArray(opts.skills) ? opts.skills : []).map((s) => text(s, 60)?.toLowerCase()).filter(Boolean);
    if (skills.length) q = q.contains("skills", skills);
    q = q.order(ORDER[opts.orderBy] || "created_at", { ascending: !!opts.ascending });
    return q.range(offset, offset + limit - 1);
  });
  return { jobs: (data || []).map(fromRow), total: count ?? (data || []).length, limit, offset };
}

// ---------------------------------------------------------------- update / delete
// Fields a user may edit by hand. Identity columns (id, user_id, linkedin_job_id, created_at) are not editable;
// the database also enforces this with column-level grants.
const EDITABLE = {
  title: "job_title", company: "company_name", location: "location", postedText: "posted_text",
  applicantsText: "applicants_text", description: "description", experience: "experience_required", salary: "salary",
};

// patch: a subset of the fields above plus workplaceType, employmentType, skills, responsibilities, qualifications,
// postedDateApprox. Unlike saveJobs, an explicit empty value DOES clear a field (the user asked for it).
export async function updateJob(client, id, patch) {
  assertUuid(id);
  if (!patch || typeof patch !== "object") throw new DbError(ERR.VALIDATION, "Nothing to update.");
  const cols = {};
  for (const [key, col] of Object.entries(EDITABLE)) {
    if (key in patch) cols[col] = text(patch[key], key === "description" ? 100000 : 500);
  }
  if ("workplaceType" in patch) {
    if (patch.workplaceType && !WORKPLACE_TYPES.includes(patch.workplaceType)) throw new DbError(ERR.VALIDATION, "Unknown workplace type.");
    cols.workplace_type = patch.workplaceType || null;
  }
  if ("employmentType" in patch) {
    if (patch.employmentType && !EMPLOYMENT_TYPES.includes(patch.employmentType)) throw new DbError(ERR.VALIDATION, "Unknown employment type.");
    cols.employment_type = patch.employmentType || null;
  }
  if ("postedDateApprox" in patch) {
    if (patch.postedDateApprox && !/^\d{4}-\d{2}-\d{2}$/.test(patch.postedDateApprox)) throw new DbError(ERR.VALIDATION, "Date must be YYYY-MM-DD.");
    cols.posted_date_approx = patch.postedDateApprox || null;
  }
  for (const [key, col, lower] of [["skills", "skills", true], ["responsibilities", "responsibilities", false], ["qualifications", "qualifications", false]]) {
    if (key in patch) {
      const arr = Array.isArray(patch[key]) ? patch[key] : [];
      cols[col] = [...new Set(arr.map((s) => text(s, 500)).filter(Boolean).map((s) => (lower ? s.toLowerCase() : s)))].slice(0, 100);
    }
  }
  if ("description" in cols) cols.has_full_detail = !!cols.description;
  if (Object.keys(cols).length === 0) throw new DbError(ERR.VALIDATION, "No editable fields supplied.");

  const { data } = await selectRows(client, true, (sel) => client.from(TABLE).update(cols).eq("id", id).select(sel).maybeSingle());
  if (!data) throw new DbError(ERR.NOT_FOUND, "Job not found.");
  return fromRow(data);
}

export async function deleteJob(client, id) {
  assertUuid(id);
  const { data } = await call(() => client.from(TABLE).delete().eq("id", id).select("id"));
  if (!data || data.length === 0) throw new DbError(ERR.NOT_FOUND, "Job not found.");
  return { deleted: data.length };
}
