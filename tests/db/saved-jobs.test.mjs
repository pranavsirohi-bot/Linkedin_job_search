import test from "node:test";
import assert from "node:assert/strict";
import { fakeClient, ops, opNames } from "./fake-client.mjs";
import { ERR, DbError, toDbError } from "../../src/db/errors.js";
import { toRow, mergeRows, fromRow, escapeLike } from "../../src/db/job-mapper.js";
import {
  saveJobs, saveJob, findDuplicates, findDuplicatesBy, getJob, getJobByLinkedInId, listJobs, updateJob, deleteJob, countJobs,
} from "../../src/db/saved-jobs.js";

const UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

// Shaped like the extractor's record for the standalone fixture (tests/fixtures/job-standalone.html).
const detail = (over = {}) => ({
  source: "detail", jobId: "4480218579", url: "https://www.linkedin.com/jobs/view/4480218579/",
  title: "Junior Graphic Designer", company: "YourfriendlyHR", companyUrl: "https://www.linkedin.com/company/yourfriendlyhr/",
  location: "India", postedText: "1 day ago", postedDateApprox: "2026-10-20", applicantsText: "Over 100 applicants",
  workplaceType: "Remote", employmentType: "Full-time", otherPills: [], description: "Design things.",
  salary: "Up to ₹35,000/month", experience: "Fresher to Junior Level", responsibilities: ["Create graphics"],
  qualifications: ["Adobe CS"], skills: ["Graphic Design", "graphic design", "Adobe"], collectedAt: "2026-10-21T12:00:00.000Z",
  ...over,
});
const card = (id, over = {}) => ({
  source: "card", jobId: id, url: `https://www.linkedin.com/jobs/view/${id}/`, title: `Job ${id}`, company: "Acme",
  location: "India", workplaceType: "", collectedAt: "2026-10-21T12:00:00.000Z", ...over,
});

// ------------------------------------------------------------------ mapping
test("toRow maps a full detail record", () => {
  const { ok, row } = toRow(detail());
  assert.equal(ok, true);
  assert.equal(row.linkedin_job_id, "4480218579");
  assert.equal(row.job_title, "Junior Graphic Designer");
  assert.equal(row.company_url, "https://www.linkedin.com/company/yourfriendlyhr/");
  assert.equal(row.posted_date_approx, "2026-10-20");
  assert.equal(row.workplace_type, "Remote");
  assert.deepEqual(row.skills, ["graphic design", "adobe"]); // lower-cased, de-duplicated
  assert.equal(row.experience_required, "Fresher to Junior Level");
  assert.equal(row.has_full_detail, true);
  assert.equal(row.source, "detail");
  assert.equal(row.scraped_at, "2026-10-21T12:00:00.000Z");
  assert.ok(!("user_id" in row), "the client never sends user_id");
});

test("toRow: missing fields become null / empty arrays, never empty strings", () => {
  const { row } = toRow(card("4480307941", { location: "  ", company: "", workplaceType: "" }));
  assert.equal(row.location, null);
  assert.equal(row.company_name, null);
  assert.equal(row.workplace_type, null);
  assert.equal(row.description, null);
  assert.deepEqual(row.skills, []);
  assert.equal(row.has_full_detail, false);
  assert.equal(row.source, "card");
  for (const v of Object.values(row)) assert.notEqual(v, "");
});

test("toRow: unknown enum values, bad dates and foreign URLs are neutralised, not fatal", () => {
  const { row } = toRow(detail({ workplaceType: "Underwater", employmentType: "Whenever", postedDateApprox: "2026-02-31", companyUrl: "https://evil.example/company/x/", url: "https://evil.example/jobs/view/1/" }));
  assert.equal(row.workplace_type, null);
  assert.equal(row.employment_type, null);
  assert.equal(row.posted_date_approx, null);
  assert.equal(row.company_url, null);
  assert.equal(row.job_url, "https://www.linkedin.com/jobs/view/4480218579/");
});

