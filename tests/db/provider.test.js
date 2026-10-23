// Migration 20261023000100 (multi-provider identity): data preservation, cross-provider dedup, constraints, security.
// Runs the real migration files in in-process Postgres (PGlite); see harness.js for what is stubbed.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb, applyMigration, seedUsers, asRole, sqlState, jobPayload, USERS } = require("./harness.js");

const { alice, bob, anonA, anonB } = USERS;
const MIGRATION = "20261023000100";
const ANON = { anonymous: true };

let n = 0;
const ghPayload = (over = {}) => {
  n += 1;
  return {
    provider: "greenhouse", external_id: `figma:${5000 + n}`, job_url: `https://boards.greenhouse.io/figma/jobs/${5000 + n}`,
    job_title: "Product Designer", company_name: "Figma", location: "Remote", source: "detail", has_full_detail: true,
    description: "Design things", skills: ["figma"], application_status: "open", ...over,
  };
};

const upsert = (db, uid, jobs, opts) => asRole(db, uid, async () => (await db.query("select public.upsert_saved_jobs($1::jsonb) as r", [JSON.stringify(jobs)])).rows[0].r, opts);
const rows = (db, uid, sql = "select * from public.saved_jobs order by provider, external_id", params = [], opts) => asRole(db, uid, async () => (await db.query(sql, params)).rows, opts);

// ---------------------------------------------------------------- migration preserves existing data
test("migration preserves existing rows, ids, statuses and descriptions, and backfills the LinkedIn identity", async () => {
  const db = await createDb({ through: "20261022000100" });
  try {
    await seedUsers(db);
    const a = jobPayload({ job_title: "A job", description: "Full A", skills: ["x", "y"], application_status: "closed", application_status_text: "No longer accepting applications", scraped_at: "2026-10-22T10:00:00Z" });
    const b = jobPayload({ job_title: "B job", source: "card", has_full_detail: false, description: null });
    await upsert(db, alice, [a, b]);
    await upsert(db, bob, [jobPayload({ job_title: "Bob's job" })]);
    const before = await db.query("select * from public.saved_jobs order by id");
    assert.equal(before.rows.length, 3);

    await applyMigration(db, "20261022000200"); // the detail-fields migration sorts before this one
    await applyMigration(db, MIGRATION);

    const after = await db.query("select * from public.saved_jobs order by id");
    assert.equal(after.rows.length, 3, "no rows lost");
    for (let i = 0; i < before.rows.length; i++) {
      const o = before.rows[i];
      const nw = after.rows[i];
      for (const col of Object.keys(o)) assert.deepEqual(nw[col], o[col], `column ${col} unchanged for row ${o.id}`);
      assert.equal(nw.provider, "linkedin");
      assert.equal(nw.external_id, o.linkedin_job_id);
    }
    assert.equal(after.rows.find((r) => r.job_title === "A job").application_status, "closed");
  } finally { await db.close(); }
});

test("after the migration the OLD payload shape (linkedin_job_id only) still works and merges safely", async () => {
  const db = await createDb({ through: "20261022000100" });
  try {
    await seedUsers(db);
    const j = jobPayload({ description: "Keep me", skills: ["figma"], application_status: "open" });
    await upsert(db, alice, [j]);
    await applyMigration(db, "20261022000200"); // the detail-fields migration sorts before this one
    await applyMigration(db, MIGRATION);
    assert.deepEqual(await upsert(db, alice, [{ linkedin_job_id: j.linkedin_job_id, job_url: j.job_url, source: "card", job_title: "x", description: "", skills: [] }]), { inserted: 0, duplicates: 1 });
    const r = (await rows(db, alice))[0];
    assert.equal(r.description, "Keep me");
    assert.equal(r.application_status, "open");
    assert.deepEqual([r.provider, r.external_id], ["linkedin", j.linkedin_job_id]);
    assert.deepEqual(await upsert(db, alice, [jobPayload()]), { inserted: 1, duplicates: 0 });
  } finally { await db.close(); }
});

// ---------------------------------------------------------------- full schema behaviour
let db;
test.before(async () => { db = await createDb(); await seedUsers(db); });
test.after(async () => db && (await db.close()));
test.beforeEach(async () => { await db.exec("delete from public.saved_jobs"); });

test("non-LinkedIn jobs are stored with provider + external_id and no linkedin_job_id", async () => {
  const g = ghPayload();
  assert.deepEqual(await upsert(db, alice, [g]), { inserted: 1, duplicates: 0 });
  const r = (await rows(db, alice))[0];
  assert.deepEqual([r.provider, r.external_id, r.linkedin_job_id], ["greenhouse", g.external_id, null]);
  assert.equal(r.job_url, g.job_url);
  assert.equal(r.application_status, "open");
});

