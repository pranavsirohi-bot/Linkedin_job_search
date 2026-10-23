// The "current LinkedIn page" source and the controller features it relies on: small save batches, run-id guarded
// Stop, inline retry waits without chrome.alarms.
import test from "node:test";
import assert from "node:assert/strict";
import { createLinkedInPageSource, LINKEDIN_PAGE_LIMITS } from "../../src/sources/linkedin-page.js";
import { assertJobSource } from "../../src/sources/registry.js";
import { toRow } from "../../src/db/job-mapper.js";
import { DbError, ERR } from "../../src/db/errors.js";
import { createRunController } from "../../src/batch/run-controller.js";
import { createMemoryRunStore } from "../../src/batch/run-store.js";
import { gate, makeEnv, makeSaver, tick } from "./helpers.mjs";

const card = (id, over = {}) => ({ source: "card", jobId: String(id), url: `https://www.linkedin.com/jobs/view/${id}/`, title: `Job ${id}`, company: "Acme", location: "Pune", ...over });
const detail = (id, over = {}) => ({ source: "detail", jobId: String(id), url: `https://www.linkedin.com/jobs/view/${id}/`, title: `Job ${id}`, company: "Acme", description: `About job ${id}`, ...over });

// ------------------------------------------------------------------ the source
test("it is a valid job source that never fetches anything and saves in batches of 5", () => {
  const s = assertJobSource(createLinkedInPageSource());
  assert.equal(s.id, "linkedin-page");
  assert.equal(s.detailBatch, 5);
  assert.deepEqual(s.heavyParams, ["records"]);
  assert.equal(LINKEDIN_PAGE_LIMITS.maxRecords, 500);
});

test("validateParams merges the card and the open job with the same id (details win, nothing is lost)", () => {
  const s = createLinkedInPageSource();
  const v = s.validateParams({ records: [card(4400000001, { location: "Pune" }), card(4400000002), detail(4400000001, { location: "", workplaceType: "Remote" })], pageUrl: "https://www.linkedin.com/jobs/search-results/?x=1" });
  assert.equal(v.ok, true);
  assert.equal(v.params.records.length, 2);
  const merged = v.params.records.find((r) => r.jobId === "4400000001");
  assert.deepEqual([merged.source, merged.description, merged.location, merged.workplaceType], ["detail", "About job 4400000001", "Pune", "Remote"]);
  assert.deepEqual(v.params.stats, { found: 2, withDetails: 1, invalid: 0 });
  assert.equal(v.params.pageUrl, "https://www.linkedin.com/jobs/search-results/?x=1");
});

test("validateParams rejects empty snapshots and bad ids, never trusts provider/externalId, caps at 500", () => {
  const s = createLinkedInPageSource();
  assert.equal(s.validateParams({}).ok, false);
  assert.equal(s.validateParams({ records: [] }).ok, false);
  assert.equal(s.validateParams({ records: [card("abc"), { jobId: 5 }, null, "x"] }).ok, false);
  const v = s.validateParams({ records: [card(4400000001, { provider: "greenhouse", externalId: "evil:1" }), card("bad id")], pageUrl: "https://evil.example/" });
  assert.equal(v.params.records.length, 1);
  assert.ok(!("provider" in v.params.records[0]) && !("externalId" in v.params.records[0]), "identity stays the LinkedIn job id");
  assert.equal(v.params.stats.invalid, 1);
  assert.equal(v.params.pageUrl, "", "only LinkedIn page URLs are kept");
  const many = Array.from({ length: 700 }, (_, i) => card(4400000000 + i));
  assert.equal(s.validateParams({ records: many }).params.records.length, 500);
  assert.equal(s.validateParams({ records: Array.from({ length: 1001 }, (_, i) => card(4400000000 + i)) }).ok, false);
});

test("search pages through the snapshot; getDetails returns the stored record; records pass the database mapper", async () => {
  const s = createLinkedInPageSource();
  const { params } = s.validateParams({ records: Array.from({ length: 7 }, (_, i) => card(4400000000 + i)) });
  const p1 = await s.search(params, null, { pageSize: 5 });
  assert.equal(p1.refs.length, 5);
  assert.deepEqual(p1.nextCursor, { o: 5 });
  const p2 = await s.search(params, p1.nextCursor, { pageSize: 5 });
  assert.deepEqual([p2.refs.length, p2.nextCursor], [2, null]);
  const raw = await s.getDetails(p2.refs[1], { params });
  assert.equal(raw.jobId, "4400000006");
  assert.equal(await s.getDetails({ externalId: "9999999999", index: 0 }, { params }), null);
  const m = toRow(s.normalize(raw));
  assert.equal(m.ok, true);
  assert.equal(m.row.linkedin_job_id, "4400000006");
  assert.equal(s.describeCursor({ o: 5 }), "record 6 of this page");
});

// ------------------------------------------------------------------ the controller with this source
const env = (saver = makeSaver(), extra = {}) => {
  const src = createLinkedInPageSource();
  return makeEnv({ sources: new Map([[src.id, src]]), source: src, saver, ...extra });
};
const records = (n) => Array.from({ length: n }, (_, i) => card(4400000000 + i));
const start = (e, n, extra = {}) => e.controller.start({ sourceId: "linkedin-page", params: { records: records(n) }, limits: { maxJobs: Math.min(n, 500), maxPages: 10, pageSize: 50 }, ...extra });

