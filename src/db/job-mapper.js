// Maps between the extraction record (camelCase, from src/extract) and saved_jobs rows (snake_case).
// Pure functions; no network. Extraction code is not imported: this module only relies on the record shape.

export const WORKPLACE_TYPES = ["Remote", "Hybrid", "On-site"];
export const EMPLOYMENT_TYPES = ["Full-time", "Part-time", "Contract", "Temporary", "Internship", "Volunteer", "Apprenticeship"];

export const APPLICATION_STATUSES = ["open", "closed"]; // NULL in the database = unknown / never observed
export const SENIORITY_LEVELS = ["Internship", "Entry level", "Associate", "Mid-Senior level", "Director", "Executive"];
export const SALARY_PERIODS = ["hour", "day", "week", "month", "year"];
export const APPLICATION_METHODS = ["easy_apply", "external"];
export const EXTRACTION_STATUSES = ["complete", "partial"];
const CURRENCY_RE = /^[A-Z]{3}$/;

const JOB_ID_RE = /^\d{5,20}$/;
const JOB_URL_RE = /^https:\/\/www\.linkedin\.com\/jobs\/view\/\d+\/$/;
const COMPANY_URL_RE = /^https:\/\/www\.linkedin\.com\/company\/[^/]+\/$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const PROVIDER_RE = /^[a-z][a-z0-9_-]{1,30}$/;
export const EXTERNAL_ID_RE = /^[A-Za-z0-9._:/-]{1,200}$/;

// A well-formed https URL for non-LinkedIn providers: no credentials, no whitespace/quotes/angle brackets, <= 2048
// chars. Mirrors the database CHECK constraint so a bad URL is rejected here instead of failing a whole batch.
export function safeHttpsUrl(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\s"<>]/.test(value)) return null;
  let u;
  try { u = new URL(value); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || !/^[A-Za-z0-9.-]+$/.test(u.hostname)) return null;
  return u.href === value || u.href === `${value}/` ? value : u.href.length <= 2048 ? u.href : null;
}

// Lists returned by the database use these columns (search_tsv is deliberately excluded).
// LEGACY = the columns of the applied migrations 000100, 000200 and 20261022000100 (verified against the live project).
const LEGACY_COLUMNS = [
  // provider / external_id are deliberately NOT selected: they only exist after the optional multi-provider migration
  // (20261023000100), which is not applied. Selecting them would make every list query fail. fromRow() defaults
  // provider to "linkedin".
  "id", "linkedin_job_id", "job_url", "job_title", "company_name", "company_url", "location", "posted_text",
  "posted_date_approx", "applicants_text", "workplace_type", "employment_type", "skills", "responsibilities",
  "qualifications", "other_pills", "experience_required", "salary", "source", "has_full_detail", "scraped_at",
  "application_status", "application_status_text", "application_status_at", "created_at", "updated_at",
];
// Added by migration 20261022000200_job_detail_fields.sql. Until it is applied, reads fall back to LEGACY_COLUMNS
// (see saved-jobs.js) and the upsert RPC simply ignores these keys, so nothing fails.
export const DETAIL_COLUMNS = Object.freeze([
  "country", "seniority_level", "salary_currency", "salary_period", "application_method", "hiring_insight",
  "preferred_qualifications", "education_requirements", "certifications", "extraction_status", "extraction_warnings",
  "application_url", "benefits", "industry", "company_size",
]);
export const LIST_COLUMNS = [...LEGACY_COLUMNS, ...DETAIL_COLUMNS].join(",");
export const FULL_COLUMNS = [...LEGACY_COLUMNS, ...DETAIL_COLUMNS, "description"].join(",");
export const LEGACY_LIST_COLUMNS = LEGACY_COLUMNS.join(",");
export const LEGACY_FULL_COLUMNS = [...LEGACY_COLUMNS, "description"].join(",");