test("cross-provider de-duplication: same external id under different providers are different jobs; same pair is a duplicate", async () => {
  const li = jobPayload();
  const gh = ghPayload({ external_id: li.linkedin_job_id });
  const file = ghPayload({ provider: "file", external_id: li.linkedin_job_id, job_url: "https://example.com/jobs/1" });
  assert.deepEqual(await upsert(db, alice, [li, gh, file]), { inserted: 3, duplicates: 0 });
  assert.equal((await rows(db, alice)).length, 3);
  assert.deepEqual(await upsert(db, alice, [gh, li]), { inserted: 0, duplicates: 2 });
  assert.equal((await rows(db, alice)).length, 3);
});

test("merge-safe for every provider: later partial data never blanks stored data", async () => {
  const g = ghPayload({ description: "Full text", skills: ["figma", "sketch"], salary: "$10", application_status: "open" });
  await upsert(db, alice, [g]);
  await upsert(db, alice, [{ provider: g.provider, external_id: g.external_id, job_url: g.job_url, source: "card", has_full_detail: false, job_title: "", description: "", skills: [], salary: " ", application_status: null }]);
  const r = (await rows(db, alice))[0];
  assert.equal(r.description, "Full text");
  assert.deepEqual(r.skills, ["figma", "sketch"]);
  assert.equal(r.salary, "$10");
  assert.equal(r.job_title, "Product Designer");
  assert.equal(r.source, "detail");
  assert.equal(r.application_status, "open");
});

test("a status change is applied for non-LinkedIn jobs too (open -> closed)", async () => {
  const g = ghPayload({ application_status: "open" });
  await upsert(db, alice, [g]);
  await upsert(db, alice, [{ ...g, application_status: "closed", application_status_text: "Deadline passed" }]);
  const r = (await rows(db, alice))[0];
  assert.deepEqual([r.application_status, r.application_status_text], ["closed", "Deadline passed"]);
});

test("duplicates inside one batch (same provider + id) keep the detail version; mixed providers count correctly", async () => {
  const g = ghPayload();
  const res = await upsert(db, alice, [{ ...g, source: "card", description: null, has_full_detail: false }, { ...g, description: "Detail wins" }, jobPayload()]);
  assert.deepEqual(res, { inserted: 2, duplicates: 0 });
  assert.equal((await rows(db, alice, "select description from public.saved_jobs where provider='greenhouse'"))[0].description, "Detail wins");
});

// ---------------------------------------------------------------- constraints
test("URL rules: LinkedIn stays strict; other providers allow only well-formed https URLs", async () => {
  const ok = [
    ghPayload({ job_url: "https://boards.greenhouse.io/figma/jobs/1?gh_jid=1" }),
    ghPayload({ provider: "file", job_url: "https://careers.example.co.uk:8443/jobs/123" }),
  ];
  assert.deepEqual(await upsert(db, alice, ok), { inserted: 2, duplicates: 0 });
  const bad = [
    ghPayload({ job_url: "http://example.com/job/1" }),
    ghPayload({ job_url: "javascript:alert(1)" }),
    ghPayload({ job_url: "https://user:pw@example.com/job" }),
    ghPayload({ job_url: "https://example.com/a b" }),
    ghPayload({ job_url: 'https://example.com/"onmouseover="x' }),
    ghPayload({ job_url: "https://example.com/" + "a".repeat(2100) }),
    ghPayload({ company_url: "http://evil.example/x" }),
    jobPayload({ job_url: "https://evil.example/jobs/view/123456/" }),
    jobPayload({ job_url: "https://boards.greenhouse.io/x/jobs/1" }),
    jobPayload({ company_url: "https://example.com/c" }),
  ];
  for (const b of bad) assert.equal(await sqlState(upsert(db, alice, [b])), "23514", JSON.stringify(b).slice(0, 90));
  assert.equal((await rows(db, alice)).length, 2, "rejected batches left nothing behind");
});

test("identity rules: provider/external_id formats and the LinkedIn linkage", async () => {
  for (const b of [ghPayload({ provider: "Green House" }), ghPayload({ provider: "x" }), ghPayload({ external_id: "has space" }), ghPayload({ external_id: "a".repeat(201) }), jobPayload({ linkedin_job_id: "abc" })]) {
    assert.equal(await sqlState(upsert(db, alice, [b])), "23514", JSON.stringify(b).slice(0, 80));
  }
  // Direct inserts that would break the invariant "linkedin_job_id exists only for LinkedIn rows, mirroring external_id".
  const ins = (cols) => asRole(db, alice, () => db.query(`insert into public.saved_jobs (user_id, ${Object.keys(cols).join(",")}) values ($1, ${Object.keys(cols).map((_, i) => `$${i + 2}`).join(",")})`, [alice, ...Object.values(cols)]));
  assert.equal(await sqlState(ins({ provider: "greenhouse", external_id: "a:1", linkedin_job_id: "123456", job_url: "https://x.example/1" })), "23514");
  assert.equal(await sqlState(ins({ provider: "linkedin", external_id: "111111", linkedin_job_id: "222222", job_url: "https://www.linkedin.com/jobs/view/222222/" })), "23514");
  assert.equal(await sqlState(ins({ provider: "linkedin", external_id: "111111", job_url: "https://www.linkedin.com/jobs/view/111111/" })), "23514");
});