// makeSaver keys rows by provider:externalId; LinkedIn records carry only jobId, so key by jobId here.
const linkedInSaver = (hook) => {
  const s = makeSaver({ hook: async (ctx) => {
    if (hook) { const r = await hook(ctx); if (r !== undefined) return r; }
    let inserted = 0;
    for (const rec of ctx.records) if (!ctx.rows.has(rec.jobId)) { ctx.rows.set(rec.jobId, rec); inserted++; }
    return { total: ctx.records.length, inserted, duplicates: ctx.records.length - inserted, rejected: [] };
  } });
  return s;
};

test("the run saves in batches of 5 and counts only what the saver confirmed", async () => {
  const saver = linkedInSaver();
  const e = env(saver);
  await start(e, 12);
  await e.idle();
  const s = await e.controller.getState();
  assert.deepEqual(saver.batches.map((b) => b.length), [5, 5, 2]);
  assert.deepEqual(s.counters, { discovered: 12, processed: 12, saved: 12, duplicates: 0, skipped: 0, failed: 0 });
  assert.equal(s.status, "completed");
});

test("Stop with the run's id cancels it; with an old id it is refused and the newer run is untouched", async () => {
  const hold = gate();
  const saver = linkedInSaver(async ({ call }) => { if (call === 2) await hold.promise; });
  const e = env(saver);
  const first = await start(e, 3);
  await e.idle();
  const second = await start(e, 12);
  while (saver.batches.length < 2) await tick(1);
  await assert.rejects(e.controller.stop(first.runId), (err) => err.code === "stale-run");
  assert.equal((await e.controller.getState()).status, "running", "the stale Stop did not affect the new run");
  await e.controller.stop(second.runId);
  hold.open();
  await e.idle();
  const s = await e.controller.getState();
  assert.equal(s.status, "stopped");
  // Saver call 1 was the first run; call 2 (held) is the second run's first batch. It finishes, nothing more starts.
  assert.equal(saver.batches.length, 2, "no batch was started after the Stop");
  assert.deepEqual([s.counters.processed, s.counters.saved, s.counters.duplicates], [5, 2, 3], "3 of the 5 were already saved by the first run");
  assert.equal(saver.rows.size, 5);
});

test("dismiss with an old run id is refused", async () => {
  const e = env(linkedInSaver());
  const a = await start(e, 2);
  await e.idle();
  const b = await start(e, 2);
  await e.idle();
  await assert.rejects(e.controller.dismiss(a.runId), (err) => err.code === "stale-run");
  assert.equal(await e.controller.dismiss(b.runId), null);
});

test("without chrome.alarms, a long retry wait happens inline instead of parking the run forever", async () => {
  let n = 0;
  const saver = linkedInSaver(() => { if (++n <= 4) throw new DbError(ERR.NETWORK, "Can't reach the server."); });
  const src = createLinkedInPageSource();
  let t = 0;
  const slept = [];
  const controller = createRunController({
    store: createMemoryRunStore(), sources: { get: () => src }, save: saver, now: () => t, random: () => 1, // max jitter
    sleep: async (ms) => { slept.push(ms); t += ms; }, paceMs: 0, // no alarms passed
  });
  await controller.start({ sourceId: "linkedin-page", params: { records: records(2) }, limits: { maxJobs: 2 } });
  for (let i = 0; i < 6; i++) { await controller.whenIdle(); await tick(0); }
  const s = await controller.getState();
  assert.equal(s.status, "completed");
  assert.equal(s.waiting, null);
  assert.ok(slept.some((ms) => ms > 10000), `slept ${slept.join(",")}: the 4th backoff exceeds 10 s and still ran inline`);
  assert.equal(s.counters.saved, 2);
});

// ------------------------------------------------------------------ leftover runs from a source that is no longer enabled
const leftover = (status) => ({
  v: 1, runId: "old-greenhouse-run", status, sourceId: "greenhouse", params: { boards: ["figma"] },
  config: { maxJobs: 200, maxPages: 10, pageSize: 25, detailBatch: 10 }, cursor: { b: 0, o: 25 }, pending: [{ externalId: "figma:1" }],
  seen: [], seenCursors: [], counters: { discovered: 30, processed: 25, saved: 25, duplicates: 0, skipped: 0, failed: 0 },
  failures: [], warnings: [], page: 1, emptyPages: 0, exhausted: false, consecutiveFailures: 0, pauseRequested: false,
  stopRequested: false, retry: null, waiting: null, lastError: null, resumeCount: 0,
});

for (const status of ["running", "paused", "interrupted", "stopping"]) {
  test(`start-up recovery closes a '${status}' run whose source is no longer enabled (it can never block Start)`, async () => {
    const e = env(linkedInSaver());
    await e.store.save(leftover(status));
    const r = await e.controller.recover("sw-wake");
    assert.equal(r.status, "stopped");
    assert.equal(r.endReason, "source-unavailable");
    assert.equal(r.counters.saved, 25, "its history is kept; saved jobs are never touched");
    const s = await start(e, 3);
    assert.equal(s.status, "running");
    await e.idle();
    assert.equal((await e.controller.getState()).counters.saved, 3);
  });
}

test("even before recovery runs, a leftover run from a disabled source does not block Start", async () => {
  const e = env(linkedInSaver());
  await e.store.save(leftover("paused"));
  const s = await start(e, 2);
  assert.equal(s.sourceId, "linkedin-page");
  await e.idle();
  assert.equal((await e.controller.getState()).status, "completed");
});

test("an active run of the enabled source still blocks a second Start, with a message that matches the popup", async () => {
  const hold = gate();
  const e = env(linkedInSaver(async () => { await hold.promise; }));
  await start(e, 6);
  await assert.rejects(start(e, 2), (err) => err.code === "run-active" && err.message === "A run is already in progress. Stop it first.");
  hold.open();
  await e.idle();
});