test("toRow rejects records without a usable job id or content", () => {
  assert.deepEqual(toRow({ title: "x" }), { ok: false, jobId: null, reason: "missing-or-invalid-job-id" });
  assert.equal(toRow({ jobId: "abc", title: "x" }).ok, false);
  assert.equal(toRow({ jobId: "4480307941" }).reason, "no-usable-fields");
  assert.equal(toRow(null).ok, false);
});

test("mergeRows: non-empty values win, empty never overwrite, detail beats card", () => {
  const c = toRow(card("4480218579", { title: "Card title", location: "India" })).row;
  const d = toRow(detail({ location: "", title: "Detail title" })).row;
  const m = mergeRows(c, d);
  assert.equal(m.job_title, "Detail title");
  assert.equal(m.location, "India"); // detail had none, card value kept
  assert.equal(m.description, "Design things.");
  assert.equal(m.source, "detail");
  assert.equal(m.has_full_detail, true);
});

test("fromRow returns the camelCase shape used by the extractor", () => {
  const j = fromRow({ id: UUID, linkedin_job_id: "1", job_url: "u", job_title: "t", skills: null, has_full_detail: true });
  assert.equal(j.jobId, "1");
  assert.equal(j.title, "t");
  assert.deepEqual(j.skills, []);
  assert.equal(j.hasFullDetail, true);
});

// ------------------------------------------------------------------ save
test("saveJob calls the upsert RPC with a clean row and reports counts", async () => {
  const client = fakeClient({ onRpc: { data: { inserted: 1, duplicates: 0 }, error: null } });
  const res = await saveJob(client, detail());
  assert.deepEqual(res, { total: 1, inserted: 1, duplicates: 0, rejected: [] });
  const [[, name, args]] = client.rpcCalls()[0];
  assert.equal(name, "upsert_saved_jobs");
  assert.equal(args.p_jobs.length, 1);
  assert.equal(args.p_jobs[0].linkedin_job_id, "4480218579");
});

test("saveJobs merges the card and detail for the same job into one row", async () => {
  const client = fakeClient({ onRpc: { data: { inserted: 1, duplicates: 0 }, error: null } });
  await saveJobs(client, [card("4480218579", { title: "Card title" }), detail()]);
  const rows = client.rpcCalls()[0][0][2].p_jobs;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].job_title, "Junior Graphic Designer");
  assert.equal(rows[0].description, "Design things.");
});

test("saveJobs chunks large batches and sums the counts", async () => {
  const client = fakeClient({ onRpc: (_n, a) => ({ data: { inserted: a.p_jobs.length - 1, duplicates: 1 }, error: null }) });
  const jobs = Array.from({ length: 120 }, (_, i) => card(String(4400000000 + i)));
  const res = await saveJobs(client, jobs);
  assert.equal(client.rpcCalls().length, 3); // 50 + 50 + 20
  assert.deepEqual([res.total, res.inserted, res.duplicates], [120, 117, 3]);
});

test("saveJobs reports rejected records and still saves the rest", async () => {
  const client = fakeClient({ onRpc: { data: { inserted: 1, duplicates: 0 }, error: null } });
  const res = await saveJobs(client, [detail(), { jobId: "nope", title: "x" }, { title: "no id" }]);
  assert.equal(res.inserted, 1);
  assert.equal(res.rejected.length, 2);
  assert.equal(res.rejected[0].reason, "missing-or-invalid-job-id");
});

test("saveJobs with nothing valid makes no request", async () => {
  const client = fakeClient();
  const res = await saveJobs(client, [{ title: "no id" }]);
  assert.equal(client.calls.length, 0);
  assert.equal(res.total, 0);
  assert.deepEqual(await saveJobs(client, null), { total: 0, inserted: 0, duplicates: 0, rejected: [] });
});