export function text(v, max = 500) {
  if (v == null) return null;
  const s = String(v).replace(/[ ​]/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

function list(v, { lower = false, max = 100, itemMax = 500 } = {}) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const item of v) {
    let s = text(item, itemMax);
    if (!s) continue;
    if (lower) s = s.toLowerCase();
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

const oneOf = (v, allowed) => (allowed.includes(v) ? v : null);

function isoDate(v) {
  if (typeof v !== "string" || !DATE_RE.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(+d) || d.toISOString().slice(0, 10) !== v ? null : v;
}

function isoTimestamp(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(+d) ? null : d.toISOString();
}

// Extraction record -> { ok: true, row } | { ok: false, jobId, reason }.
// Unknown enum values become null (so one odd pill cannot make the database reject a whole batch).
export function toRow(job) {
  // Identity: records without a provider are LinkedIn records (the extraction record uses `jobId`).
  const provider = job && job.provider != null ? String(job.provider).trim() : "linkedin";
  const rawId = job ? (job.externalId != null ? job.externalId : job.jobId) : "";
  const jobId = typeof rawId === "string" ? rawId.trim() : "";
  if (!PROVIDER_RE.test(provider)) return { ok: false, jobId: jobId || null, reason: "invalid-provider" };
  const isLinkedIn = provider === "linkedin";
  if (!(isLinkedIn ? JOB_ID_RE : EXTERNAL_ID_RE).test(jobId)) return { ok: false, jobId: jobId || null, reason: "missing-or-invalid-job-id" };

  let jobUrl;
  let companyUrl;
  if (isLinkedIn) {
    jobUrl = JOB_URL_RE.test(job.url || "") ? job.url : `https://www.linkedin.com/jobs/view/${jobId}/`;
    companyUrl = COMPANY_URL_RE.test(job.companyUrl || "") ? job.companyUrl : null;
  } else {
    jobUrl = safeHttpsUrl(job.url);
    if (!jobUrl) return { ok: false, jobId, reason: "invalid-url" };
    companyUrl = safeHttpsUrl(job.companyUrl);
  }

  const description = text(job.description, 100000);
  const applicationStatus = oneOf(job.applicationStatus, APPLICATION_STATUSES);
  const isCard = job.source === "card";
  const currency = text(job.salaryCurrency, 3);
  const row = {
    provider,
    external_id: jobId,
    linkedin_job_id: isLinkedIn ? jobId : null,
    job_url: jobUrl,
    job_title: text(job.title),
    company_name: text(job.company),
    company_url: companyUrl,
    location: text(job.location),
    posted_text: text(job.postedText),
    posted_date_approx: isoDate(job.postedDateApprox),
    applicants_text: text(job.applicantsText),
    workplace_type: oneOf(job.workplaceType, WORKPLACE_TYPES),
    employment_type: oneOf(job.employmentType, EMPLOYMENT_TYPES),
    application_status: applicationStatus,
    application_status_text: applicationStatus ? text(job.applicationStatusText, 500) : null,
    description,
    skills: list(job.skills, { lower: true }),
    responsibilities: list(job.responsibilities),
    qualifications: list(job.qualifications),
    other_pills: list(job.otherPills, { max: 50 }),
    experience_required: text(job.experience),
    salary: text(job.salary),
    source: isCard ? "card" : "detail",
    has_full_detail: !isCard && !!description,
    scraped_at: isoTimestamp(job.collectedAt),
    // migration 20261022000200 (ignored by the database until it is applied)
    country: text(job.country, 100),
    seniority_level: oneOf(job.seniorityLevel, SENIORITY_LEVELS),
    salary_currency: currency && CURRENCY_RE.test(currency) ? currency : null,
    salary_period: oneOf(job.salaryPeriod, SALARY_PERIODS),
    application_method: oneOf(job.applicationMethod, APPLICATION_METHODS),
    hiring_insight: text(job.hiringInsight, 500),
    preferred_qualifications: list(job.preferredQualifications),
    education_requirements: list(job.education, { max: 20, itemMax: 300 }),
    certifications: list(job.certifications, { max: 20, itemMax: 300 }),
    // A card can never be complete, whatever the record claims.
    extraction_status: isCard ? "partial" : oneOf(job.extractionStatus, EXTRACTION_STATUSES),
    extraction_warnings: list(job.extractionWarnings, { max: 50, itemMax: 100 }),
    // Employer application page; never a LinkedIn URL (the job URL already covers that).
    application_url: (() => { const u = safeHttpsUrl(job.applicationUrl); return u && !/^https:\/\/([^/]+\.)?linkedin\.com\//.test(u) ? u : null; })(),
    benefits: list(job.benefits, { max: 30, itemMax: 200 }),
    industry: text(job.industry, 200),
    company_size: text(job.companySize, 100),
  };
  if (!row.job_title && !row.company_name && !row.description) {
    return { ok: false, jobId, reason: "no-usable-fields" };
  }
  if (!row.scraped_at) delete row.scraped_at; // server default (now())
  return { ok: true, row };
}

const isEmpty = (v) => v == null || v === "" || (Array.isArray(v) && v.length === 0);

// Combine two rows for the same job (e.g. a card and the detail panel). Non-empty values from `b` win;
// empty ones never overwrite. The same rule is applied again server-side against the stored row.
export function mergeRows(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) if (!isEmpty(v)) out[k] = v;
  out.source = a.source === "detail" || b.source === "detail" ? "detail" : "card";
  out.has_full_detail = !!(a.has_full_detail || b.has_full_detail);
  // Same rules as the database: "complete" is sticky; warnings come from the detail read, never from a card.
  const detail = b.source === "detail" ? b : a.source === "detail" ? a : b;
  if (a.extraction_status === "complete" || b.extraction_status === "complete") {
    out.extraction_status = "complete";
    out.extraction_warnings = [];
  } else {
    out.extraction_status = detail.extraction_status ?? out.extraction_status ?? null;
    out.extraction_warnings = detail.extraction_warnings ?? [];
  }
  return out;
}

// Database row -> camelCase record shaped like the extraction record (plus id/timestamps).
export function fromRow(r) {
  return {
    id: r.id,
    provider: r.provider || "linkedin",
    externalId: r.external_id || r.linkedin_job_id,
    jobId: r.linkedin_job_id || r.external_id, // LinkedIn id for LinkedIn rows, otherwise the provider's id
    url: r.job_url,
    title: r.job_title,
    company: r.company_name,
    companyUrl: r.company_url,
    location: r.location,
    postedText: r.posted_text,
    postedDateApprox: r.posted_date_approx,
    applicantsText: r.applicants_text,
    workplaceType: r.workplace_type,
    employmentType: r.employment_type,
    applicationStatus: r.application_status ?? "",
    applicationStatusText: r.application_status_text ?? "",
    applicationStatusAt: r.application_status_at ?? null,
    description: r.description ?? null,
    skills: r.skills ?? [],
    responsibilities: r.responsibilities ?? [],
    qualifications: r.qualifications ?? [],
    otherPills: r.other_pills ?? [],
    experience: r.experience_required,
    salary: r.salary,
    source: r.source,
    hasFullDetail: r.has_full_detail,
    country: r.country ?? null,
    seniorityLevel: r.seniority_level ?? null,
    salaryCurrency: r.salary_currency ?? null,
    salaryPeriod: r.salary_period ?? null,
    applicationMethod: r.application_method ?? null,
    hiringInsight: r.hiring_insight ?? null,
    preferredQualifications: r.preferred_qualifications ?? [],
    education: r.education_requirements ?? [],
    certifications: r.certifications ?? [],
    // null when the row predates extraction tracking (or the migration is not applied yet)
    extractionStatus: r.extraction_status ?? null,
    extractionWarnings: r.extraction_warnings ?? [],
    applicationUrl: r.application_url ?? null,
    benefits: r.benefits ?? [],
    industry: r.industry ?? null,
    companySize: r.company_size ?? null,
    collectedAt: r.scraped_at, // last time the job was read from LinkedIn ("last checked")
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// Extraction-record property -> saved_jobs column (one source of truth for docs, diagnostics and tests).
export const FIELD_COLUMNS = Object.freeze({
  jobId: "linkedin_job_id", url: "job_url", title: "job_title", company: "company_name", companyUrl: "company_url",
  location: "location", country: "country", postedText: "posted_text", postedDateApprox: "posted_date_approx",
  applicantsText: "applicants_text", workplaceType: "workplace_type", employmentType: "employment_type",
  seniorityLevel: "seniority_level", applicationStatus: "application_status", applicationStatusText: "application_status_text",
  applicationMethod: "application_method", hiringInsight: "hiring_insight", description: "description", salary: "salary",
  salaryCurrency: "salary_currency", salaryPeriod: "salary_period", experience: "experience_required", skills: "skills",
  responsibilities: "responsibilities", qualifications: "qualifications", preferredQualifications: "preferred_qualifications",
  education: "education_requirements", certifications: "certifications", otherPills: "other_pills",
  extractionStatus: "extraction_status", extractionWarnings: "extraction_warnings", collectedAt: "scraped_at",
  applicationUrl: "application_url", benefits: "benefits", industry: "industry", companySize: "company_size",
});

// Does mapping keep every extracted value? (Preview extraction; nothing is saved.)
//   dropped:        extracted but rejected by the mapper (e.g. an unknown enum value)
//   needsMigration: extracted and mapped, but its column only exists after migration 20261022000200
export function mappingReport(job, { detailColumns = true } = {}) {
  const m = toRow(job || {});
  if (!m.ok) return { ok: false, reason: m.reason, mapped: [], dropped: [], needsMigration: [] };
  const mapped = [];
  const dropped = [];
  const needsMigration = [];
  for (const [field, col] of Object.entries(FIELD_COLUMNS)) {
    if (isEmpty(job[field])) continue;
    if (isEmpty(m.row[col])) { if (col !== "scraped_at") dropped.push(field); continue; }
    mapped.push(field);
    if (!detailColumns && DETAIL_COLUMNS.includes(col)) needsMigration.push(field);
  }
  return { ok: true, mapped, dropped, needsMigration };
}

// Escape LIKE/ILIKE wildcards so user input is matched literally.
export const escapeLike = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

export { JOB_ID_RE };
