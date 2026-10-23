// Migration 20261022000200 (job detail fields) in real Postgres (PGlite) with the REAL migration files.
// See harness.js for what is stubbed. Passing here does not prove the live project has the migration applied.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb, applyMigration, seedUsers, asRole, sqlState, jobPayload, USERS } = require("./harness.js");

const { alice, bob } = USERS;
const upsert = (db, uid, jobs) => asRole(db, uid, async () => (await db.query("select public.upsert_saved_jobs($1::jsonb) as r", [JSON.stringify(jobs)])).rows[0].r);
const row = (db, uid, id) => asRole(db, uid, async () => (await db.query("select * from public.saved_jobs where linkedin_job_id = $1", [id])).rows[0]);

const FULL = {
  country: "India", seniority_level: "Mid-Senior level", salary: "Up to ₹35,000/month", salary_currency: "INR", salary_period: "month",
  application_method: "easy_apply", hiring_insight: "Responses managed off LinkedIn", preferred_qualifications: ["Chrome extensions"],
  education_requirements: ["Bachelor's degree"], certifications: ["AWS Certified Developer"], extraction_status: "complete", extraction_warnings: [],
};

test("applies on top of the live schema: existing rows are kept unchanged and get empty defaults", async () => {
  const db = await createDb({ through: "20261022000100" });
  try {
    await seedUsers(db);
    const j = jobPayload({ description: "Keep me", application_status: "open" });
    await upsert(db, alice, [j]);
    const before = (await db.query("select * from public.saved_jobs")).rows[0];
    await applyMigration(db, "20261022000200");
    const after = (await db.query("select * from public.saved_jobs")).rows[0];
    for (const col of Object.keys(before)) assert.deepEqual(after[col], before[col], col);
    assert.deepEqual(
      [after.country, after.extraction_status, after.preferred_qualifications, after.education_requirements, after.certifications, after.extraction_warnings],
      [null, null, [], [], [], []],
    );
  } finally { await db.close(); }
});

let db;
test.before(async () => { db = await createDb(); await seedUsers(db); });
test.after(async () => db && (await db.close()));
test.beforeEach(async () => { await db.exec("delete from public.saved_jobs"); });

test("every new field is stored in its own column", async () => {
  const j = jobPayload(FULL);
  assert.deepEqual(await upsert(db, alice, [j]), { inserted: 1, duplicates: 0 });
  const r = await row(db, alice, j.linkedin_job_id);
  for (const [k, v] of Object.entries(FULL)) assert.deepEqual(r[k], v, k);
});

test("a later card-only save never erases detail fields, and cannot downgrade 'complete'", async () => {
  const j = jobPayload(FULL);
  await upsert(db, alice, [j]);
  await upsert(db, alice, [{
    linkedin_job_id: j.linkedin_job_id, job_url: j.job_url, job_title: "Graphic Designer", source: "card", has_full_detail: false,
    country: "", salary_currency: null, preferred_qualifications: [], education_requirements: [], certifications: [],
    extraction_status: "partial", extraction_warnings: ["card-only"],
  }]);
  const r = await row(db, alice, j.linkedin_job_id);
  for (const [k, v] of Object.entries(FULL)) assert.deepEqual(r[k], v, k);
  assert.equal(r.description, "Design things");
});

test("extraction status and warnings: partial -> complete clears warnings; a card never replaces a detail's warnings", async () => {
  const j = jobPayload({ source: "detail", extraction_status: "partial", extraction_warnings: ["missing:location"] });
  await upsert(db, alice, [j]);
  await upsert(db, alice, [{ ...j, source: "card", has_full_detail: false, description: null, extraction_status: "partial", extraction_warnings: ["card-only"] }]);
  let r = await row(db, alice, j.linkedin_job_id);
  assert.deepEqual([r.extraction_status, r.extraction_warnings], ["partial", ["missing:location"]]);
  await upsert(db, alice, [{ ...j, extraction_status: "partial", extraction_warnings: ["missing:postedText"] }]);
  r = await row(db, alice, j.linkedin_job_id);
  assert.deepEqual(r.extraction_warnings, ["missing:postedText"], "the latest detail read's warnings");
  await upsert(db, alice, [{ ...j, extraction_status: "complete", extraction_warnings: [] }]);
  r = await row(db, alice, j.linkedin_job_id);
  assert.deepEqual([r.extraction_status, r.extraction_warnings], ["complete", []]);
  await upsert(db, alice, [{ ...j, extraction_status: "partial", extraction_warnings: ["missing:location"] }]);
  assert.equal((await row(db, alice, j.linkedin_job_id)).extraction_status, "complete", "complete is sticky");
});

