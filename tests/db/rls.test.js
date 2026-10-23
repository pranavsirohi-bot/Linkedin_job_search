// Migration, RLS and upsert tests against real Postgres semantics (PGlite). See harness.js for what is stubbed.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb, seedUsers, asRole, sqlState, jobPayload, USERS } = require("./harness.js");

const { alice, bob, anonA, anonB } = USERS;
let db;

test.before(async () => {
  db = await createDb();
  await seedUsers(db);
});
test.after(async () => db && (await db.close()));
test.beforeEach(async () => {
  await db.exec("delete from public.saved_jobs"); // superuser session, bypasses RLS
});

const upsert = (uid, jobs) => asRole(db, uid, async () => (await db.query("select public.upsert_saved_jobs($1::jsonb) as r", [JSON.stringify(jobs)])).rows[0].r);
const rows = (uid, sql = "select * from public.saved_jobs order by linkedin_job_id", params = []) =>
  asRole(db, uid, async () => (await db.query(sql, params)).rows);

// ---------------------------------------------------------------- RLS / authorization
test("RLS is enabled on saved_jobs", async () => {
  const r = await db.query("select relrowsecurity from pg_class where oid = 'public.saved_jobs'::regclass");
  assert.equal(r.rows[0].relrowsecurity, true);
});

test("anonymous role cannot read, insert, update or delete (no public access)", async () => {
  const j = jobPayload();
  await upsert(alice, [j]);
  assert.equal(await sqlState(rows(null)), "42501");
  assert.equal(await sqlState(asRole(db, null, () => db.query("insert into public.saved_jobs (user_id, linkedin_job_id, job_url) values ($1,'123456','https://www.linkedin.com/jobs/view/123456/')", [alice]))), "42501");
  assert.equal(await sqlState(asRole(db, null, () => db.query("update public.saved_jobs set job_title='x'"))), "42501");
  assert.equal(await sqlState(asRole(db, null, () => db.query("delete from public.saved_jobs"))), "42501");
});

test("anonymous role cannot call the upsert RPC", async () => {
  assert.equal(await sqlState(upsert(null, [jobPayload()])), "42501");
});

test("cross-user isolation: bob cannot see alice's jobs", async () => {
  await upsert(alice, [jobPayload({ job_title: "Alice only" })]);
  assert.equal((await rows(alice)).length, 1);
  assert.deepEqual(await rows(bob), []);
});

test("cross-user isolation: bob's update and delete of alice's row affect nothing", async () => {
  await upsert(alice, [jobPayload({ job_title: "Alice only" })]);
  const upd = await asRole(db, bob, () => db.query("update public.saved_jobs set job_title = 'hacked'"));
  const del = await asRole(db, bob, () => db.query("delete from public.saved_jobs"));
  assert.equal(upd.affectedRows, 0);
  assert.equal(del.affectedRows, 0);
  assert.equal((await rows(alice))[0].job_title, "Alice only");
});

test("insert with someone else's user_id is rejected by RLS", async () => {
  const code = await sqlState(asRole(db, bob, () => db.query(
    "insert into public.saved_jobs (user_id, linkedin_job_id, job_url) values ($1,'555555','https://www.linkedin.com/jobs/view/555555/')", [alice])));
  assert.equal(code, "42501");
});

test("user_id and identity columns cannot be updated, even on own rows", async () => {
  await upsert(alice, [jobPayload()]);
  for (const col of ["user_id = '" + bob + "'", "linkedin_job_id = '999999'", "created_at = now()", "id = gen_random_uuid()"]) {
    assert.equal(await sqlState(asRole(db, alice, () => db.query(`update public.saved_jobs set ${col}`))), "42501", col);
  }
});

test("user_id comes from the session; a spoofed user_id in the RPC payload is ignored", async () => {
  await upsert(alice, [jobPayload({ user_id: bob })]);
  assert.equal((await rows(alice)).length, 1);
  assert.deepEqual(await rows(bob), []);
});

test("each user keeps their own copy of the same LinkedIn job (dedup is per user)", async () => {
  const j = jobPayload();
  await upsert(alice, [j]);
  await upsert(bob, [j]);
  assert.equal((await rows(alice)).length, 1);
  assert.equal((await rows(bob)).length, 1);
});

