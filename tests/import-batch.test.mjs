// Automatic batch processing of an imported CSV / JSON file: the real file source, the real run controller (Start, Pause,
// Resume, Stop, checkpoints, retries) and the real data layer (toRow / saveJobs) against fakes for Chrome and Supabase.
// Local tests only: not a Chrome test, not a Supabase test.
import test from "node:test";
import assert from "node:assert/strict";
import { createFileSource, parseImportFile } from "../src/sources/file-import.js";
import { makeBatchPreflight, DB_UPDATE_MESSAGE } from "../src/background/preflight.js";
import { DbError, ERR } from "../src/db/errors.js";
import { RunError } from "../src/batch/run-state.js";
import { saveJobs } from "../src/db/saved-jobs.js";
import { fakeClient } from "./db/fake-client.mjs";
import { gate, makeEnv, makeSaver, makeSource, netDb, restartedEnv, tick } from "./batch/helpers.mjs";

const NOW = new Date("2026-10-23T10:00:00Z");
const csv = (rows) => ["title,company,location,url,description,id", ...rows].join("\n");
const row = (n, over = {}) => {
  const f = { title: `Job ${n}`, company: "Acme", location: "Pune", url: `https://careers.example.com/jobs/${n}`, description: `Description of job ${n}`, id: `ext-${n}`, ...over };
  return [f.title, f.company, f.location, f.url, f.description, f.id].map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",");
};
const parse = (rows, opts) => parseImportFile({ name: "jobs.csv", size: 0, text: csv(rows) }, { now: NOW, ...opts });
const many = (n, from = 1) => Array.from({ length: n }, (_, i) => row(from + i));

// Control helpers around the real controller + real file source.
function setup({ saver = makeSaver(), preflight } = {}) {
  const source = createFileSource();
  const env = makeEnv({ source, saver, preflight });
  const start = (parsed, extra = {}) => env.controller.start({
    sourceId: "file",
    params: { records: parsed.records, fileName: "jobs.csv", stats: { total: parsed.total, valid: parsed.records.length, invalid: parsed.rejectedCount, duplicatesInFile: parsed.duplicates, overLimit: parsed.overLimit } },
    limits: { maxJobs: Math.max(parsed.records.length, 1), maxPages: 50, pageSize: 25 },
    ...extra,
  });
  return { env, start, saver };
}

// ------------------------------------------------------------------ processing many records in one run
test("one Start processes every record automatically, in batches, with accurate counters and a real total", async () => {
  const { env, start, saver } = setup();
  const parsed = parse(many(120));
  assert.equal(parsed.records.length, 120);
  const first = await start(parsed);
  assert.equal(first.status, "running");
  await env.idle();
  const s = await env.controller.getState();
  assert.equal(s.status, "completed");
  assert.deepEqual(s.counters, { discovered: 120, processed: 120, saved: 120, duplicates: 0, skipped: 0, failed: 0 });
  assert.equal(s.total, 120);
  assert.equal(saver.rows.size, 120);
  assert.ok(saver.batches.every((b) => b.length <= 10), "saved a few at a time, not in one giant request");
  assert.ok(saver.batches.length >= 12, "incrementally: one confirmed save per batch");
});

test("while it runs the summary names the job being processed next and shows processed / total", async () => {
  const hold = gate();
  const saver = makeSaver({ hook: async ({ call }) => { if (call === 2) await hold.promise; } });
  const { env, start } = setup({ saver });
  await start(parse(many(30)));
  while (saver.batches.length < 2) await tick(1);
  const s = await env.controller.getState();
  assert.equal(s.status, "running");
  assert.equal(s.total, 30);
  assert.equal(s.counters.processed, 10, "the second batch is not counted until the database confirms it");
  assert.deepEqual(s.current, { externalId: "ext-11", title: "Job 11" });
  hold.open();
  await env.idle();
  assert.equal((await env.controller.getState()).current, null, "nothing left once finished");
});