test("saveJobs: a failed chunk reports how far it got (partial) with a mapped error", async () => {
  let n = 0;
  const client = fakeClient({
    onRpc: () => (++n === 1 ? { data: { inserted: 50, duplicates: 0 }, error: null } : { data: null, error: { message: "TypeError: Failed to fetch" } }),
  });
  const jobs = Array.from({ length: 80 }, (_, i) => card(String(4400000000 + i)));
  await assert.rejects(saveJobs(client, jobs), (e) => {
    assert.equal(e.code, ERR.NETWORK);
    assert.deepEqual(e.partial, { inserted: 50, duplicates: 0 });
    return true;
  });
});

test("saveJobs maps a thrown network error and an auth error", async () => {
  const thrown = fakeClient({ onRpc: () => { throw new TypeError("Failed to fetch"); } });
  await assert.rejects(saveJob(thrown, detail()), (e) => e.code === ERR.NETWORK);
  const noAuth = fakeClient({ onRpc: { data: null, error: { code: "28000", message: "not authenticated" } } });
  await assert.rejects(saveJob(noAuth, detail()), (e) => e.code === ERR.AUTH_REQUIRED);
});

// ------------------------------------------------------------------ duplicates
test("findDuplicates ignores invalid ids, de-duplicates and chunks", async () => {
  const client = fakeClient({ onQuery: (o) => ({ data: o.find((x) => x[0] === "in")[2].slice(0, 1).map((id) => ({ linkedin_job_id: id })), error: null }) });
  const ids = [...Array.from({ length: 150 }, (_, i) => String(4400000000 + i)), "4400000000", "bad", ""];
  const found = await findDuplicates(client, ids);
  assert.equal(client.calls.length, 2); // 100 + 50 valid unique ids
  assert.equal(found.length, 2);
  assert.deepEqual(opNames(client.calls, 0), ["from", "select", "in"]);
  assert.equal((await findDuplicates(fakeClient(), ["x"])).length, 0);
});

// ------------------------------------------------------------------ read
test("getJob validates the id, returns null when missing, maps rows", async () => {
  await assert.rejects(getJob(fakeClient(), "not-a-uuid"), (e) => e.code === ERR.VALIDATION);
  assert.equal(await getJob(fakeClient({ onQuery: { data: null, error: null } }), UUID), null);
  const client = fakeClient({ onQuery: { data: { id: UUID, linkedin_job_id: "4480218579", job_title: "T", description: "D" }, error: null } });
  const j = await getJob(client, UUID);
  assert.equal(j.title, "T");
  assert.equal(j.description, "D");
  assert.deepEqual(ops(client.calls).eq, ["id", UUID]);
  assert.match(ops(client.calls).select[0], /description/);
});

test("getJobByLinkedInId and countJobs", async () => {
  const client = fakeClient({ onQuery: { data: { id: UUID, linkedin_job_id: "4480218579" }, error: null } });
  assert.equal((await getJobByLinkedInId(client, "4480218579")).jobId, "4480218579");
  await assert.rejects(getJobByLinkedInId(client, "x"), (e) => e.code === ERR.VALIDATION);
  assert.equal(await countJobs(fakeClient({ onQuery: { data: null, count: 7, error: null } })), 7);
});

// ------------------------------------------------------------------ search / list
test("listJobs composes every filter and escapes wildcards in user input", async () => {
  const client = fakeClient({ onQuery: { data: [{ id: UUID, linkedin_job_id: "1" }], count: 42, error: null } });
  const res = await listJobs(client, {
    query: "designer photoshop", company: "50%_off\\", location: "Mumbai", workplaceType: "Remote",
    employmentType: "Full-time", skills: ["Photoshop", " Figma "], limit: 10, offset: 20, orderBy: "company", ascending: true,
  });
  assert.equal(res.total, 42);
  assert.equal(res.jobs.length, 1);
  const names = opNames(client.calls);
  assert.deepEqual(names, ["from", "select", "textSearch", "ilike", "ilike", "eq", "eq", "contains", "order", "range"]);
  const calls = client.calls[0];
  assert.deepEqual(calls[2], ["textSearch", "search_tsv", "designer photoshop", { type: "websearch", config: "english" }]);
  assert.deepEqual(calls[3], ["ilike", "company_name", "%50\\%\\_off\\\\%"]);
  assert.deepEqual(calls[4], ["ilike", "location", "%Mumbai%"]);
  assert.deepEqual(calls[7], ["contains", "skills", ["photoshop", "figma"]]);
  assert.deepEqual(calls[8], ["order", "company_name", { ascending: true }]);
  assert.deepEqual(calls[9], ["range", 20, 29]);
  assert.doesNotMatch(calls[1][1], /description/, "list rows omit descriptions by default");
});