test("owner can read, update (allowed columns) and delete own rows", async () => {
  await upsert(alice, [jobPayload()]);
  const u = await asRole(db, alice, () => db.query("update public.saved_jobs set job_title = 'Edited'"));
  assert.equal(u.affectedRows, 1);
  assert.equal((await rows(alice))[0].job_title, "Edited");
  const d = await asRole(db, alice, () => db.query("delete from public.saved_jobs"));
  assert.equal(d.affectedRows, 1);
});

test("deleting the auth user cascades to their saved jobs", async () => {
  const temp = "33333333-3333-3333-3333-333333333333";
  await db.query("insert into auth.users (id, email) values ($1, 'temp@example.com')", [temp]);
  await upsert(temp, [jobPayload()]);
  await db.query("delete from auth.users where id = $1", [temp]);
  assert.equal((await db.query("select count(*)::int c from public.saved_jobs where user_id = $1", [temp])).rows[0].c, 0);
});

// ---------------------------------------------------------------- upsert semantics
test("upsert reports inserted vs duplicates", async () => {
  const a = jobPayload(), b = jobPayload();
  assert.deepEqual(await upsert(alice, [a, b]), { inserted: 2, duplicates: 0 });
  assert.deepEqual(await upsert(alice, [a, jobPayload()]), { inserted: 1, duplicates: 1 });
  assert.equal((await rows(alice)).length, 3);
});

test("re-saving never erases data: empty/missing values keep what is stored", async () => {
  const j = jobPayload({ description: "Full text", skills: ["photoshop", "figma"], salary: "$10", posted_date_approx: "2026-10-20" });
  await upsert(alice, [j]);
  await upsert(alice, [{
    linkedin_job_id: j.linkedin_job_id, job_url: j.job_url, source: "card", has_full_detail: false,
    job_title: "", company_name: null, description: "", skills: [], salary: "   ",
  }]);
  const r = (await rows(alice))[0];
  assert.equal(r.description, "Full text");
  assert.deepEqual(r.skills, ["figma", "photoshop"]);
  assert.equal(r.salary, "$10");
  assert.equal(r.job_title, "Graphic Designer");
  assert.equal(r.company_name, "Acme");
  assert.equal(r.source, "detail"); // a card never downgrades a detail record
  assert.equal(r.has_full_detail, true);
  assert.equal(String(r.posted_date_approx.toISOString?.().slice(0, 10) ?? r.posted_date_approx).slice(0, 10), "2026-10-20");
});

test("non-empty new values do update the stored ones", async () => {
  const j = jobPayload({ job_title: "Old title", has_full_detail: false, source: "card", description: null });
  await upsert(alice, [j]);
  await upsert(alice, [{ ...j, job_title: "New title", description: "Now with detail", source: "detail", has_full_detail: true }]);
  const r = (await rows(alice))[0];
  assert.equal(r.job_title, "New title");
  assert.equal(r.description, "Now with detail");
  assert.equal(r.source, "detail");
  assert.equal(r.has_full_detail, true);
});

test("empty strings are stored as NULL, skills are lower-cased and de-duplicated", async () => {
  await upsert(alice, [jobPayload({ location: "  ", skills: ["Photoshop", "photoshop ", " "], job_title: "T" })]);
  const r = (await rows(alice))[0];
  assert.equal(r.location, null);
  assert.deepEqual(r.skills, ["photoshop"]);
});

test("duplicate IDs inside one batch do not crash and keep the detail version", async () => {
  const j = jobPayload();
  const res = await upsert(alice, [
    { ...j, source: "card", description: null, has_full_detail: false },
    { ...j, source: "detail", description: "Detail wins", has_full_detail: true },
  ]);
  assert.equal(res.inserted, 1);
  assert.equal((await rows(alice))[0].description, "Detail wins");
});

test("updated_at advances on update, created_at does not", async () => {
  const j = jobPayload();
  await upsert(alice, [j]);
  const before = (await rows(alice))[0];
  await new Promise((r) => setTimeout(r, 20));
  await upsert(alice, [{ ...j, job_title: "Changed" }]);
  const after = (await rows(alice))[0];
  assert.ok(after.updated_at > before.updated_at);
  assert.equal(+after.created_at, +before.created_at);
});

