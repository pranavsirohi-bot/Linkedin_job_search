// Full-field pipeline below the UI: extraction record -> mapper -> data layer (on the current AND the migrated schema)
// -> export columns. Uses the fake supabase client (no network); database behaviour itself is in tests/db/.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DETAIL_COLUMNS, FIELD_COLUMNS, FULL_COLUMNS, LEGACY_FULL_COLUMNS, LEGACY_LIST_COLUMNS, LIST_COLUMNS, fromRow, mappingReport, mergeRows, toRow,
} from "../src/db/job-mapper.js";
import { detailColumnsAvailable, getJob, listJobs, saveJobs, savedDetailStatus } from "../src/db/saved-jobs.js";
import { createHandlers } from "../src/background/handlers.js";
import { EXPORT_COLUMNS, extractionLabel, methodLabel, periodLabel, warningLabel } from "../src/export/columns.js";
import { toCsv } from "../src/export/csv.js";
import { buildSheetData } from "../src/export/xlsx.js";
import { fetchAllJobs } from "../src/export/download.js";
import { fakeClient } from "./db/fake-client.mjs";

const ID = "00000000-0000-4000-8000-000000000001";
const detailJob = (over = {}) => ({
  source: "detail", jobId: "4480218579", url: "https://www.linkedin.com/jobs/view/4480218579/", title: "Junior Graphic Designer",
  company: "YourfriendlyHR", companyUrl: "https://www.linkedin.com/company/yourfriendlyhr/", location: "India", country: "India",
  postedText: "1 day ago", postedDateApprox: "2026-10-20", applicantsText: "Over 100 applicants", workplaceType: "Remote",
  employmentType: "Full-time", seniorityLevel: "Entry level", applicationStatus: "open", applicationStatusText: "",
  applicationMethod: "easy_apply", hiringInsight: "No response insights available yet", otherPills: [],
  description: "Line 1\n- Location: Remote", salary: "Up to ₹35,000/month", salaryCurrency: "INR", salaryPeriod: "month",
  experience: "Fresher to Junior Level", responsibilities: ["Create graphics"], qualifications: ["Adobe Suite"],
  preferredQualifications: ["Premiere Pro"], education: ["Bachelor's degree in Design"], certifications: ["Adobe Certified Professional"],
  skills: ["Graphic Design", "Adobe"], extractionStatus: "complete", extractionWarnings: [], collectedAt: "2026-10-21T12:00:00.000Z", ...over,
});
const cardJob = (over = {}) => ({
  source: "card", jobId: "4480218579", url: "https://www.linkedin.com/jobs/view/4480218579/", title: "Junior Graphic Designer",
  company: "YourfriendlyHR", location: "India", country: "India", workplaceType: "Remote", extractionStatus: "partial", extractionWarnings: ["card-only"], ...over,
});

// ------------------------------------------------------------------ mapper
test("every extraction field has a column, and the mapper keeps every value", () => {
  const m = toRow(detailJob());
  assert.equal(m.ok, true);
  const r = m.row;
  assert.deepEqual(
    [r.country, r.seniority_level, r.salary_currency, r.salary_period, r.application_method, r.hiring_insight, r.extraction_status],
    ["India", "Entry level", "INR", "month", "easy_apply", "No response insights available yet", "complete"],
  );
  assert.deepEqual([r.preferred_qualifications, r.education_requirements, r.certifications, r.skills], [["Premiere Pro"], ["Bachelor's degree in Design"], ["Adobe Certified Professional"], ["graphic design", "adobe"]]);
  const rep = mappingReport(detailJob());
  assert.deepEqual([rep.ok, rep.dropped], [true, []]);
  for (const col of Object.values(FIELD_COLUMNS)) assert.ok(FULL_COLUMNS.split(",").includes(col), `${col} is read back`);
});