test("provider and external_id are immutable, even for the owner (column-level grants)", async () => {
  await upsert(db, alice, [ghPayload()]);
  for (const set of ["provider = 'file'", "external_id = 'other:1'", "linkedin_job_id = '123456'", "user_id = '" + bob + "'"]) {
    assert.equal(await sqlState(asRole(db, alice, () => db.query(`update public.saved_jobs set ${set}`))), "42501", set);
  }
  const ok = await asRole(db, alice, () => db.query("update public.saved_jobs set job_title = 'Renamed'"));
  assert.equal(ok.affectedRows, 1);
});

// ---------------------------------------------------------------- isolation and security
test("owner-only: other users cannot read, update, delete or insert as another user (all providers)", async () => {
  const g = ghPayload();
  await upsert(db, alice, [g, jobPayload()]);
  assert.deepEqual(await rows(db, bob), []);
  const upd = await asRole(db, bob, () => db.query("update public.saved_jobs set job_title = 'hacked'"));
  const del = await asRole(db, bob, () => db.query("delete from public.saved_jobs"));
  assert.equal(upd.affectedRows, 0);
  assert.equal(del.affectedRows, 0);
  assert.equal(await sqlState(asRole(db, bob, () => db.query(
    "insert into public.saved_jobs (user_id, provider, external_id, job_url) values ($1,'greenhouse','x:1','https://x.example/1')", [alice]))), "42501");
  // Bob saving the same job creates his own row, not a duplicate of Alice's.
  assert.deepEqual(await upsert(db, bob, [g]), { inserted: 1, duplicates: 0 });
  assert.equal((await rows(db, alice)).length, 2);
});

test("anonymous-style users are isolated for non-LinkedIn jobs too, and a spoofed user_id is ignored", async () => {
  await upsert(db, anonA, [ghPayload({ job_title: "A's" })], ANON);
  await upsert(db, anonB, [ghPayload({ job_title: "B's", user_id: anonA })], ANON);
  assert.deepEqual((await rows(db, anonA, undefined, [], ANON)).map((r) => r.job_title), ["A's"]);
  assert.deepEqual((await rows(db, anonB, undefined, [], ANON)).map((r) => r.job_title), ["B's"]);
});

test("security posture is unchanged: RLS on, four owner-only policies, no anon/public access, function settings", async () => {
  assert.equal((await db.query("select relrowsecurity from pg_class where oid='public.saved_jobs'::regclass")).rows[0].relrowsecurity, true);
  const pol = (await db.query("select policyname, cmd, roles::text from pg_policies where tablename='saved_jobs' order by policyname")).rows;
  assert.deepEqual(pol.map((p) => p.policyname), ["saved_jobs_delete_own", "saved_jobs_insert_own", "saved_jobs_select_own", "saved_jobs_update_own"]);
  assert.ok(pol.every((p) => p.roles === "{authenticated}"));
  assert.equal(await sqlState(rows(db, null)), "42501");
  assert.equal(await sqlState(upsert(db, null, [ghPayload()])), "42501");
  const f = (await db.query("select prosecdef, proconfig::text from pg_proc where proname='upsert_saved_jobs'")).rows[0];
  assert.equal(f.prosecdef, false);
  assert.match(f.proconfig, /search_path/);
  const grants = (await db.query("select grantee from information_schema.role_routine_grants where routine_name='upsert_saved_jobs' and grantee in ('anon','PUBLIC','authenticated')")).rows.map((r) => r.grantee);
  assert.deepEqual(grants, ["authenticated"]);
  const tableGrants = (await db.query("select grantee from information_schema.role_table_grants where table_name='saved_jobs' and grantee in ('anon','PUBLIC')")).rows;
  assert.deepEqual(tableGrants, []);
  assert.equal(await sqlState(asRole(db, alice, () => db.query("select public.upsert_saved_jobs('[]'::jsonb)"))), null);
});

test("no session -> RPC refuses; unknown payload fields are ignored; size cap still enforced", async () => {
  await db.query("select set_config('request.jwt.claim.sub', '', false)");
  await db.exec("set role authenticated");
  try { assert.equal(await sqlState(db.query("select public.upsert_saved_jobs('[]'::jsonb)")), "28000"); } finally { await db.exec("reset role"); }
  assert.deepEqual(await upsert(db, alice, [{ ...ghPayload(), surprise: "x", user_id: bob }]), { inserted: 1, duplicates: 0 });
  assert.equal(await sqlState(upsert(db, alice, Array.from({ length: 201 }, () => ghPayload()))), "22023");
});