// ---------------------------------------------------------------- constraints
test("constraints reject malformed data", async () => {
  const bad = [
    jobPayload({ linkedin_job_id: "abc" }),
    jobPayload({ job_url: "https://evil.example/jobs/view/123456/" }),
    jobPayload({ job_url: "http://www.linkedin.com/jobs/view/123456/" }),
    jobPayload({ company_url: "https://evil.example/company/x/" }),
    jobPayload({ workplace_type: "Underwater" }),
    jobPayload({ employment_type: "Whenever" }),
    jobPayload({ source: "scraper" }),
  ];
  for (const b of bad) assert.equal(await sqlState(upsert(alice, [b])), "23514", JSON.stringify(b).slice(0, 80));
  assert.equal((await rows(alice)).length, 0, "failed batches leave nothing behind");
});

test("batch size cap and non-array payloads are rejected", async () => {
  assert.equal(await sqlState(upsert(alice, Array.from({ length: 201 }, () => jobPayload()))), "22023");
  assert.equal(await sqlState(asRole(db, alice, () => db.query("select public.upsert_saved_jobs('{}'::jsonb)"))), "22023");
});

test("RPC rejects a session without a user", async () => {
  // authenticated role but no sub claim (e.g. malformed token)
  await db.query("select set_config('request.jwt.claim.sub', '', false)");
  await db.exec("set role authenticated");
  try {
    assert.equal(await sqlState(db.query("select public.upsert_saved_jobs('[]'::jsonb)")), "28000");
  } finally {
    await db.exec("reset role");
  }
});

// ---------------------------------------------------------------- search indexes are usable
test("full-text, trigram and skills filters return expected rows", async () => {
  await upsert(alice, [
    jobPayload({ job_title: "Junior Graphic Designer", company_name: "YourfriendlyHR", location: "India", description: "Adobe Photoshop work", skills: ["adobe", "figma"] }),
    jobPayload({ job_title: "Backend Engineer", company_name: "Capgemini", location: "Mumbai Metropolitan Region", description: "Node and SQL", skills: ["sql"] }),
  ]);
  const fts = await rows(alice, "select job_title from public.saved_jobs where search_tsv @@ websearch_to_tsquery('english', $1)", ["designer photoshop"]);
  assert.deepEqual(fts.map((r) => r.job_title), ["Junior Graphic Designer"]);
  const co = await rows(alice, "select job_title from public.saved_jobs where company_name ilike $1", ["%capge%"]);
  assert.deepEqual(co.map((r) => r.job_title), ["Backend Engineer"]);
  const sk = await rows(alice, "select job_title from public.saved_jobs where skills @> $1::text[]", [["adobe", "figma"]]);
  assert.deepEqual(sk.map((r) => r.job_title), ["Junior Graphic Designer"]);
});

// ---------------------------------------------------------------- anonymous users (signInAnonymously)
// Anonymous users hold the same Postgres role as signed-in users ("authenticated"). Isolation therefore depends
// entirely on the user_id policies, which these tests exercise with anonymous-style JWT claims.
const ANON = { anonymous: true };
const upsertAnon = (uid, jobs) => asRole(db, uid, async () => (await db.query("select public.upsert_saved_jobs($1::jsonb) as r", [JSON.stringify(jobs)])).rows[0].r, ANON);
const rowsAnon = (uid, sql = "select * from public.saved_jobs order by linkedin_job_id", params = []) =>
  asRole(db, uid, async () => (await db.query(sql, params)).rows, ANON);

test("anonymous users: each sees only their own saved jobs", async () => {
  await upsertAnon(anonA, [jobPayload({ job_title: "A's job" })]);
  await upsertAnon(anonB, [jobPayload({ job_title: "B's job" })]);
  assert.deepEqual((await rowsAnon(anonA)).map((r) => r.job_title), ["A's job"]);
  assert.deepEqual((await rowsAnon(anonB)).map((r) => r.job_title), ["B's job"]);
});

test("anonymous users: B cannot read, update or delete A's rows", async () => {
  const job = jobPayload({ job_title: "A's private job" });
  await upsertAnon(anonA, [job]);
  assert.deepEqual(await rowsAnon(anonB, "select * from public.saved_jobs where linkedin_job_id = $1", [job.linkedin_job_id]), []);
  const upd = await asRole(db, anonB, () => db.query("update public.saved_jobs set job_title = 'hacked' where linkedin_job_id = $1", [job.linkedin_job_id]), ANON);
  const del = await asRole(db, anonB, () => db.query("delete from public.saved_jobs where linkedin_job_id = $1", [job.linkedin_job_id]), ANON);
  assert.equal(upd.affectedRows, 0);
  assert.equal(del.affectedRows, 0);
  const mine = await rowsAnon(anonA);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].job_title, "A's private job");
});

