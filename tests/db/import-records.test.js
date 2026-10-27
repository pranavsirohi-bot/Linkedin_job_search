// Imported (CSV / JSON) records against the REAL migration files in in-process Postgres (PGlite). See harness.js for what is
// stubbed. Proves: the importer's records satisfy the multi-provider schema, re-imports update instead of duplicating, and the
// schema that is live today (three migrations) refuses them, which is why the run's preflight asks for the database update.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb, applyMigration, seedUsers, asRole, sqlState, USERS } = require("./harness.js");

const NOW = new Date("2026-10-23T10:00:00Z");
const CSV = [
  "title,company,location,url,description,id,skills,salary",
  'Web Developer,Acme,"Pune, India",https://careers.example.com/jobs/1,"Build sites, maintain them",ext-1,"php; wordpress",INR 600000 - 900000',
  "Designer,Beta,Delhi,https://careers.example.com/jobs/2,,ext-2,,",
  "QA Engineer,Gamma,Noida,https://careers.example.com/jobs/3?ref=a&b=c,Test things,,,",
].join("\n");

async function rowsFromCsv() {
  const { parseImportFile } = await import("../../src/sources/file-import.js");
  const { toRow } = await import("../../src/db/job-mapper.js");
  const parsed = parseImportFile({ name: "jobs.csv", size: CSV.length, text: CSV }, { now: NOW });
  assert.equal(parsed.records.length, 3);
  return parsed.records.map((r) => { const { __canonical, ...rec } = r; const m = toRow(rec); assert.equal(m.ok, true, JSON.stringify(m)); return m.row; });
}
const upsert = (db, rows) => asRole(db, USERS.alice, async () => (await db.query("select public.upsert_saved_jobs($1::jsonb) as r", [JSON.stringify(rows)])).rows[0].r);
const stored = (db) => asRole(db, USERS.alice, async () => (await db.query("select provider, external_id, linkedin_job_id, job_title, description, has_full_detail, source, extraction_status, extraction_warnings, skills, salary from public.saved_jobs order by job_title")).rows);

test("with both pending migrations the importer's records are stored, with honest completeness; re-importing updates, never duplicates", async () => {
  const db = await createDb();
  try {
    await seedUsers(db);
    const rows = await rowsFromCsv();
    assert.deepEqual(await upsert(db, rows), { inserted: 3, duplicates: 0 });
    const got = await stored(db);
    assert.equal(got.length, 3);
    for (const r of got) assert.deepEqual([r.provider, r.linkedin_job_id, r.source], ["file", null, "detail"]);
    const designer = got.find((r) => r.job_title === "Designer");
    assert.deepEqual([designer.description, designer.has_full_detail, designer.extraction_status, designer.extraction_warnings], [null, false, "partial", ["missing:description"]], "no description is invented");
    const web = got.find((r) => r.job_title === "Web Developer");
    assert.deepEqual([web.has_full_detail, web.extraction_status, web.skills, web.salary], [true, "complete", ["php", "wordpress"], "INR 600000 - 900000"]);
    assert.match(got.find((r) => r.job_title === "QA Engineer").external_id, /^url-[0-9a-f]{16}$/, "no id in the file: stable id from the URL");
    // Again: all updates, no new rows, and a later row with an empty description cannot erase the stored one.
    assert.deepEqual(await upsert(db, rows), { inserted: 0, duplicates: 3 });
    const empty = rows.map((r) => ({ ...r, description: null, skills: [], salary: null }));
    assert.deepEqual(await upsert(db, empty), { inserted: 0, duplicates: 3 });
    const after = (await stored(db)).find((r) => r.job_title === "Web Developer");
    assert.deepEqual([after.description, after.skills, after.salary], ["Build sites, maintain them", ["php", "wordpress"], "INR 600000 - 900000"]);
    assert.equal((await stored(db)).length, 3);
  } finally { await db.close(); }
});

test("an imported job with the same text id as a LinkedIn job is a different job", async () => {
  const db = await createDb();
  try {
    await seedUsers(db);
    const [web] = await rowsFromCsv();
    await upsert(db, [{ ...web, external_id: "4400000001" }]);
    const li = { linkedin_job_id: "4400000001", job_url: "https://www.linkedin.com/jobs/view/4400000001/", job_title: "LinkedIn job", source: "card" };
    assert.deepEqual(await upsert(db, [li]), { inserted: 1, duplicates: 0 });
    assert.equal((await stored(db)).length, 2);
  } finally { await db.close(); }
});

test("the schema that is live today (three migrations) refuses imported jobs, and so does one with only the detail-fields update", async () => {
  for (const through of ["20261022000100", "20261022000200"]) {
    const db = await createDb({ through });
    try {
      await seedUsers(db);
      const rows = await rowsFromCsv();
      assert.equal(await sqlState(upsert(db, rows)), "23502", `through ${through}: a LinkedIn job id is mandatory`);
      const n = (await asRole(db, USERS.alice, async () => (await db.query("select count(*)::int as n from public.saved_jobs")).rows[0].n));
      assert.equal(n, 0, "nothing half-saved");
    } finally { await db.close(); }
  }
});

test("applying the two migrations in order on top of the live schema keeps existing LinkedIn rows and makes imports possible", async () => {
  const db = await createDb({ through: "20261022000100" });
  try {
    await seedUsers(db);
    const li = { linkedin_job_id: "4400000009", job_url: "https://www.linkedin.com/jobs/view/4400000009/", job_title: "Existing", description: "Keep me", source: "detail", has_full_detail: true };
    await upsert(db, [li]);
    await applyMigration(db, "20261022000200");
    await applyMigration(db, "20261023000100");
    const rows = await rowsFromCsv();
    assert.deepEqual(await upsert(db, rows), { inserted: 3, duplicates: 0 });
    const all = await stored(db);
    const existing = all.find((r) => r.job_title === "Existing");
    assert.deepEqual([existing.provider, existing.linkedin_job_id, existing.description], ["linkedin", "4400000009", "Keep me"]);
    assert.equal(all.length, 4);
  } finally { await db.close(); }
});