test("unknown enum values are dropped (not stored as garbage) and reported by the mapping check", () => {
  const job = detailJob({ seniorityLevel: "Senior", salaryCurrency: "Rupees", salaryPeriod: "fortnight", applicationMethod: "email", extractionStatus: "failed" });
  const r = toRow(job).row;
  assert.deepEqual([r.seniority_level, r.salary_currency, r.salary_period, r.application_method, r.extraction_status], [null, null, null, null, null]);
  assert.deepEqual(mappingReport(job).dropped.sort(), ["applicationMethod", "extractionStatus", "salaryCurrency", "salaryPeriod", "seniorityLevel"]);
  assert.deepEqual(mappingReport(detailJob(), { detailColumns: false }).needsMigration.sort(), [
    "applicationMethod", "certifications", "country", "education", "extractionStatus", "hiringInsight", "preferredQualifications", "salaryCurrency", "salaryPeriod", "seniorityLevel",
  ]);
});

test("a card is always partial, even if a record claims otherwise", () => {
  assert.equal(toRow(cardJob({ extractionStatus: "complete" })).row.extraction_status, "partial");
  assert.equal(toRow(cardJob()).row.has_full_detail, false);
});

test("card + open job in one batch: details win, 'complete' wins, the card's warning is dropped; other ids stay separate", () => {
  const merged = mergeRows(toRow(detailJob()).row, toRow(cardJob({ location: "" })).row);
  assert.deepEqual([merged.source, merged.extraction_status, merged.extraction_warnings, merged.description, merged.location], ["detail", "complete", [], "Line 1\n- Location: Remote", "India"]);
  const reversed = mergeRows(toRow(cardJob()).row, toRow(detailJob({ extractionStatus: "partial", extractionWarnings: ["missing:postedText"] })).row);
  assert.deepEqual([reversed.extraction_status, reversed.extraction_warnings], ["partial", ["missing:postedText"]]);
});

test("saveJobs sends one merged row per job id and never attaches one job's description to another", async () => {
  const sent = [];
  const client = fakeClient({ onRpc: (_n, args) => { sent.push(...args.p_jobs); return { data: { inserted: args.p_jobs.length, duplicates: 0 }, error: null }; } });
  await saveJobs(client, [cardJob(), cardJob({ jobId: "4480000001", url: "https://www.linkedin.com/jobs/view/4480000001/", title: "Other" }), detailJob()]);
  assert.equal(sent.length, 2);
  const a = sent.find((r) => r.linkedin_job_id === "4480218579");
  const b = sent.find((r) => r.linkedin_job_id === "4480000001");
  assert.equal(a.description, "Line 1\n- Location: Remote");
  assert.equal(b.description, null);
  assert.equal(b.extraction_status, "partial");
});

test("fromRow returns every stored field; old rows without the new columns get empty values", () => {
  const full = fromRow({
    id: ID, linkedin_job_id: "4480218579", country: "India", seniority_level: "Entry level", salary_currency: "INR", salary_period: "month",
    application_method: "external", hiring_insight: "x", preferred_qualifications: ["p"], education_requirements: ["e"], certifications: ["c"],
    extraction_status: "partial", extraction_warnings: ["missing:location"], scraped_at: "2026-10-21T12:00:00Z",
  });
  assert.deepEqual(
    [full.country, full.seniorityLevel, full.salaryCurrency, full.salaryPeriod, full.applicationMethod, full.hiringInsight, full.preferredQualifications, full.education, full.certifications, full.extractionStatus, full.extractionWarnings, full.collectedAt],
    ["India", "Entry level", "INR", "month", "external", "x", ["p"], ["e"], ["c"], "partial", ["missing:location"], "2026-10-21T12:00:00Z"],
  );
  const old = fromRow({ id: ID, linkedin_job_id: "4480218579" });
  assert.deepEqual([old.country, old.extractionStatus, old.education, old.extractionWarnings], [null, null, [], []]);
});

// ------------------------------------------------------------------ data layer on both schemas
const missingColumn = { data: null, error: { code: "42703", message: "column saved_jobs.country does not exist" } };