test("anonymous users: B cannot insert a row owned by A, nor via a spoofed user_id in the RPC payload", async () => {
  const direct = await sqlState(asRole(db, anonB, () => db.query(
    "insert into public.saved_jobs (user_id, linkedin_job_id, job_url) values ($1,'777777','https://www.linkedin.com/jobs/view/777777/')", [anonA]), ANON));
  assert.equal(direct, "42501");
  await upsertAnon(anonB, [jobPayload({ user_id: anonA, userId: anonA })]);
  assert.equal((await rowsAnon(anonA)).length, 0, "nothing landed in A's account");
  assert.equal((await rowsAnon(anonB)).length, 1);
});

test("anonymous users: same LinkedIn job saved by both stays separate and per user", async () => {
  const job = jobPayload({ description: "Shared posting" });
  assert.deepEqual(await upsertAnon(anonA, [job]), { inserted: 1, duplicates: 0 });
  assert.deepEqual(await upsertAnon(anonB, [job]), { inserted: 1, duplicates: 0 }, "B's save is not a duplicate of A's");
  assert.deepEqual(await upsertAnon(anonA, [job]), { inserted: 0, duplicates: 1 });
  assert.equal((await db.query("select count(*)::int c from public.saved_jobs")).rows[0].c, 2);
});

test("anonymous users: identity columns stay immutable for the owner too", async () => {
  await upsertAnon(anonA, [jobPayload()]);
  for (const col of [`user_id = '${anonB}'`, "linkedin_job_id = '999999'"]) {
    assert.equal(await sqlState(asRole(db, anonA, () => db.query(`update public.saved_jobs set ${col}`), ANON)), "42501", col);
  }
});

test("a session whose JWT carries no user id (null uid) can neither read nor write", async () => {
  await upsertAnon(anonA, [jobPayload()]);
  const noSub = { claims: { role: "authenticated", aud: "authenticated" } };
  assert.deepEqual(await asRole(db, "x", async () => (await db.query("select * from public.saved_jobs")).rows, noSub), []);
  assert.equal(await sqlState(asRole(db, "x", () => db.query("select public.upsert_saved_jobs('[]'::jsonb)"), noSub)), "28000");
  const insertCode = await sqlState(asRole(db, "x", () => db.query(
    "insert into public.saved_jobs (linkedin_job_id, job_url) values ('888888','https://www.linkedin.com/jobs/view/888888/')"), noSub));
  assert.ok(["42501", "23502"].includes(insertCode), `insert must be rejected (RLS check or NOT NULL), got ${insertCode}`);
});

test("the unauthenticated 'anon' role (publishable key with no session) is still fully denied", async () => {
  await upsertAnon(anonA, [jobPayload()]);
  assert.equal(await sqlState(rows(null)), "42501");
  assert.equal(await sqlState(upsert(null, [jobPayload()])), "42501");
});

// ---------------------------------------------------------------- application status (migration 20261022000100)
const statusOf = async (uid, id) => (await rows(uid, "select application_status, application_status_text, application_status_at from public.saved_jobs where linkedin_job_id = $1", [id]))[0];

test("status migration: migrations apply in order and the columns exist", async () => {
  const cols = (await db.query("select column_name from information_schema.columns where table_schema='public' and table_name='saved_jobs' and column_name like 'application_status%' order by 1")).rows.map((r) => r.column_name);
  assert.deepEqual(cols, ["application_status", "application_status_at", "application_status_text"]);
});

test("status: stored with its text and observation time", async () => {
  const j = jobPayload({ application_status: "closed", application_status_text: "No longer accepting applications", scraped_at: "2026-10-22T10:00:00Z" });
  await upsert(alice, [j]);
  const r = await statusOf(alice, j.linkedin_job_id);
  assert.equal(r.application_status, "closed");
  assert.equal(r.application_status_text, "No longer accepting applications");
  assert.equal(new Date(r.application_status_at).toISOString(), "2026-10-22T10:00:00.000Z");
});