test("listJobs with no filters returns newest first and clamps the page size", async () => {
  const client = fakeClient({ onQuery: { data: [], count: 0, error: null } });
  const res = await listJobs(client, { limit: 9999, offset: -5 });
  assert.deepEqual([res.limit, res.offset], [200, 0]);
  assert.deepEqual(opNames(client.calls), ["from", "select", "order", "range"]);
  assert.deepEqual(client.calls[0][2], ["order", "created_at", { ascending: false }]);
  assert.deepEqual(client.calls[0][3], ["range", 0, 199]);
});

test("listJobs skips blank filters, rejects unknown enum values, can include descriptions", async () => {
  const client = fakeClient({ onQuery: { data: [], count: 0, error: null } });
  await listJobs(client, { query: "   ", company: "", skills: ["", " "], includeDescription: true });
  assert.deepEqual(opNames(client.calls), ["from", "select", "order", "range"]);
  assert.match(client.calls[0][1][1], /description/);
  await assert.rejects(listJobs(client, { workplaceType: "Nope" }), (e) => e.code === ERR.VALIDATION);
  await assert.rejects(listJobs(client, { employmentType: "Nope" }), (e) => e.code === ERR.VALIDATION);
});

test("listJobs surfaces database errors as DbError", async () => {
  const client = fakeClient({ onQuery: { data: null, error: { code: "42501", message: "permission denied" } } });
  await assert.rejects(listJobs(client), (e) => e instanceof DbError && e.code === ERR.PERMISSION);
});

test("escapeLike", () => assert.equal(escapeLike("a%b_c\\d"), "a\\%b\\_c\\\\d"));

// ------------------------------------------------------------------ update / delete
test("updateJob sends only whitelisted columns and ignores identity fields", async () => {
  const client = fakeClient({ onQuery: { data: { id: UUID, linkedin_job_id: "1", job_title: "New" }, error: null } });
  const j = await updateJob(client, UUID, {
    title: " New ", skills: ["A", "a", "B"], user_id: "evil", userId: "evil", linkedin_job_id: "999999", id: "x", createdAt: "x",
  });
  assert.equal(j.title, "New");
  const sent = ops(client.calls).update[0];
  assert.deepEqual(sent, { job_title: "New", skills: ["a", "b"] });
  assert.deepEqual(ops(client.calls).eq, ["id", UUID]);
});

test("updateJob: explicit empty values clear a field; description toggles has_full_detail", async () => {
  const client = fakeClient({ onQuery: { data: { id: UUID, linkedin_job_id: "1" }, error: null } });
  await updateJob(client, UUID, { salary: "", workplaceType: "", description: "" });
  assert.deepEqual(ops(client.calls).update[0], { salary: null, workplace_type: null, description: null, has_full_detail: false });
});

test("updateJob validation and not-found", async () => {
  const ok = fakeClient({ onQuery: { data: { id: UUID, linkedin_job_id: "1" }, error: null } });
  await assert.rejects(updateJob(ok, "bad", { title: "x" }), (e) => e.code === ERR.VALIDATION);
  await assert.rejects(updateJob(ok, UUID, {}), (e) => e.code === ERR.VALIDATION);
  await assert.rejects(updateJob(ok, UUID, { user_id: "x" }), (e) => e.code === ERR.VALIDATION);
  await assert.rejects(updateJob(ok, UUID, { workplaceType: "Nope" }), (e) => e.code === ERR.VALIDATION);
  await assert.rejects(updateJob(ok, UUID, { postedDateApprox: "yesterday" }), (e) => e.code === ERR.VALIDATION);
  const none = fakeClient({ onQuery: { data: null, error: null } }); // RLS hides other users' rows -> no row
  await assert.rejects(updateJob(none, UUID, { title: "x" }), (e) => e.code === ERR.NOT_FOUND);
});