// ------------------------------------------------------------------ validation, deduplication, invalid and partial records
test("invalid records are rejected with a reason and never cost the valid ones; duplicates inside the file are ignored", async () => {
  const rows = [
    row(1),
    row(2, { title: "" }), // no title
    row(3, { url: "javascript:alert(1)" }), // unsafe url
    row(4, { url: "" }), // no url
    row(1), // duplicate of the first
    row(5, { description: "<script>alert(1)</script><p>Real text</p>" }),
  ];
  const parsed = parse(rows);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.records.map((r) => r.externalId), ["ext-1", "ext-5"]);
  assert.equal(parsed.rejectedCount, 3);
  assert.deepEqual(parsed.rejected.map((r) => r.reason).sort(), ["invalid-url", "missing-title", "missing-url"]);
  assert.equal(parsed.duplicates, 1);
  assert.equal(parsed.records[1].description, "Real text", "HTML is stripped, never kept or rendered");
  const { env, start } = setup();
  await start(parsed);
  await env.idle();
  assert.equal((await env.controller.getState()).counters.saved, 2);
});

test("bad input never starts a run: no records, over the limit, or nothing valid", async () => {
  const { env } = setup();
  const bad = [
    { records: undefined }, { records: [] }, { records: [{ title: "", url: "" }, null, 5] },
    { records: Array.from({ length: 501 }, (_, i) => ({ title: `T${i}`, url: `https://x.example/${i}`, __canonical: false })) },
  ];
  for (const params of bad) await assert.rejects(env.controller.start({ sourceId: "file", params, limits: {} }), (e) => e.code === "invalid-params");
  assert.equal(await env.state(), null, "nothing was stored");
  assert.equal(parseImportFile({ name: "x.txt", text: "a" }).ok, false);
  assert.equal(parseImportFile({ name: "x.csv", text: "" }).ok, false);
  assert.equal(parseImportFile({ name: "x.json", text: "{not json" }).ok, false);
  assert.equal(parseImportFile({ name: "x.csv", size: 3 * 1024 * 1024, text: "a,b\n1,2" }).ok, false);
});

test("re-importing the same file updates nothing twice: every record is a duplicate, no new rows", async () => {
  const saver = makeSaver();
  const parsed = parse(many(15));
  const a = setup({ saver });
  await a.start(parsed);
  await a.env.idle();
  assert.equal(saver.rows.size, 15);
  const b = setup({ saver });
  await b.start(parsed);
  await b.env.idle();
  const s = await b.env.controller.getState();
  assert.deepEqual([s.counters.saved, s.counters.duplicates, s.counters.processed], [0, 15, 15]);
  assert.equal(saver.rows.size, 15);
});

test("partial descriptions are saved and reported as partial, never filled in", async () => {
  const parsed = parse([row(1), row(2, { description: "" }), row(3, { company: "" }), row(4)]);
  assert.deepEqual(parsed.records.map((r) => [r.extractionStatus, r.extractionWarnings]), [
    ["complete", []], ["partial", ["missing:description"]], ["partial", ["missing:company"]], ["complete", []],
  ]);
  assert.equal(parsed.records[1].description, "", "no description is invented");
  const { env, start, saver } = setup();
  await start(parsed);
  await env.idle();
  const s = await env.controller.getState();
  assert.deepEqual([s.counters.saved, s.partial], [4, 2]);
  assert.equal(saver.rows.get("file:ext-2").description, "");
});

// ------------------------------------------------------------------ Supabase failures, retries, backoff
test("transient connection errors are retried with exponential backoff, then the run completes", async () => {
  let n = 0;
  const saver = makeSaver({ hook: async () => { if (++n <= 2) throw netDb(); } });
  const { env, start } = setup({ saver });
  await start(parse(many(4)));
  await env.idle();
  const s = await env.controller.getState();
  assert.equal(s.status, "completed");
  assert.deepEqual(env.slept.slice(0, 2), [1000, 2000], "1 s then 2 s");
  assert.deepEqual([s.counters.saved, s.counters.failed], [4, 0]);
});

test("rate limiting (429) is also backed off and retried", async () => {
  let n = 0;
  const saver = makeSaver({ hook: async () => { if (++n === 1) throw new DbError(ERR.RATE_LIMITED, "Too many requests."); } });
  const { env, start } = setup({ saver });
  await start(parse(many(3)));
  await env.idle();
  assert.equal((await env.controller.getState()).status, "completed");
  assert.ok(env.slept.length >= 1 && env.slept[0] >= 1000);
});