test("status: an unknown status (missing/empty) never erases a known one", async () => {
  const j = jobPayload({ application_status: "closed", application_status_text: "Closed", scraped_at: "2026-10-22T10:00:00Z" });
  await upsert(alice, [j]);
  await upsert(alice, [{ ...j, application_status: null, application_status_text: null, scraped_at: "2026-10-23T10:00:00Z" }]);
  await upsert(alice, [{ ...j, application_status: "", application_status_text: "", scraped_at: "2026-10-24T10:00:00Z" }]);
  const { application_status, application_status_text, application_status_at } = await statusOf(alice, j.linkedin_job_id);
  assert.equal(application_status, "closed");
  assert.equal(application_status_text, "Closed");
  assert.equal(new Date(application_status_at).toISOString(), "2026-10-22T10:00:00.000Z", "timestamp only moves when a status is observed");
});

test("status: a job can change open -> closed -> open, and the notice text follows", async () => {
  const j = jobPayload({ application_status: "open" });
  await upsert(alice, [j]);
  await upsert(alice, [{ ...j, application_status: "closed", application_status_text: "No longer accepting applications" }]);
  assert.equal((await statusOf(alice, j.linkedin_job_id)).application_status, "closed");
  await upsert(alice, [{ ...j, application_status: "open", application_status_text: null }]);
  const r = await statusOf(alice, j.linkedin_job_id);
  assert.equal(r.application_status, "open");
  assert.equal(r.application_status_text, null, "reopened jobs drop the old closed notice");
});

test("status: card-only saves (no status) leave the detail's status alone; first card-only save is NULL", async () => {
  const j = jobPayload({ application_status: "open" });
  await upsert(alice, [j]);
  await upsert(alice, [{ linkedin_job_id: j.linkedin_job_id, job_url: j.job_url, job_title: "T", source: "card", has_full_detail: false }]);
  assert.equal((await statusOf(alice, j.linkedin_job_id)).application_status, "open");
  const c = jobPayload({ source: "card", has_full_detail: false, description: null });
  await upsert(alice, [c]);
  assert.equal((await statusOf(alice, c.linkedin_job_id)).application_status, null);
});

test("status: invalid values are rejected by the database", async () => {
  assert.equal(await sqlState(upsert(alice, [jobPayload({ application_status: "pending" })])), "23514");
  assert.equal(await sqlState(upsert(alice, [jobPayload({ application_status: "closed", application_status_text: "x".repeat(501) })])), "23514");
});

test("status: isolation still holds (bob cannot see or change alice's status)", async () => {
  const j = jobPayload({ application_status: "closed" });
  await upsert(alice, [j]);
  assert.deepEqual(await rows(bob, "select application_status from public.saved_jobs"), []);
  const upd = await asRole(db, bob, () => db.query("update public.saved_jobs set application_status = 'open'"));
  assert.equal(upd.affectedRows, 0);
  assert.equal((await statusOf(alice, j.linkedin_job_id)).application_status, "closed");
});

test("status: owner may correct it by hand; anonymous role may not touch it", async () => {
  const j = jobPayload({ application_status: "closed" });
  await upsert(alice, [j]);
  const u = await asRole(db, alice, () => db.query("update public.saved_jobs set application_status = 'open', application_status_text = null"));
  assert.equal(u.affectedRows, 1);
  assert.equal((await statusOf(alice, j.linkedin_job_id)).application_status, "open");
  assert.equal(await sqlState(asRole(db, null, () => db.query("update public.saved_jobs set application_status = 'closed'"))), "42501");
});

test("status: earlier behaviour is intact (re-save never blanks description / skills; counts still reported)", async () => {
  const j = jobPayload({ description: "Full text", skills: ["figma"], application_status: "open" });
  assert.deepEqual(await upsert(alice, [j]), { inserted: 1, duplicates: 0 });
  assert.deepEqual(await upsert(alice, [{ linkedin_job_id: j.linkedin_job_id, job_url: j.job_url, source: "card", job_title: "x", skills: [], description: "" }]), { inserted: 0, duplicates: 1 });
  const r = (await rows(alice))[0];
  assert.equal(r.description, "Full text");
  assert.deepEqual(r.skills, ["figma"]);
});

test("status: the replaced function keeps its security settings", async () => {
  const f = (await db.query("select prosecdef, proconfig from pg_proc where proname = 'upsert_saved_jobs'")).rows[0];
  assert.equal(f.prosecdef, false);
  assert.ok(String(f.proconfig).includes("search_path"));
  assert.equal(await sqlState(upsert(null, [jobPayload()])), "42501");
});