test("deleteJob returns the count and reports NOT_FOUND when nothing was deleted", async () => {
  assert.deepEqual(await deleteJob(fakeClient({ onQuery: { data: [{ id: UUID }], error: null } }), UUID), { deleted: 1 });
  await assert.rejects(deleteJob(fakeClient({ onQuery: { data: [], error: null } }), UUID), (e) => e.code === ERR.NOT_FOUND);
  await assert.rejects(deleteJob(fakeClient(), "bad"), (e) => e.code === ERR.VALIDATION);
});

// ------------------------------------------------------------------ error mapping
test("toDbError maps the failure modes the UI cares about", () => {
  const code = (e) => toDbError(e).code;
  assert.equal(code(new TypeError("Failed to fetch")), ERR.NETWORK);
  assert.equal(code({ message: "TypeError: Failed to fetch" }), ERR.NETWORK);
  assert.equal(code({ message: "NetworkError when attempting to fetch resource." }), ERR.NETWORK);
  assert.equal(code({ status: 401, message: "x" }), ERR.AUTH_REQUIRED);
  assert.equal(code({ message: "JWT expired" }), ERR.AUTH_REQUIRED);
  assert.equal(code({ code: "42501", message: "permission denied for table saved_jobs" }), ERR.PERMISSION);
  assert.equal(code({ code: "23514", message: "violates check constraint" }), ERR.VALIDATION);
  assert.equal(code({ code: "PGRST116", message: "no rows" }), ERR.NOT_FOUND);
  assert.equal(code({ status: 429, message: "slow down" }), ERR.RATE_LIMITED);
  assert.equal(code({ status: 503, message: "x" }), ERR.UNKNOWN);
  assert.equal(code("boom"), ERR.UNKNOWN);
  const e = new DbError(ERR.VALIDATION, "m");
  assert.equal(toDbError(e), e);
});

// ------------------------------------------------------------------ application status
test("toRow carries the application status and its notice text", () => {
  const closed = toRow(detail({ applicationStatus: "closed", applicationStatusText: "No longer accepting applications" })).row;
  assert.equal(closed.application_status, "closed");
  assert.equal(closed.application_status_text, "No longer accepting applications");
  const open = toRow(detail({ applicationStatus: "open", applicationStatusText: "" })).row;
  assert.equal(open.application_status, "open");
  assert.equal(open.application_status_text, null);
});

test("toRow: unknown or invalid status becomes null, and text is never sent without a status", () => {
  for (const v of ["", undefined, null, "pending", "CLOSED", 5]) {
    const row = toRow(detail({ applicationStatus: v, applicationStatusText: "stray text" })).row;
    assert.equal(row.application_status, null, String(v));
    assert.equal(row.application_status_text, null, String(v));
  }
});

test("mergeRows: a known status is not erased by a card (unknown) and a newer detail status wins", () => {
  const d = toRow(detail({ applicationStatus: "closed", applicationStatusText: "Closed" })).row;
  const c = toRow(card("4480218579")).row;
  const m = mergeRows(d, c);
  assert.equal(m.application_status, "closed");
  assert.equal(m.application_status_text, "Closed");
  const reopened = mergeRows(d, toRow(detail({ applicationStatus: "open" })).row);
  assert.equal(reopened.application_status, "open");
});

test("saveJobs sends the status in the RPC payload", async () => {
  const client = fakeClient({ onRpc: { data: { inserted: 1, duplicates: 0 }, error: null } });
  await saveJob(client, detail({ applicationStatus: "closed", applicationStatusText: "No longer accepting applications" }));
  const row = client.rpcCalls()[0][0][2].p_jobs[0];
  assert.equal(row.application_status, "closed");
  assert.equal(row.application_status_text, "No longer accepting applications");
});