test("card first, then the open job: the card's 'card-only' warning is replaced by the detail read", async () => {
  const id = jobPayload().linkedin_job_id;
  const url = `https://www.linkedin.com/jobs/view/${id}/`;
  await upsert(db, alice, [{ linkedin_job_id: id, job_url: url, job_title: "T", source: "card", has_full_detail: false, extraction_status: "partial", extraction_warnings: ["card-only"] }]);
  await upsert(db, alice, [jobPayload({ linkedin_job_id: id, job_url: url, ...FULL })]);
  const r = await row(db, alice, id);
  assert.deepEqual([r.source, r.extraction_status, r.extraction_warnings, r.country], ["detail", "complete", [], "India"]);
});

test("old payloads without the new keys still save and merge exactly as before", async () => {
  const j = jobPayload({ application_status: "closed", application_status_text: "No longer accepting applications" });
  assert.deepEqual(await upsert(db, alice, [j]), { inserted: 1, duplicates: 0 });
  assert.deepEqual(await upsert(db, alice, [{ ...j, description: "" }]), { inserted: 0, duplicates: 1 });
  const r = await row(db, alice, j.linkedin_job_id);
  assert.deepEqual([r.description, r.application_status, r.extraction_status], ["Design things", "closed", null]);
});

test("invalid values are rejected by the database", async () => {
  for (const bad of [
    { seniority_level: "Senior" }, { salary_currency: "Rupees" }, { salary_period: "fortnight" }, { application_method: "email" },
    { extraction_status: "failed" }, { hiring_insight: "x".repeat(501) }, { country: "x".repeat(101) },
  ]) assert.equal(await sqlState(upsert(db, alice, [jobPayload(bad)])), "23514", JSON.stringify(bad).slice(0, 40));
});

test("RLS and grants: new columns are private to the owner and updatable only by the owner", async () => {
  const j = jobPayload(FULL);
  await upsert(db, alice, [j]);
  assert.equal(await row(db, bob, j.linkedin_job_id), undefined, "bob cannot see alice's row");
  const bobUpdate = await asRole(db, bob, async () => (await db.query("update public.saved_jobs set country = 'X' where linkedin_job_id = $1 returning id", [j.linkedin_job_id])).rows);
  assert.deepEqual(bobUpdate, []);
  const own = await asRole(db, alice, async () => (await db.query("update public.saved_jobs set certifications = '{}' where linkedin_job_id = $1 returning certifications", [j.linkedin_job_id])).rows);
  assert.deepEqual(own[0].certifications, []);
  assert.equal(await sqlState(asRole(db, alice, () => db.query("update public.saved_jobs set user_id = $1", [bob]))), "42501", "identity columns stay locked");
  assert.equal(await sqlState(asRole(db, null, () => db.query("select country from public.saved_jobs"))), "42501", "anon is denied");
});

test("application_url and benefits: stored, merged safely, and the URL is constrained", async () => {
  const j = jobPayload({ application_url: "https://optiphoenix.keka.com/careers/jobdetails/107156?source=linkedin", benefits: ["Medical insurance"] });
  await upsert(db, alice, [j]);
  await upsert(db, alice, [{ ...j, source: "card", application_url: null, benefits: [] }]);
  const r = await row(db, alice, j.linkedin_job_id);
  assert.deepEqual([r.application_url, r.benefits], ["https://optiphoenix.keka.com/careers/jobdetails/107156?source=linkedin", ["Medical insurance"]]);
  for (const bad of ["http://example.com/", "https://www.linkedin.com/jobs/view/1/", "javascript:alert(1)", "https://x.com/a b"]) {
    assert.equal(await sqlState(upsert(db, alice, [jobPayload({ application_url: bad })])), "23514", bad);
  }
});

test("industry and company size are stored and never erased by a card-only save", async () => {
  const j = jobPayload({ industry: "Business Consulting and Services", company_size: "1001-5000 employees" });
  await upsert(db, alice, [j]);
  await upsert(db, alice, [{ ...j, source: "card", industry: null, company_size: "" }]);
  const r = await row(db, alice, j.linkedin_job_id);
  assert.deepEqual([r.industry, r.company_size], ["Business Consulting and Services", "1001-5000 employees"]);
  assert.equal(await sqlState(upsert(db, alice, [jobPayload({ industry: "x".repeat(201) })])), "23514");
});