test("an outage pauses the run with the real error; Retry continues without duplicates or losses", async () => {
  let down = true;
  const saver = makeSaver({ hook: async ({ call }) => { if (call >= 2 && down) throw netDb(); } });
  const { env, start } = setup({ saver });
  await start(parse(many(25)));
  await env.idle();
  let s = await env.controller.getState();
  assert.equal(s.status, "paused");
  assert.equal(s.pausedReason, "save-failed");
  assert.match(s.lastError.message, /Can't reach the server/);
  assert.equal(s.counters.saved, 10, "only the confirmed batch is counted");
  down = false;
  await env.controller.resume();
  await env.idle();
  s = await env.controller.getState();
  assert.equal(s.status, "completed");
  assert.deepEqual([s.counters.saved, s.counters.duplicates, s.counters.failed], [25, 0, 0]);
  assert.equal(saver.rows.size, 25);
});

test("records the database refuses are counted failed (never saved); repeated refusals pause the run; Resume carries on with the rest", async () => {
  const saver = makeSaver({ hook: async ({ records }) => { if (records.some((r) => r.externalId === "ext-3")) throw new DbError(ERR.VALIDATION, "rejected (23514)"); } });
  const { env, start } = setup({ saver });
  await start(parse(many(25)));
  await env.idle();
  let s = await env.controller.getState();
  assert.equal(s.status, "paused", "10 refusals in a row: the run stops to be looked at instead of ploughing on");
  assert.equal(s.pausedReason, "too-many-failures");
  assert.deepEqual([s.counters.failed, s.counters.saved, saver.rows.size], [10, 0, 0], "nothing refused is ever counted as saved");
  assert.ok(s.failures.length > 0 && /23514/.test(s.failures[0].reason), "the real reason is kept");
  await env.controller.resume();
  await env.idle();
  s = await env.controller.getState();
  assert.equal(s.status, "completed");
  assert.deepEqual([s.counters.saved, s.counters.failed, s.counters.processed, saver.rows.size], [15, 10, 25, 15], "the other 15 were saved; the refused 10 stay reported as failed");
});

// ------------------------------------------------------------------ controls: pause, resume, stop, concurrency, recovery
test("Pause lets the batch in progress finish, then waits; Resume continues; nothing is saved twice", async () => {
  const hold = gate();
  const saver = makeSaver({ hook: async ({ call }) => { if (call === 1) await hold.promise; } });
  const { env, start } = setup({ saver });
  await start(parse(many(30)));
  while (saver.batches.length < 1) await tick(1);
  await env.controller.pause();
  hold.open();
  await env.idle();
  let s = await env.controller.getState();
  assert.equal(s.status, "paused");
  assert.equal(s.pausedReason, "user");
  const savedAtPause = saver.rows.size;
  assert.ok(savedAtPause >= 10 && savedAtPause < 30);
  await env.idle();
  assert.equal(saver.rows.size, savedAtPause, "nothing happens while paused");
  await env.controller.resume();
  await env.idle();
  s = await env.controller.getState();
  assert.equal(s.status, "completed");
  assert.deepEqual([s.counters.saved, s.counters.duplicates], [30, 0]);
});

test("Stop prevents new work, lets the save in flight finish, keeps every saved job and never reports 'completed'", async () => {
  const hold = gate();
  const saver = makeSaver({ hook: async ({ call }) => { if (call === 2) await hold.promise; } });
  const { env, start } = setup({ saver });
  const first = await start(parse(many(40)));
  while (saver.batches.length < 2) await tick(1);
  await env.controller.stop(first.runId);
  hold.open();
  await env.idle();
  const s = await env.controller.getState();
  assert.equal(s.status, "stopped");
  assert.equal(saver.batches.length, 2, "no batch started after Stop");
  assert.equal(saver.rows.size, 20, "the in-flight batch was saved, the rest was not touched");
  assert.equal(s.counters.saved, 20);
  await assert.rejects(env.controller.stop("an-old-run-id"), (e) => e.code === "stale-run");
});

test("a second Start while a run is active is refused, and the running one is untouched", async () => {
  const hold = gate();
  const saver = makeSaver({ hook: async ({ call }) => { if (call === 1) await hold.promise; } });
  const { env, start } = setup({ saver });
  const parsed = parse(many(20));
  const run = await start(parsed);
  const racing = await Promise.allSettled([start(parsed), start(parsed)]);
  assert.ok(racing.every((r) => r.status === "rejected" && r.reason.code === "run-active"));
  assert.equal((await env.controller.getState()).runId, run.runId);
  hold.open();
  await env.idle();
  assert.equal((await env.controller.getState()).counters.saved, 20);
});

test("checkpoint recovery: after a browser restart the run shows as interrupted and Resume finishes it without duplicates", async () => {
  const hold = gate();
  const saver = makeSaver({ hook: async ({ call }) => { if (call === 3) await hold.promise; } });
  const { env, start } = setup({ saver });
  await start(parse(many(50)));
  while (saver.batches.length < 3) await tick(1);
  const before = saver.rows.size; // two confirmed batches
  const reborn = restartedEnv(env, { source: createFileSource(), saver });
  const recovered = await reborn.controller.recover("browser-start");
  assert.equal(recovered.status, "interrupted");
  assert.equal(recovered.counters.saved, before);
  await reborn.controller.resume();
  await reborn.idle();
  hold.open();
  const s = await reborn.controller.getState();
  assert.equal(s.status, "completed");
  assert.equal(s.counters.processed, 50);
  assert.equal(saver.rows.size, 50, "every record exactly once");
});

// ------------------------------------------------------------------ the database must be ready for imported jobs
test("preflight: unavailable configuration, a missing session and a database without the multi-provider update are refused up front", async () => {
  const mk = (over = {}) => makeBatchPreflight({ checkConfig: () => ({ ok: true }), ensureReady: async () => {}, providerColumnsReady: async () => true, ...over });
  await mk()({ sourceId: "file" }); // ready
  await assert.rejects(mk({ checkConfig: () => ({ ok: false, reason: "Supabase project URL is not configured." }) })({ sourceId: "file" }), (e) => e.code === ERR.NOT_CONFIGURED);
  await assert.rejects(mk({ ensureReady: async () => { throw new DbError(ERR.AUTH_FAILED, "no session"); } })({ sourceId: "file" }), (e) => e.code === ERR.AUTH_FAILED);
  const blocked = mk({ providerColumnsReady: async () => false });
  await assert.rejects(blocked({ sourceId: "file" }), (e) => e instanceof RunError && e.code === "database-update-required" && e.message === DB_UPDATE_MESSAGE);
  await blocked({ sourceId: "linkedin-page" }); // LinkedIn-only runs never need it
  await blocked({});
});

test("a refused preflight stores nothing and starts nothing", async () => {
  const preflight = makeBatchPreflight({ checkConfig: () => ({ ok: true }), ensureReady: async () => {}, providerColumnsReady: async () => false });
  const { env, start, saver } = setup({ preflight });
  await assert.rejects(start(parse(many(5))), (e) => e.code === "database-update-required");
  assert.equal(await env.state(), null);
  assert.equal(saver.batches.length, 0);
});

// ------------------------------------------------------------------ the real data layer: imported records -> database rows
test("saveJobs maps imported records to provider 'file' rows with a source-specific id, safe URL and honest status", async () => {
  const sent = [];
  const rows = new Map();
  const client = fakeClient({ onRpc: (_n, args) => {
    let inserted = 0;
    for (const r of args.p_jobs) { sent.push(r); const k = `${r.provider}:${r.external_id}`; if (rows.has(k)) continue; rows.set(k, r); inserted++; }
    return { data: { inserted, duplicates: args.p_jobs.length - inserted }, error: null };
  } });
  const parsed = parse([row(1), row(2, { description: "" }), row(3, { id: "" })]);
  const source = createFileSource();
  const records = parsed.records.map((r) => source.normalize(r));
  const res = await saveJobs(client, records);
  assert.deepEqual([res.inserted, res.duplicates, res.rejected.length], [3, 0, 0]);
  const a = sent.find((r) => r.external_id === "ext-1");
  assert.deepEqual([a.provider, a.linkedin_job_id, a.job_url, a.job_title, a.source, a.has_full_detail, a.extraction_status], ["file", null, "https://careers.example.com/jobs/1", "Job 1", "detail", true, "complete"]);
  const b = sent.find((r) => r.external_id === "ext-2");
  assert.deepEqual([b.description, b.has_full_detail, b.extraction_status, b.extraction_warnings], [null, false, "partial", ["missing:description"]]);
  const c = sent.find((r) => r.job_title === "Job 3");
  assert.match(c.external_id, /^url-[0-9a-f]{16}$/, "no id in the file: a stable id derived from the URL, so re-imports never duplicate");
  // Saving the same records again is all duplicates (the database answers; the key is provider + external id).
  const again = await saveJobs(client, records);
  assert.deepEqual([again.inserted, again.duplicates], [0, 3]);
});

test("JSON import works the same way (array, or an object with a jobs array)", async () => {
  const jobs = [{ title: "A", url: "https://x.example/a", company: "Co", description: "d" }, { jobTitle: "B", link: "https://x.example/b", employer: "Co2" }];
  for (const data of [jobs, { jobs }]) {
    const p = parseImportFile({ name: "jobs.json", text: JSON.stringify(data) }, { now: NOW });
    assert.deepEqual(p.records.map((r) => [r.title, r.company, r.extractionStatus]), [["A", "Co", "complete"], ["B", "Co2", "partial"]]);
  }
});

// ------------------------------------------------------------------ per-record outcomes
test("every record gets an outcome: new, updated, partial, skipped or failed, with a reason where there is one", async () => {
  const saver = makeSaver();
  const parsed = parse([row(1), row(2, { description: "" }), row(3)]);
  const a = setup({ saver });
  await a.start(parsed);
  await a.env.idle();
  const byId = (s) => Object.fromEntries(s.results.map((r) => [r.id, [r.outcome, r.reason]]));
  assert.deepEqual(byId(await a.env.controller.getState()), { "ext-1": ["new", ""], "ext-2": ["partial", "missing:description"], "ext-3": ["new", ""] });
  const b = setup({ saver });
  await b.start(parsed);
  await b.env.idle();
  assert.deepEqual(byId(await b.env.controller.getState()), { "ext-1": ["updated", ""], "ext-2": ["partial", "missing:description"], "ext-3": ["updated", ""] }, "re-import: existing rows are 'updated'");
  assert.equal((await b.env.controller.getState()).results[0].title, "Job 1");
});

test("outcomes the database cannot tell apart are not guessed: a mixed batch is 'saved'; a rejected record is 'skipped' with the reason", async () => {
  const mixed = makeSaver({ hook: async ({ records }) => ({ total: records.length, inserted: 5, duplicates: 5, rejected: [] }) });
  const m = setup({ saver: mixed });
  await m.start(parse(many(10)));
  await m.env.idle();
  assert.deepEqual([...new Set((await m.env.controller.getState()).results.map((r) => r.outcome))], ["saved"]);
  const refusing = makeSaver({ hook: async ({ records }) => ({ total: records.length, inserted: records.length - 1, duplicates: 0, rejected: [{ jobId: "ext-3", reason: "no-usable-fields" }] }) });
  const r = setup({ saver: refusing });
  await r.start(parse(many(5)));
  await r.env.idle();
  const s = await r.env.controller.getState();
  assert.deepEqual(s.results.find((x) => x.id === "ext-3"), { id: "ext-3", title: "Job 3", outcome: "skipped", reason: "rejected: no-usable-fields" });
  assert.equal(s.results.filter((x) => x.outcome === "new").length, 4);
  assert.equal(s.counters.skipped, 1);
});

// ------------------------------------------------------------------ retry failed records
const refuse = (id) => makeSaver({ hook: async ({ records }) => { if (refuse.on && records.some((r) => r.externalId === id)) throw new DbError(ERR.VALIDATION, "rejected (23514)"); } });

test("Retry failed processes only the records that failed, in a new run that remembers where it came from", async () => {
  refuse.on = true;
  const saver = refuse("ext-3");
  const { env, start } = setup({ saver });
  const first = await start(parse(many(25)));
  await env.idle();
  let s = await env.controller.getState();
  assert.deepEqual([s.status, s.failedCount, s.counters.failed, saver.rows.size], ["paused", 10, 10, 0]);
  assert.deepEqual(new Set(s.results.map((r) => r.outcome)), new Set(["failed"]));
  await assert.rejects(env.controller.retryFailed(), (e) => e.code === "run-active", "not while that run is still open");
  await env.controller.stop(first.runId);
  s = await env.controller.getState();
  assert.equal(s.status, "stopped");
  assert.ok(env.store.snapshot()["ljs:run:payload"], "the run's records are kept while there are failures to retry");
  refuse.on = false; // the database accepts them now
  const retry = await env.controller.retryFailed();
  assert.equal(retry.retryOf, first.runId);
  await env.idle();
  s = await env.controller.getState();
  assert.equal(s.status, "completed");
  assert.deepEqual([s.counters.discovered, s.counters.saved, s.counters.failed, s.failedCount], [10, 10, 0, 0], "exactly the 10 that failed, all saved now");
  assert.deepEqual(new Set(s.results.map((r) => r.outcome)), new Set(["new"]));
  assert.equal(saver.rows.size, 10);
  assert.equal(env.store.snapshot()["ljs:run:payload"], undefined, "nothing left to retry: the data is released");
});

test("every failed record is remembered, not only the last 50, and Retry processes all of them", async () => {
  refuse.on = true;
  const saver = makeSaver({ hook: async () => { if (refuse.on) throw new DbError(ERR.VALIDATION, "rejected (23514)"); } });
  const { env, start } = setup({ saver });
  await start(parse(many(60)));
  for (let i = 0; i < 14; i++) {
    await env.idle();
    const st = await env.controller.getState();
    if (st.status === "paused") await env.controller.resume();
    else if (st.status !== "running") break;
  }
  const s = await env.controller.getState();
  assert.equal(s.status, "completed");
  assert.deepEqual([s.counters.failed, s.failedCount], [60, 60]);
  assert.ok((await env.store.load()).failures.length <= 50, "the recent-failure display list stays small; the retry list does not");
  refuse.on = false;
  await env.controller.retryFailed();
  await env.idle();
  const r = await env.controller.getState();
  assert.deepEqual([r.status, r.counters.saved, saver.rows.size], ["completed", 60, 60]);
});

test("Retry failed refuses clearly when there is nothing to retry, no run, an open run, lost data, or an unsupported source", async () => {
  const { env, start } = setup();
  await assert.rejects(env.controller.retryFailed(), (e) => e.code === "no-run");
  await start(parse(many(3)));
  await env.idle();
  await assert.rejects(env.controller.retryFailed(), (e) => e.code === "nothing-to-retry");
  // lost data: failures exist but the kept records are gone
  refuse.on = true;
  const f = setup({ saver: refuse("ext-1") });
  await f.start(parse(many(12)));
  await f.env.idle();
  await f.env.controller.stop((await f.env.controller.getState()).runId);
  await f.env.store.clearPayload();
  await assert.rejects(f.env.controller.retryFailed(), (e) => e.code === "retry-unavailable");
  // a source that cannot rebuild its input
  const fake = makeEnv({ source: { ...makeSource({ pages: [["a", "b"]] }) }, saver: makeSaver({ hook: async () => { throw new DbError(ERR.VALIDATION, "no"); } }) });
  await fake.controller.start({ sourceId: "fake", params: {}, limits: {} });
  await fake.idle();
  const sf = await fake.controller.getState();
  if (sf.status === "paused") await fake.controller.stop(sf.runId);
  await assert.rejects(fake.controller.retryFailed(), (e) => e.code === "retry-unsupported" || e.code === "nothing-to-retry");
});

test("two simultaneous Retry requests start exactly one run", async () => {
  refuse.on = true;
  const saver = refuse("ext-1");
  const { env, start } = setup({ saver });
  await start(parse(many(12)));
  await env.idle();
  await env.controller.stop((await env.controller.getState()).runId);
  refuse.on = false;
  const res = await Promise.allSettled([env.controller.retryFailed(), env.controller.retryFailed()]);
  assert.equal(res.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(res.find((r) => r.status === "rejected").reason.code, "run-active");
  await env.idle();
  assert.equal((await env.controller.getState()).counters.saved, 10);
});

test("the file source rebuilds a retry input from the kept records, nothing else", () => {
  const src = createFileSource();
  const params = { fileName: "jobs.csv", records: parse(many(5)).records };
  const out = src.retryParams(params, ["ext-2", "ext-4", "unknown"]);
  assert.deepEqual(out.records.map((r) => r.externalId), ["ext-2", "ext-4"]);
  assert.deepEqual([out.fileName, out.stats.valid], ["jobs.csv", 2]);
  assert.equal(src.retryParams(params, ["nope"]), null);
  assert.equal(src.retryParams({}, ["ext-1"]), null);
});