test("fromRow exposes status fields with safe defaults for old rows", () => {
  const old = fromRow({ id: UUID, linkedin_job_id: "1", job_url: "u" });
  assert.equal(old.applicationStatus, "");
  assert.equal(old.applicationStatusText, "");
  assert.equal(old.applicationStatusAt, null);
  const closed = fromRow({ id: UUID, linkedin_job_id: "1", job_url: "u", application_status: "closed", application_status_text: "x", application_status_at: "2026-10-22T10:00:00Z" });
  assert.equal(closed.applicationStatus, "closed");
});

test("listJobs filters by application status; 'unknown' means never observed (IS NULL)", async () => {
  const mk = () => fakeClient({ onQuery: { data: [], count: 0, error: null } });
  const closed = mk();
  await listJobs(closed, { applicationStatus: "closed" });
  assert.deepEqual(closed.calls[0].find((o) => o[0] === "eq"), ["eq", "application_status", "closed"]);
  const open = mk();
  await listJobs(open, { applicationStatus: "open" });
  assert.deepEqual(open.calls[0].find((o) => o[0] === "eq"), ["eq", "application_status", "open"]);
  const unknown = mk();
  await listJobs(unknown, { applicationStatus: "unknown" });
  assert.deepEqual(unknown.calls[0].find((o) => o[0] === "is"), ["is", "application_status", null]);
  assert.ok(!unknown.calls[0].some((o) => o[0] === "eq"));
  const none = mk();
  await listJobs(none, {});
  assert.ok(!none.calls[0].some((o) => o[0] === "is" || o[0] === "eq"));
  await assert.rejects(listJobs(mk(), { applicationStatus: "pending" }), (e) => e.code === ERR.VALIDATION);
});

test("list columns include the status fields", async () => {
  const client = fakeClient({ onQuery: { data: [], count: 0, error: null } });
  await listJobs(client);
  assert.match(client.calls[0][1][1], /application_status,application_status_text,application_status_at/);
});

// ------------------------------------------------------------------ multi-provider identity
const gh = (over = {}) => ({
  provider: "greenhouse", externalId: "figma:5426468004", url: "https://boards.greenhouse.io/figma/jobs/5426468004?gh_jid=5426468004",
  title: "Product Designer", company: "Figma", companyUrl: "https://boards.greenhouse.io/figma", location: "Remote", description: "Design.",
  source: "detail", applicationStatus: "open", ...over,
});

test("toRow: LinkedIn records are unchanged (provider linkedin, external id mirrors the job id)", () => {
  const { row } = toRow(detail());
  assert.deepEqual([row.provider, row.external_id, row.linkedin_job_id], ["linkedin", "4480218579", "4480218579"]);
});

test("toRow: other providers use external id + https URL and never set linkedin_job_id", () => {
  const { ok, row } = toRow(gh());
  assert.equal(ok, true);
  assert.deepEqual([row.provider, row.external_id, row.linkedin_job_id], ["greenhouse", "figma:5426468004", null]);
  assert.equal(row.job_url, "https://boards.greenhouse.io/figma/jobs/5426468004?gh_jid=5426468004");
  assert.equal(row.company_url, "https://boards.greenhouse.io/figma");
  assert.equal(row.application_status, "open");
});

test("toRow rejects bad identities and URLs per provider, with a reason", () => {
  assert.equal(toRow(gh({ provider: "Bad Provider" })).reason, "invalid-provider");
  assert.equal(toRow(gh({ externalId: "has space" })).reason, "missing-or-invalid-job-id");
  assert.equal(toRow(gh({ externalId: "" })).reason, "missing-or-invalid-job-id");
  for (const url of ["http://x.example/1", "javascript:alert(1)", "https://u:p@x.example/1", "https://x.example/a b", 'https://x.example/"x', "", undefined, "ftp://x.example"]) {
    assert.equal(toRow(gh({ url })).reason, "invalid-url", String(url));
  }
  assert.equal(toRow(gh({ companyUrl: "http://evil.example" })).row.company_url, null, "bad company URL is dropped, not fatal");
  assert.equal(toRow({ provider: "linkedin", jobId: "abc", title: "x" }).ok, false);
  assert.equal(toRow({ ...detail(), url: "https://evil.example/jobs/view/1/" }).row.job_url, "https://www.linkedin.com/jobs/view/4480218579/", "LinkedIn URL is re-derived, never trusted");
});