test("current (unmigrated) schema: list and detail reads fall back to the applied columns, once per client", async () => {
  const selects = [];
  const client = fakeClient({
    onQuery: (ops) => {
      const cols = ops.find((o) => o[0] === "select")[1];
      selects.push(cols);
      if (cols.includes("country")) return missingColumn;
      return ops.some((o) => o[0] === "maybeSingle") ? { data: { id: ID, linkedin_job_id: "4480218579", job_title: "T" }, error: null } : { data: [{ id: ID, linkedin_job_id: "4480218579" }], error: null, count: 1 };
    },
  });
  const list = await listJobs(client, {});
  assert.equal(list.total, 1);
  assert.deepEqual(selects, [LIST_COLUMNS, LEGACY_LIST_COLUMNS]);
  await listJobs(client, { includeDescription: true });
  assert.equal(selects.at(-1), LEGACY_FULL_COLUMNS, "remembered: no second failing request");
  assert.equal((await getJob(client, ID)).title, "T");
  assert.equal(selects.filter((s) => s.includes("country")).length, 1);
  assert.equal(await detailColumnsAvailable(client), false);
});

test("migrated schema: the detail columns are read and reported as available", async () => {
  const selects = [];
  const client = fakeClient({ onQuery: (ops) => { selects.push(ops.find((o) => o[0] === "select")[1]); return { data: [], error: null, count: 0 }; } });
  assert.equal(await detailColumnsAvailable(client), true);
  await listJobs(client, { includeDescription: true });
  assert.equal(selects.at(-1), FULL_COLUMNS);
  for (const c of DETAIL_COLUMNS) assert.ok(FULL_COLUMNS.includes(c), c);
});

test("other database errors are not mistaken for a missing column", async () => {
  const client = fakeClient({ onQuery: () => ({ data: null, error: { code: "42501", message: "permission denied for table saved_jobs" } }) });
  await assert.rejects(listJobs(client, {}), (e) => e.code === "PERMISSION");
  await assert.rejects(detailColumnsAvailable(client), (e) => e.code === "PERMISSION");
  const net = fakeClient({ onRpc: () => { throw new TypeError("Failed to fetch"); } });
  await assert.rejects(saveJobs(net, [detailJob()]), (e) => e.code === "NETWORK", "a failed write is an error, never a silent success");
});

test("SCHEMA_STATUS is available to the extension's own pages only", async () => {
  const EXT = "abcdefghijklmnopabcdefghijklmnop";
  const client = fakeClient({ onQuery: () => missingColumn });
  const handle = createHandlers({
    getClient: () => client, checkConfig: () => ({ ok: true }), isTrustedSender: (s) => s && s.url && s.url.startsWith(`chrome-extension://${EXT}/`),
    withSession: (fn) => fn(client),
  });
  assert.deepEqual(await handle({ type: "SCHEMA_STATUS" }, { id: EXT, url: `chrome-extension://${EXT}/src/popup/popup.html` }), { ok: true, detailColumns: false });
  assert.equal((await handle({ type: "SCHEMA_STATUS" }, { id: EXT, url: "https://www.linkedin.com/jobs/" })).error.code, "PERMISSION");
});

// ------------------------------------------------------------------ export mapping
const stored = () => fromRow({
  id: ID, linkedin_job_id: "4480218579", job_url: "https://www.linkedin.com/jobs/view/4480218579/", job_title: "Designer, \"Junior\"",
  company_name: "Acme", location: "Pune, Maharashtra, India", country: "India", workplace_type: "Hybrid", employment_type: "Contract",
  seniority_level: "Associate", salary: "₹6L/yr - ₹9L/yr", salary_currency: "INR", salary_period: "year", application_method: "external",
  application_status: "closed", application_status_text: "No longer accepting applications", hiring_insight: "Responses managed off LinkedIn",
  description: "Über line 1\nline 2, with comma", skills: ["figma", "adobe"], education_requirements: ["B.Des"], certifications: ["Cert A", "Cert B"],
  responsibilities: ["Do A"], qualifications: ["Know B"], preferred_qualifications: ["Nice C"], extraction_status: "partial",
  extraction_warnings: ["missing:postedText", "selector-empty:title"], source: "detail", has_full_detail: true,
  created_at: "2026-10-20T10:00:00Z", scraped_at: "2026-10-21T12:00:00Z", updated_at: "2026-10-21T12:00:01Z",
});

