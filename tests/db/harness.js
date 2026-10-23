// In-process Postgres (PGlite) harness for migration + RLS tests.
//
// WHAT THIS IS: real Postgres semantics (RLS, grants, constraints, plpgsql) with the REAL migration files applied.
// WHAT THIS IS NOT: Supabase. The pieces Supabase provides outside our migrations are stubbed below:
//   auth.users, auth.uid(), the anon/authenticated roles, and Supabase's default table grants.
// PostgREST, GoTrue and JWT verification are not exercised. Passing here does not prove the live project works.
const fs = require("node:fs");
const path = require("node:path");

const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "supabase", "migrations");

const SUPABASE_STUB = `
  create schema extensions;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text unique);

  -- Mirrors Supabase's auth.uid(): reads the JWT claims PostgREST sets per request.
  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $$;

  create role anon nologin;
  create role authenticated nologin;
  grant usage on schema public, auth, extensions to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;

  -- Supabase grants new public tables/functions to anon + authenticated by default. Reproduce that so the
  -- migration's explicit REVOKEs are actually exercised.
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
`;

// createDb({ through: "20261022000100" }) applies migrations up to and including that prefix so a test can create
// "old" data and then apply later migrations with applyMigration().
async function createDb({ through } = {}) {
  const { PGlite } = await import("@electric-sql/pglite");
  const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
  const db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(SUPABASE_STUB);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (through && f.slice(0, through.length) > through) break;
    await db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"));
  }
  return db;
}

async function applyMigration(db, prefix) {
  const f = fs.readdirSync(MIGRATIONS_DIR).find((n) => n.startsWith(prefix));
  if (!f) throw new Error(`no migration starting with ${prefix}`);
  await db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"));
}

const USERS = {
  alice: "11111111-1111-1111-1111-111111111111",
  bob: "22222222-2222-2222-2222-222222222222",
  // Anonymous Supabase users (signInAnonymously): role "authenticated", JWT claim is_anonymous = true.
  anonA: "aaaaaaaa-0000-4000-8000-00000000000a",
  anonB: "bbbbbbbb-0000-4000-8000-00000000000b",
};

async function seedUsers(db) {
  for (const [name, id] of Object.entries(USERS)) {
    await db.query("insert into auth.users (id, email) values ($1, $2) on conflict do nothing", [id, `${name}@example.com`]);
  }
}

// Run fn with the session acting as `authenticated` user `uid` (or `anon` when uid is null).
// { anonymous: true } reproduces an anonymous-auth user the way PostgREST presents it: the user id only in the
// request.jwt.claims JSON (with is_anonymous = true), role "authenticated". { claims } overrides the JSON entirely.
async function asRole(db, uid, fn, { anonymous = false, claims } = {}) {
  if (anonymous || claims) {
    const json = claims ?? { sub: uid, role: "authenticated", aud: "authenticated", is_anonymous: true };
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
    await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(json)]);
  } else {
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [uid || ""]);
    await db.query("select set_config('request.jwt.claims', '', false)");
  }
  await db.exec(uid || claims ? "set role authenticated" : "set role anon");
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
    await db.query("select set_config('request.jwt.claims', '', false)");
  }
}

// Expect a promise to reject with a Postgres error code (e.g. 42501 insufficient_privilege).
async function sqlState(promise) {
  try {
    await promise;
    return null;
  } catch (e) {
    return e.code || e.message;
  }
}

let n = 0;
function jobPayload(overrides = {}) {
  n += 1;
  const id = String(4400000000 + n);
  return {
    linkedin_job_id: id,
    job_url: `https://www.linkedin.com/jobs/view/${id}/`,
    job_title: "Graphic Designer",
    company_name: "Acme",
    location: "India",
    source: "detail",
    has_full_detail: true,
    description: "Design things",
    skills: ["photoshop"],
    ...overrides,
  };
}

module.exports = { createDb, applyMigration, seedUsers, asRole, sqlState, jobPayload, USERS };