test("saveJobs keys identity by (provider, external id): same id under two providers stays two rows", async () => {
  const client = fakeClient({ onRpc: { data: { inserted: 2, duplicates: 0 }, error: null } });
  await saveJobs(client, [detail({ jobId: "4480218579" }), gh({ externalId: "4480218579" }), gh({ externalId: "4480218579", title: "Later partial", description: "" })]);
  const rows = client.rpcCalls()[0][0][2].p_jobs;
  assert.equal(rows.length, 2);
  const ghRow = rows.find((r) => r.provider === "greenhouse");
  assert.equal(ghRow.description, "Design.", "merged: the empty later description did not erase the earlier one");
  assert.equal(ghRow.job_title, "Later partial");
});

test("saveJobs reports provider validation problems as rejected, and saves the rest", async () => {
  const client = fakeClient({ onRpc: { data: { inserted: 1, duplicates: 0 }, error: null } });
  const res = await saveJobs(client, [gh(), gh({ externalId: "x y" }), gh({ externalId: "figma:2", url: "http://nope" })]);
  assert.equal(res.inserted, 1);
  assert.deepEqual(res.rejected.map((r) => r.reason).sort(), ["invalid-url", "missing-or-invalid-job-id"]);
});

test("findDuplicatesBy filters by provider and valid ids, chunks, and validates the provider", async () => {
  const client = fakeClient({ onQuery: (o) => ({ data: o.find((x) => x[0] === "in")[2].slice(0, 1).map((id) => ({ external_id: id })), error: null }) });
  const ids = [...Array.from({ length: 150 }, (_, i) => `figma:${i}`), "bad id", ""];
  const found = await findDuplicatesBy(client, "greenhouse", ids);
  assert.equal(client.calls.length, 2);
  assert.equal(found.length, 2);
  assert.deepEqual(client.calls[0].find((o) => o[0] === "eq"), ["eq", "provider", "greenhouse"]);
  await assert.rejects(findDuplicatesBy(client, "Bad Provider", ["a"]), (e) => e.code === ERR.VALIDATION);
});

test("list columns do NOT select provider/external_id (the optional migration is not applied); provider filter is still validated", async () => {
  const client = fakeClient({ onQuery: { data: [], count: 0, error: null } });
  await listJobs(client);
  const cols = client.calls[0][1][1].split(",");
  assert.ok(!cols.includes("provider") && !cols.includes("external_id"), cols.join(","));
  assert.ok(cols.includes("linkedin_job_id") && cols.includes("application_status"));
  await assert.rejects(listJobs(client, { provider: "Bad Provider" }), (e) => e.code === ERR.VALIDATION);
});
test("fromRow exposes provider and external id; LinkedIn rows keep jobId = LinkedIn id", () => {
  const li = fromRow({ id: UUID, provider: "linkedin", external_id: "4480218579", linkedin_job_id: "4480218579", job_url: "u" });
  assert.deepEqual([li.provider, li.externalId, li.jobId], ["linkedin", "4480218579", "4480218579"]);
  const g = fromRow({ id: UUID, provider: "greenhouse", external_id: "figma:1", linkedin_job_id: null, job_url: "u" });
  assert.deepEqual([g.provider, g.externalId, g.jobId], ["greenhouse", "figma:1", "figma:1"]);
  assert.equal(fromRow({ id: UUID, linkedin_job_id: "123456", job_url: "u" }).provider, "linkedin", "rows from before the migration default to linkedin");
});