test("export: documented headers, each mapped to the right stored property", () => {
  const get = (k) => EXPORT_COLUMNS.find((c) => c.key === k).get(stored());
  const expect = {
    country: "India", seniorityLevel: "Associate", salaryCurrency: "INR", salaryPeriod: "per year", applicationMethod: "External (company website)",
    hiringInsight: "Responses managed off LinkedIn", education: "B.Des", certifications: "Cert A\nCert B", preferredQualifications: "Nice C",
    qualifications: "Know B", extractionStatus: "Partial", extractionWarnings: "posted date not found; title selector matched but read nothing",
    createdAt: "2026-10-20T10:00:00Z", collectedAt: "2026-10-21T12:00:00Z", updatedAt: "2026-10-21T12:00:01Z", applicationStatus: "Closed",
  };
  for (const [k, v] of Object.entries(expect)) assert.equal(get(k), v, k);
  const headers = EXPORT_COLUMNS.map((c) => c.header);
  for (const h of ["Country", "Seniority level", "Salary currency", "Salary period", "Application method", "Hiring insight", "Education", "Certifications",
    "Required qualifications", "Preferred qualifications", "Extraction status", "Extraction warnings", "First saved", "Last checked", "Last updated"]) {
    assert.ok(headers.includes(h), h);
  }
  assert.equal(new Set(headers).size, headers.length);
});

test("export: empty stays empty; labels never invent values", () => {
  for (const c of EXPORT_COLUMNS) assert.equal(typeof c.get({}), "string");
  assert.deepEqual([methodLabel(null), periodLabel("fortnight"), extractionLabel({}), warningLabel("card-only").startsWith("card only")], ["", "", "", true]);
  assert.equal(extractionLabel({ source: "card", hasFullDetail: false }), "Partial (card only)");
  assert.equal(extractionLabel({ source: "detail", hasFullDetail: true, extractionStatus: null }), "Full details (not graded)", "old rows are not given a grade");
  const blank = EXPORT_COLUMNS.find((c) => c.key === "salaryCurrency").get(fromRow({ id: ID }));
  assert.equal(blank, "");
});

test("CSV and Excel carry the new fields with commas, quotes, newlines and Unicode intact", () => {
  const csv = toCsv([stored()]);
  assert.ok(csv.includes('"Designer, ""Junior"""'));
  assert.ok(csv.includes('"Über line 1\nline 2, with comma"'));
  assert.ok(csv.includes('"Cert A\nCert B"'));
  assert.ok(csv.includes("₹6L/yr - ₹9L/yr"));
  const sheet = buildSheetData([stored()]);
  const keys = EXPORT_COLUMNS.map((c) => c.key);
  assert.equal(sheet[1][keys.indexOf("certifications")].value, "Cert A\nCert B");
  assert.equal(sheet[1][keys.indexOf("country")].value, "India");
  assert.equal(sheet[0].length, EXPORT_COLUMNS.length);
});

test("export fetches every record across several query pages, with descriptions", async () => {
  const all = Array.from({ length: 450 }, (_, i) => ({ id: `id-${i}`, title: `Job ${i}`, description: `D${i}` }));
  const asked = [];
  const out = await fetchAllJobs(async (args) => { asked.push([args.offset, args.limit, args.includeDescription]); return { jobs: all.slice(args.offset, args.offset + args.limit), total: all.length }; });
  assert.equal(out.length, 450);
  assert.deepEqual(asked, [[0, 200, true], [200, 200, true], [400, 200, true]]);
  assert.equal(toCsv(out).split("\r\n").filter(Boolean).length, 451, "header + every job");
});

test("other tags (unclassified pills) are exported, not silently dropped", () => {
  const j = fromRow({ id: ID, other_pills: ["Benefits", "Actively hiring"] });
  assert.equal(EXPORT_COLUMNS.find((c) => c.key === "otherPills").get(j), "Benefits; Actively hiring");
  assert.ok(toCsv([j]).split("\r\n")[0].includes("Other tags"));
});

test("application URL and benefits flow through mapper, read-back and export", () => {
  const m = toRow(detailJob({ applicationMethod: "external", applicationUrl: "https://jobs.example.com/apply/1", benefits: ["Medical insurance", "Paid leave"] })).row;
  assert.deepEqual([m.application_url, m.benefits], ["https://jobs.example.com/apply/1", ["Medical insurance", "Paid leave"]]);
  assert.equal(toRow(detailJob({ applicationUrl: "https://www.linkedin.com/jobs/view/1/" })).row.application_url, null, "never a LinkedIn URL");
  assert.equal(toRow(detailJob({ applicationUrl: "javascript:alert(1)" })).row.application_url, null);
  const j = fromRow({ id: ID, application_url: "https://jobs.example.com/apply/1", benefits: ["Medical insurance"] });
  const get = (k) => EXPORT_COLUMNS.find((c) => c.key === k).get(j);
  assert.deepEqual([get("applicationUrl"), get("benefits")], ["https://jobs.example.com/apply/1", "Medical insurance"]);
  for (const col of ["application_url", "benefits"]) assert.ok(DETAIL_COLUMNS.includes(col) && FULL_COLUMNS.includes(col), col);
});

test("industry and company size flow through mapper, read-back and export", () => {
  const m = toRow(detailJob({ industry: "Business Consulting and Services", companySize: "1001-5000 employees" })).row;
  assert.deepEqual([m.industry, m.company_size], ["Business Consulting and Services", "1001-5000 employees"]);
  const j = fromRow({ id: ID, industry: "IT Services and IT Consulting", company_size: "51-200 employees" });
  const get = (k) => EXPORT_COLUMNS.find((c) => c.key === k).get(j);
  assert.deepEqual([get("industry"), get("companySize")], ["IT Services and IT Consulting", "51-200 employees"]);
  for (const col of ["industry", "company_size"]) assert.ok(DETAIL_COLUMNS.includes(col), col);
});

test("listJobs details filter: full -> has_full_detail = true, card -> false; anything else is rejected", async () => {
  const seen = [];
  const client = fakeClient({ onQuery: (ops) => { seen.push(ops); return { data: [], error: null, count: 0 }; } });
  await listJobs(client, { detail: "full" });
  await listJobs(client, { detail: "card" });
  const eqs = seen.map((ops) => ops.filter((o) => o[0] === "eq").map((o) => o.slice(1)));
  assert.deepEqual(eqs, [[["has_full_detail", true]], [["has_full_detail", false]]]);
  await assert.rejects(listJobs(client, { detail: "partial" }), (e) => e.code === "VALIDATION");
});

test("savedDetailStatus: read-only lookup by LinkedIn job id, applied-schema columns only", async () => {
  const seen = [];
  const client = fakeClient({ onQuery: (ops) => { seen.push(ops); return { data: [{ linkedin_job_id: "4400000001", has_full_detail: true }, { linkedin_job_id: "4400000002", has_full_detail: false }], error: null }; } });
  const out = await savedDetailStatus(client, ["4400000001", "4400000002", "bad", "4400000001"]);
  assert.deepEqual(out, { 4400000001: "full", 4400000002: "card" });
  const ops = Object.fromEntries(seen[0].map(([k, ...v]) => [k, v]));
  assert.deepEqual(ops.select, ["linkedin_job_id,has_full_detail"]);
  assert.deepEqual(ops.in, ["linkedin_job_id", ["4400000001", "4400000002"]]);
  assert.ok(!seen[0].some(([k]) => ["insert", "update", "delete", "rpc"].includes(k)));
  assert.deepEqual(await savedDetailStatus(client, []), {});
});
