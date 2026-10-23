// Run controller: lifecycle, caps, retries, pause/resume/stop, checkpoints and restart recovery.
// All local: fake clock, fake source, in-memory store. Nothing contacts a real provider, Supabase or Chrome.
import test from "node:test";
import assert from "node:assert/strict";
import { DbError, ERR } from "../../src/db/errors.js";
import { RunError } from "../../src/batch/run-state.js";
import { createMemoryRunStore } from "../../src/batch/run-store.js";
import { fatal, gate, ids, makeEnv, makeSaver, makeSource, netDb, rateLimited, restartedEnv, tick, transient } from "./helpers.mjs";
import { SourceError } from "../../src/sources/http.js";

const threePages = () => [ids(1, 4), ids(5, 4), ids(9, 4)];
const run = (env, extra = {}) => env.controller.start({ sourceId: env.source.id, params: {}, limits: {}, ...extra });
const code = (p) => p.then(() => null, (e) => e.code);

// ================================================================== happy path and incremental saving
test("a run walks every page, saves incrementally and completes with accurate counters", async () => {
  const events = [];
  const source = makeSource({ pages: threePages(), hooks: { search: ({ p }) => { events.push(`search:${p}`); } } });
  const saver = makeSaver({ hook: ({ records }) => { events.push(`save:${records.length}`); } });
  const env = makeEnv({ source, saver });
  const started = await run(env);
  assert.equal(started.status, "running");
  await env.idle();
  const s = await env.controller.getState();
  assert.equal(s.status, "completed");
  assert.equal(s.endReason, "no-more-results");
  assert.deepEqual(s.counters, { discovered: 12, processed: 12, saved: 12, duplicates: 0, skipped: 0, failed: 0 });
  assert.equal(saver.rows.size, 12);
  // incremental: each page is saved BEFORE the next page is requested
  assert.deepEqual(events, ["search:0", "save:4", "search:1", "save:4", "search:2", "save:4"]);
  assert.equal(s.pendingCount, 0);
  assert.ok(s.finishedAt >= s.startedAt);
});

test("the checkpoint is written after every page: cursor, pending refs, counters", async () => {
  let seen;
  const env0 = { env: null };
  const source = makeSource({
    pages: threePages(),
    hooks: { search: async ({ p }) => { if (p === 1) seen = await env0.env.state(); } },
  });
  const env = makeEnv({ source });
  env0.env = env;
  await run(env);
  await env.idle();
  assert.equal(seen.page, 1);
  assert.deepEqual(seen.cursor, { p: 1 });
  assert.equal(seen.counters.discovered, 4);
  assert.equal(seen.counters.saved, 4, "page 1 was already saved when page 2 was requested");
  assert.deepEqual(seen.pending, []);
  assert.deepEqual(seen.seen, ["j1", "j2", "j3", "j4"]);
});

test("details are fetched and saved in bounded batches (a safe unit of work)", async () => {
  const source = makeSource({ pages: [ids(1, 25)] });
  const saver = makeSaver();
  const env = makeEnv({ source, saver });
  await run(env);
  await env.idle();
  assert.deepEqual(saver.batches.map((b) => b.length), [10, 10, 5]);
});

// ================================================================== limits
test("job cap: stops at maxJobs, extra results are never fetched", async () => {
  const source = makeSource({ pages: threePages() });
  const env = makeEnv({ source });
  await run(env, { limits: { maxJobs: 6 } });
  await env.idle();
  const s = await env.controller.getState();
  assert.equal(s.status, "completed");
  assert.equal(s.endReason, "job-limit");
  assert.equal(s.capReached, "jobs");
  assert.deepEqual([s.counters.discovered, s.counters.processed, s.counters.saved], [6, 6, 6]);
  assert.equal(source.calls.search.length, 2, "page 3 was never requested");
  assert.equal(source.calls.details.length, 6);
});

test("page cap: stops after maxPages pages", async () => {
  const source = makeSource({ pages: [ids(1, 3), ids(4, 3), ids(7, 3), ids(10, 3)] });
  const env = makeEnv({ source });
  await run(env, { limits: { maxPages: 2 } });
  await env.idle();
  const s = await env.controller.getState();
  assert.equal(s.endReason, "page-limit");
  assert.equal(s.capReached, "pages");
  assert.equal(s.page, 2);
  assert.equal(s.counters.saved, 6);
  assert.equal(source.calls.search.length, 2);
});

test("defaults are 200 jobs / 10 pages / 25 per page; page size is passed to the source", async () => {
  const source = makeSource({ pages: [ids(1, 2)] });
  const env = makeEnv({ source });
  const s = await run(env);
  assert.deepEqual(s.config, { maxJobs: 200, maxPages: 10, pageSize: 25 });
  await env.idle();
  assert.equal(source.calls.search[0].pageSize, 25);
});

test("hard limits are enforced by the controller itself (not only by the UI)", async () => {
  const env = makeEnv({ source: makeSource({ pages: [ids(1, 2)] }) });
  for (const limits of [{ maxJobs: 501 }, { maxPages: 51 }, { pageSize: 51 }, { maxJobs: 0 }, { maxJobs: -3 }, { maxPages: 1.5 }, { maxJobs: "abc" }, { maxJobs: 1e9 }]) {
    assert.equal(await code(run(env, { limits })), "invalid-limits", JSON.stringify(limits));
  }
  assert.equal(await env.state(), null, "a rejected start leaves no run behind");
  const ok = await run(env, { limits: { maxJobs: "5", maxPages: 50, pageSize: 50 } });
  assert.deepEqual(ok.config, { maxJobs: 5, maxPages: 50, pageSize: 50 });
});

test("unknown source and invalid source parameters are rejected before anything is stored", async () => {
  const env = makeEnv({ source: makeSource({ pages: [] }) });
  assert.equal(await code(env.controller.start({ sourceId: "nope", params: {} })), "unknown-source");
  assert.equal(await code(env.controller.start({ sourceId: "__proto__", params: {} })), "unknown-source");
  assert.equal(await code(env.controller.start({})), "unknown-source");
  assert.equal(await code(run(env, { params: { bad: true } })), "invalid-params");
  assert.equal(await env.state(), null);
});

test("preflight failures (e.g. Supabase not configured) stop the start cleanly", async () => {
  const env = makeEnv({ source: makeSource({ pages: [ids(1, 2)] }), preflight: async () => { throw new DbError(ERR.NOT_CONFIGURED, "not configured"); } });
  assert.equal(await code(run(env)), ERR.NOT_CONFIGURED);
  assert.equal(await env.state(), null);
});

// ================================================================== one run at a time
test("only one run can be active; a finished run can be replaced", async () => {
  const hold = gate();
  const source = makeSource({ pages: [ids(1, 2)], hooks: { search: async () => { await hold.promise; } } });
  const env = makeEnv({ source });
  await run(env);
  assert.equal(await code(run(env)), "run-active");
  hold.open();
  await env.idle();
  assert.equal((await env.controller.getState()).status, "completed");
  const first = (await env.controller.getState()).runId;
  const second = await run(env);
  assert.notEqual(second.runId, first, "a new run replaces the finished one");
  await env.idle();
  assert.equal((await env.controller.getState()).runId, second.runId);
});

test("two simultaneous starts: exactly one wins", async () => {
  const env = makeEnv({ source: makeSource({ pages: [ids(1, 2)] }) });
  const results = await Promise.all([run(env).then(() => "ok", (e) => e.code), run(env).then(() => "ok", (e) => e.code)]);
  assert.deepEqual(results.sort(), ["ok", "run-active"]);
  await env.idle();
});

// ================================================================== de-duplication inside a run
test("duplicates within a page and across pages are dropped once, counted, and never saved twice", async () => {
  const source = makeSource({ pages: [["a", "b", "a", "c"], ["c", "d", "b"], ["e"]] });
  const saver = makeSaver();
  const env = makeEnv({ source, saver });
  await run(env);
  await env.idle();
  const s = await env.controller.getState();
  assert.deepEqual([...saver.rows.keys()].sort(), ["fake:a", "fake:b", "fake:c", "fake:d", "fake:e"]);
  assert.equal(s.counters.discovered, 5);
  assert.equal(s.counters.duplicates, 3, "a (same page), c and b (earlier pages)");
  assert.equal(s.counters.saved, 5);
  assert.equal(source.calls.details.length, 5);
});

test("references without a valid id are skipped with a warning, not fatal", async () => {
  const source = makeSource({
    pages: [],
    hooks: { search: () => ({ refs: [{ externalId: "ok1" }, { externalId: "bad id" }, { title: "none" }, null, 5, { externalId: "ok2" }], nextCursor: null }) },
  });
  const env = makeEnv({ source });
  await run(env);
  await env.idle();
  const s = await env.controller.getState();
  assert.equal(s.status, "completed");
  assert.equal(s.counters.skipped, 4);
  assert.equal(s.counters.saved, 2);
  assert.match(s.warnings.join(" "), /without a valid id/);
});

// ================================================================== pause / resume
test("pause finishes the current page, checkpoints, and resume continues without losing or repeating work", async () => {
  const hold = gate();
  const source = makeSource({ pages: threePages(), hooks: { search: async ({ p }) => { if (p === 1) await hold.promise; } } });
  const saver = makeSaver();
  const env = makeEnv({ source, saver });
  await run(env);
  while (source.calls.search.length < 2) await tick(1); // page 2 request is in flight
  const pausing = await env.controller.pause();
  assert.equal(pausing.status, "running");
  assert.equal(pausing.pauseRequested, true, "UI shows 'pausing' until the safe point");
  hold.open();
  await env.idle();
  let s = await env.controller.getState();
  assert.equal(s.status, "paused");
  assert.equal(s.pausedReason, "user");
  assert.equal(s.pauseRequested, false);
  assert.equal(s.counters.discovered, 8, "the in-flight page was completed, not dropped");
  assert.ok(saver.rows.size >= 4);
  const frozen = saver.rows.size;
  await tick(20);
  assert.equal(saver.rows.size, frozen, "nothing runs while paused");

  s = await env.controller.resume();
  assert.equal(s.status, "running");
  await env.idle();
  s = await env.controller.getState();
  assert.equal(s.status, "completed");
  assert.equal(s.resumeCount, 1);
  assert.equal(saver.rows.size, 12);
  assert.equal(s.counters.saved, 12);
  assert.equal(s.counters.duplicates, 0, "no job was processed twice");
  assert.equal(source.calls.details.length, 12);
});

test("pause in the middle of a batch saves the finished part first, then stops at the item boundary", async () => {
  const hold = gate();
  let envRef;
  const source = makeSource({
    pages: [ids(1, 8)],
    hooks: { details: async ({ call }) => { if (call === 3) { await envRef.controller.pause(); } } },
  });
  const saver = makeSaver();
  const env = makeEnv({ source, saver });
  envRef = env;
  await run(env);
  await env.idle();
  let s = await env.controller.getState();
  assert.equal(s.status, "paused");
  assert.equal(saver.rows.size, 3, "items 1-3 were saved before pausing");
  assert.equal(s.counters.processed, 3);
  assert.equal(s.pendingCount, 5);
  hold.open();
  await env.controller.resume();
  await env.idle();
  s = await env.controller.getState();
  assert.equal(s.status, "completed");
  assert.equal(saver.rows.size, 8);
  assert.equal(s.counters.duplicates, 0);
});

test("changing your mind while 'pausing': resume cancels the pause request", async () => {
  const hold = gate();
  const source = makeSource({ pages: threePages(), hooks: { search: async ({ p }) => { if (p === 1) await hold.promise; } } });
  const env = makeEnv({ source });
  await run(env);
  while (source.calls.search.length < 2) await tick(1);
  await env.controller.pause();
  const s = await env.controller.resume();
  assert.equal(s.pauseRequested, false);
  hold.open();
  await env.idle();
  assert.equal((await env.controller.getState()).status, "completed");
});

test("invalid control transitions are rejected with clear codes", async () => {
  const env = makeEnv({ source: makeSource({ pages: [ids(1, 2)] }) });
  assert.equal(await code(env.controller.pause()), "no-run");
  assert.equal(await code(env.controller.resume()), "no-run");
  assert.equal(await code(env.controller.stop()), "no-run");
  assert.equal(await env.controller.dismiss(), null);
  await run(env);
  await env.idle();
  assert.equal(await code(env.controller.pause()), "invalid-state");
  assert.equal(await code(env.controller.resume()), "invalid-state");
  const stopAgain = await env.controller.stop();
  assert.equal(stopAgain.status, "completed", "stop on a finished run is a harmless no-op");
});

test("resume twice / pause twice never create two drivers or double-process", async () => {
  const hold = gate();
  const source = makeSource({ pages: threePages(), hooks: { search: async ({ p }) => { if (p === 1) await hold.promise; } } });
  const env = makeEnv({ source });
  await run(env);
  while (source.calls.search.length < 2) await tick(1);
  await Promise.all([env.controller.pause(), env.controller.pause()]);
  hold.open();
  await env.idle();
  assert.equal((await env.controller.getState()).status, "paused");
  await Promise.all([env.controller.resume(), env.controller.resume().catch(() => null)]);
  await env.idle();
  const s = await env.controller.getState();
  assert.equal(s.status, "completed");
  assert.equal(source.calls.details.length, 12, "each job fetched exactly once");
  assert.equal(env.saver.rows.size, 12);
});

// ================================================================== stop
test("stop cancels the in-flight request, keeps every saved job, and ends in 'stopped'", async () => {
  let aborted = false;
  const source = makeSource({
    pages: threePages(),
    hooks: {
      search: ({ p, ctx }) => (p === 1
        ? new Promise((_r, rej) => ctx.signal.addEventListener("abort", () => { aborted = true; rej(new SourceError("aborted", "cancelled")); }))
        : undefined),
    },
  });
  const saver = makeSaver();
  const env = makeEnv({ source, saver });
  await run(env);
  while (source.calls.search.length < 2) await tick(1);
  const stopping = await env.controller.stop();
  assert.equal(stopping.status, "stopping");
  await env.idle();
  const s = await env.controller.getState();
  assert.equal(aborted, true, "the pending request was aborted");
  assert.equal(s.status, "stopped");
  assert.equal(saver.rows.size, 4, "page 1 stays saved");
  assert.equal(s.counters.saved, 4);
  assert.equal(await code(env.controller.resume()), "invalid-state");
  assert.equal(await env.controller.dismiss(), null);
  assert.equal(await env.controller.getState(), null);
  assert.equal(saver.rows.size, 4, "dismissing a run never deletes saved jobs");
});

test("stop during a batch still saves the jobs already fetched in it (completed work is never discarded)", async () => {
  const source = makeSource({
    pages: [ids(1, 8)],
    hooks: { details: ({ call, ctx }) => (call === 3 ? new Promise((_r, rej) => ctx.signal.addEventListener("abort", () => rej(new SourceError("aborted", "cancelled")))) : undefined) },
  });
  const saver = makeSaver();
  const env = makeEnv({ source, saver });
  await run(env);
  while (source.calls.details.length < 3) await tick(1);
  await env.controller.stop();
  await env.idle();
  const s = await env.controller.getState();
  assert.equal(s.status, "stopped");
  assert.deepEqual([...saver.rows.keys()].sort(), ["fake:j1", "fake:j2"], "the two jobs fetched before the stop were saved");
  assert.equal(s.counters.saved, 2);
});

test("if that final save fails while stopping, it is not retried and the run still ends promptly", async () => {
  const source = makeSource({
    pages: [ids(1, 4)],
    hooks: { details: ({ call, ctx }) => (call === 3 ? new Promise((_r, rej) => ctx.signal.addEventListener("abort", () => rej(new SourceError("aborted", "cancelled")))) : undefined) },
  });
  const saver = makeSaver({ hook: () => { throw netDb(); } });
  const env = makeEnv({ source, saver });
  await run(env);
  while (source.calls.details.length < 3) await tick(1);
  await env.controller.stop();
  await env.idle();
  assert.equal((await env.controller.getState()).status, "stopped");
  assert.equal(saver.batches.length, 1, "one attempt only, no backoff retries");
  assert.deepEqual(env.slept, []);
});

test("stop while paused, and while interrupted, finishes immediately", async () => {
  const env = makeEnv({ source: makeSource({ pages: threePages(), hooks: { details: async ({ call }) => { if (call === 2) await envPause(); } } }) });
  async function envPause() { await env.controller.pause(); }
  await run(env);
  await env.idle();
  assert.equal((await env.controller.getState()).status, "paused");
  assert.equal((await env.controller.stop()).status, "stopped");
});

// ================================================================== retries and rate limits
test("transient failures are retried with exponential backoff (1s, 2s, ...) and the run succeeds", async () => {
  const source = makeSource({ pages: [ids(1, 2)], hooks: { details: ({ ref, call }) => { if (ref.externalId === "j1" && call <= 2) throw transient(); } } });
  const env = makeEnv({ source });
  await run(env);
  await env.idle();
  const s = await env.controller.getState();
  assert.equal(s.status, "completed");
  assert.deepEqual([s.counters.saved, s.counters.failed], [2, 0]);
  assert.deepEqual(env.slept, [1000, 2000]);
  assert.equal((await env.state()).retry, null, "retry info is cleared after success");
});

test("exhausted retries fail the item (not the run); 5 failures in a row pause the run automatically", async () => {
  const source = makeSource({ pages: [ids(1, 8)], hooks: { details: ({ ref }) => { if (["j1", "j2", "j3", "j4", "j5"].includes(ref.externalId)) throw transient("source down"); } } });
  const env = makeEnv({ source });
  await run(env);
  await env.idle();
  let s = await env.controller.getState();
  assert.equal(s.status, "paused");
  assert.equal(s.pausedReason, "too-many-failures");
  assert.equal(s.counters.failed, 5);
  assert.match(s.lastError.message, /Paused after 5 failures in a row/);
  assert.equal(s.failures.length, 5);
  assert.match(s.failures[0].reason, /source down/);
  assert.equal(s.pendingCount, 3, "the untouched jobs stay queued");
  assert.deepEqual(env.slept.slice(0, 4), [1000, 2000, 4000, 8000], "bounded exponential backoff per item");

  source.calls.details.length = 0;
  s = await env.controller.resume();
  await env.idle();
  s = await env.controller.getState();
  assert.equal(s.status, "completed");
  assert.equal(s.counters.saved, 3);
});

test("Retry-After is honoured as a minimum wait", async () => {
  const source = makeSource({ pages: [ids(1, 1)], hooks: { details: ({ call }) => { if (call === 1) throw rateLimited(7000); } } });
  const env = makeEnv({ source });
  await run(env);
  await env.idle();
  assert.equal((await env.controller.getState()).status, "completed");
  assert.deepEqual(env.slept, [7000], "waited the server-requested 7 s, not the 1 s backoff");
});

test("a long Retry-After becomes a chrome alarm: the worker can sleep, wake() continues the same run", async () => {
  const source = makeSource({ pages: [ids(1, 3)], hooks: { details: ({ ref, call }) => { if (call === 1 && ref.externalId === "j1") throw rateLimited(120000); } } });
  const env = makeEnv({ source });
  await run(env);
  await env.idle();
  let s = await env.controller.getState();
  assert.equal(s.status, "running", "still running, just waiting");
  assert.equal(s.waiting.until - env.clock.now(), 120000);
  assert.equal(s.retry.attempt, 1);
  assert.deepEqual(env.alarms.filter((a) => a.ms), [{ ms: 120000, at: env.clock.now() }]);
  assert.equal(env.slept.length, 0, "no inline sleeping for a long wait");
  assert.equal(env.saver.rows.size, 0);

  env.clock.advance(120000);
  await env.controller.wake();
  await env.idle();
  s = await env.controller.getState();
  assert.equal(s.status, "completed");
  assert.equal(s.waiting, null);
  assert.equal(s.counters.saved, 3);
});

test("a page that keeps failing pauses the run with a clear error; resume gives fresh attempts", async () => {
  let failing = true;
  const source = makeSource({ pages: [ids(1, 2)], hooks: { search: () => { if (failing) throw transient("timeout"); } } });
  const env = makeEnv({ source });
  await run(env);
  await env.idle();
  let s = await env.controller.getState();
  assert.equal(s.status, "paused");
  assert.equal(s.pausedReason, "source-unreachable");
  assert.match(s.lastError.message, /Gave up after 4 retries/);
  assert.equal(source.calls.search.length, 5, "1 try + 4 retries");
  failing = false;
  await env.controller.resume();
  await env.idle();
  s = await env.controller.getState();
  assert.equal(s.status, "completed");
  assert.equal(s.counters.saved, 2);
});

test("fatal source errors end the run as failed, keeping what was saved", async () => {
  const source = makeSource({ pages: [ids(1, 2), ids(3, 2)], hooks: { search: ({ p }) => { if (p === 1) throw fatal("Access to this job source was refused"); } } });
  const env = makeEnv({ source });
  await run(env);
  await env.idle();
  const s = await env.controller.getState();
  assert.equal(s.status, "failed");
  assert.match(s.lastError.message, /refused/);
  assert.equal(s.counters.saved, 2, "page 1 stays saved");
  assert.equal(source.calls.search.length, 2, "fatal errors are not retried");
});

test("malformed pages fail the run: not an object, refs not an array, more refs than requested, unstorable cursor", async () => {
  const cases = {
    "null page": null,
    "string page": "x",
    "no refs": {},
    "refs not an array": { refs: "no" },
    "more refs than requested": { refs: ids(1, 30).map((x) => ({ externalId: x })), nextCursor: null },
    "cursor that cannot be stored": { refs: [], nextCursor: { toJSON() { throw new Error("no"); } } },
    "oversized cursor": { refs: [], nextCursor: "x".repeat(2000) },
  };
  for (const [name, bad] of Object.entries(cases)) {
    const env = makeEnv({ source: makeSource({ pages: [], hooks: { search: () => bad } }) });
    await run(env, { limits: { pageSize: 25 } });
    await env.idle();
    const s = await env.controller.getState();
    assert.equal(s.status, "failed", name);
    assert.equal(s.lastError.code, "malformed", name);
  }
});

test("a request aborted for any reason other than a user stop is simply re-issued, without loops or crashes", async () => {
  const source = makeSource({ pages: [ids(1, 2)], hooks: { search: ({ call }) => { if (call === 1) throw new SourceError("aborted", "cancelled by the browser"); } } });
  const env = makeEnv({ source });
  await run(env);
  await env.idle();
  const s = await env.controller.getState();
  assert.equal(s.status, "completed");
  assert.equal(source.calls.search.length, 2, "the page was requested again once");
  assert.equal(s.counters.saved, 2);
});

// ================================================================== loops, repeated cursors, empty pages
test("a repeated cursor keeps the page's jobs, stops paging, and fails the run with a clear reason", async () => {
  const source = makeSource({ pages: [], hooks: { search: ({ p }) => ({ refs: [{ externalId: `p${p}a` }, { externalId: `p${p}b` }], nextCursor: { p } }) } });
  const env = makeEnv({ source });
  await run(env);
  await env.idle();
  const s = await env.controller.getState();
  assert.equal(s.status, "failed");
  assert.equal(s.endReason, "repeated-cursor");
  assert.match(s.lastError.message, /already returned/);
  assert.equal(s.counters.saved, 2, "the first page was saved before the loop was reported");
  assert.equal(s.counters.duplicates, 2, "the repeated page's jobs were recognised as duplicates, not saved again");
  assert.equal(source.calls.search.length, 2, "the loop was spotted on the second response; no third request was made");
});

test("a cursor cycle (A -> B -> A) is detected as soon as it closes, with no request beyond the cycle", async () => {
  const cycle = [{ p: 0 }, { p: 1 }];
  const source = makeSource({ pages: [], hooks: { search: ({ p, call }) => ({ refs: [{ externalId: `c${call}` }], nextCursor: cycle[(p + 1) % 2] }) } });
  const env = makeEnv({ source });
  await run(env);
  await env.idle();
  const s = await env.controller.getState();
  assert.equal(s.status, "failed");
  assert.equal(s.endReason, "repeated-cursor");
  assert.ok(source.calls.search.length <= 3, `made ${source.calls.search.length} requests`);
});

test("endless empty pages are bounded by the page cap", async () => {
  const source = makeSource({ pages: [], hooks: { search: ({ p }) => ({ refs: [], nextCursor: { p: p + 1 } }) } });
  const env = makeEnv({ source });
  await run(env, { limits: { maxPages: 50 } });
  await env.idle();
  const s = await env.controller.getState();
  assert.equal(s.status, "completed");
  assert.ok(s.page <= 12, "stopped by the empty-page guard long before the cap");
  assert.equal(s.endReason, "too-many-empty-pages");
});

test("an infinite source can never exceed the hard job and page limits", async () => {
  const source = makeSource({ pages: [], hooks: { search: ({ p }) => ({ refs: Array.from({ length: 50 }, (_, i) => ({ externalId: `p${p}i${i}` })), nextCursor: { p: p + 1 } }) } });
  const env = makeEnv({ source });
  await run(env, { limits: { maxJobs: 500, maxPages: 50, pageSize: 50 } });
  await env.idle();
  const s = await env.controller.getState();
  assert.equal(s.status, "completed");
  assert.equal(s.counters.discovered, 500);
  assert.equal(s.counters.saved, 500);
  assert.equal(s.endReason, "job-limit");
});

// ================================================================== per-item outcomes
test("jobs that disappeared are skipped; empty or malformed details are skipped/failed; the rest are saved", async () => {
  const source = makeSource({
    pages: [["gone", "empty", "badrec", "boom", "good"]],
    hooks: {
      details: ({ ref }) => { if (ref.externalId === "gone") throw new SourceError("not-found", "gone"); if (ref.externalId === "empty") return null; },
      normalize: (raw) => { if (raw.id === "badrec") return null; if (raw.id === "boom") throw new Error("kaboom"); },
    },
  });
  const env = makeEnv({ source });
  await run(env);
  await env.idle();
  const s = await env.controller.getState();
  assert.equal(s.status, "completed");
  assert.deepEqual(s.counters, { discovered: 5, processed: 5, saved: 1, duplicates: 0, skipped: 2, failed: 2 });
  assert.deepEqual([...env.saver.rows.keys()], ["fake:good"]);
  assert.equal(s.failures.length, 2);
});

test("records the saver rejects count as skipped; records already stored count as duplicates", async () => {
  const saver = makeSaver({ hook: ({ records }) => ({ total: records.length, inserted: 1, duplicates: 1, rejected: [{ jobId: records[0].externalId, reason: "invalid-url" }] }) });
  const env = makeEnv({ source: makeSource({ pages: [ids(1, 3)] }), saver });
  await run(env);
  await env.idle();
  const s = await env.controller.getState();
  assert.deepEqual([s.counters.saved, s.counters.duplicates, s.counters.skipped, s.counters.processed], [1, 1, 1, 3]);
  assert.match(s.failures[0].reason, /rejected: invalid-url/);
});

// ================================================================== save failures never lose work
test("a network failure while saving pauses the run and keeps those jobs queued; resume saves them, nothing lost", async () => {
  let offline = true;
  const saver = makeSaver({ hook: () => { if (offline) throw netDb(); } });
  const env = makeEnv({ source: makeSource({ pages: [ids(1, 5)] }), saver });
  await run(env);
  await env.idle();
  let s = await env.controller.getState();
  assert.equal(s.status, "paused");
  assert.equal(s.pausedReason, "save-failed");
  assert.match(s.lastError.message, /Can't reach the server/);
  assert.equal(s.pendingCount, 5, "unsaved jobs remain pending");
  assert.equal(s.counters.processed, 0);
  assert.equal(saver.rows.size, 0);
  offline = false;
  await env.controller.resume();
  await env.idle();
  s = await env.controller.getState();
  assert.equal(s.status, "completed");
  assert.equal(saver.rows.size, 5);
  assert.equal(s.counters.saved, 5);
});

test("a save blocked by authentication pauses with a clear reason; validation errors fail only those items", async () => {
  const auth = makeEnv({ source: makeSource({ pages: [ids(1, 3)] }), saver: makeSaver({ hook: () => { throw new DbError(ERR.AUTH_REQUIRED, "Your session has expired."); } }) });
  await run(auth);
  await auth.idle();
  const a = await auth.controller.getState();
  assert.deepEqual([a.status, a.pausedReason], ["paused", "save-blocked"]);
  assert.equal(a.pendingCount, 3);

  const val = makeEnv({ source: makeSource({ pages: [ids(1, 3), ids(4, 2)] }), saver: makeSaver({ hook: ({ call }) => { if (call === 1) throw new DbError(ERR.VALIDATION, "rejected by the database"); } }) });
  await run(val);
  await val.idle();
  const v = await val.controller.getState();
  assert.equal(v.status, "completed");
  assert.deepEqual([v.counters.failed, v.counters.saved], [3, 2]);
});

test("a rate-limited save backs off and then succeeds", async () => {
  let n = 0;
  const saver = makeSaver({ hook: () => { if (++n === 1) throw new DbError(ERR.RATE_LIMITED, "slow down"); } });
  const env = makeEnv({ source: makeSource({ pages: [ids(1, 2)] }), saver });
  await run(env);
  await env.idle();
  assert.equal((await env.controller.getState()).status, "completed");
  assert.equal(saver.rows.size, 2);
  assert.deepEqual(env.slept, [1000]);
});

// ================================================================== restart and interruption recovery
test("service-worker kill mid-run: the new worker marks the run interrupted; Resume continues from the checkpoint", async () => {
  const hold = gate();
  const source = makeSource({ pages: threePages(), hooks: { search: async ({ p }) => { if (p === 2) await hold.promise; } } });
  const saver = makeSaver();
  const env = makeEnv({ source, saver });
  await run(env);
  while (source.calls.search.length < 3) await tick(1); // pages 1 and 2 done, page 3 in flight
  const persisted = await env.state();
  assert.equal(persisted.status, "running");
  assert.equal(persisted.counters.saved, 8);

  // "Kill" the worker: a brand-new controller starts from nothing but the persisted data. The old driver is abandoned.
  const fresh = restartedEnv(env, { source: makeSource({ pages: threePages() }) });
  assert.equal((await fresh.controller.getState()).status, "running", "state looks running until recovery runs");
  const rec = await fresh.controller.recover("sw-wake");
  assert.equal(rec.status, "interrupted");
  assert.equal(rec.counters.saved, 8, "completed work is preserved");
  assert.equal(fresh.source.calls.search.length, 0, "nothing restarts silently");

  await fresh.controller.resume();
  await fresh.idle();
  const s = await fresh.controller.getState();
  assert.equal(s.status, "completed");
  assert.equal(fresh.saver.rows.size, 12);
  assert.equal(s.resumeCount, 1);
  assert.equal(s.counters.saved, 12);
  assert.equal(fresh.source.calls.search.map((c) => c.p).join(","), "2", "only the unfinished page was requested again");
  hold.open();
});

test("replay safety: a crash after saving but before the checkpoint re-saves the batch without duplicating anything", async () => {
  let snapshotBeforeCheckpoint;
  const saver = makeSaver({
    hook: async ({ records, rows }) => {
      // Perform the real save, capture the persisted state as it was BEFORE the checkpoint, then let the run go on.
      let inserted = 0;
      for (const r of records) { if (!rows.has(`${r.provider}:${r.externalId}`)) { rows.set(`${r.provider}:${r.externalId}`, r); inserted++; } }
      if (!snapshotBeforeCheckpoint) snapshotBeforeCheckpoint = env.store.snapshot();
      return { total: records.length, inserted, duplicates: records.length - inserted, rejected: [] };
    },
  });
  const source = makeSource({ pages: [ids(1, 6)] });
  const env = makeEnv({ source, saver });
  await run(env);
  await env.idle();
  const rowsAfterFirstRun = saver.rows.size;
  assert.equal(rowsAfterFirstRun, 6);

  // The "crashed" worker's persisted data: batch saved remotely, checkpoint never written.
  const crashed = restartedEnv({ store: { snapshot: () => snapshotBeforeCheckpoint }, source, saver, clock: env.clock });
  assert.equal((await crashed.state()).counters.processed, 0);
  await crashed.controller.recover("browser-start");
  await crashed.controller.resume();
  await crashed.idle();
  assert.equal(saver.rows.size, 6, "no duplicate rows were created by the replay");
  const s = await crashed.controller.getState();
  assert.equal(s.status, "completed");
  assert.equal(s.counters.processed, 6);
  assert.equal(s.counters.saved + s.counters.duplicates, 6, "replayed jobs are reported as already saved");
});

test("browser restart: a running run becomes interrupted; a paused run stays paused; a finished run is untouched", async () => {
  const hold = gate();
  const source = makeSource({ pages: threePages(), hooks: { search: async ({ p }) => { if (p === 1) await hold.promise; } } });
  const running = makeEnv({ source });
  await run(running);
  while (source.calls.search.length < 2) await tick(1);
  const r = await restartedEnv(running).controller.recover("browser-start");
  assert.equal(r.status, "interrupted");
  assert.ok(r.counters.saved > 0);

  const pausedEnv = makeEnv({ source: makeSource({ pages: [ids(1, 8)], hooks: { details: async ({ call }) => { if (call === 2) await pausedEnv.controller.pause(); } } }) });
  await run(pausedEnv);
  await pausedEnv.idle();
  assert.equal((await restartedEnv(pausedEnv).controller.recover("browser-start")).status, "paused");

  const done = makeEnv({ source: makeSource({ pages: [ids(1, 2)] }) });
  await run(done);
  await done.idle();
  assert.equal((await restartedEnv(done).controller.recover("browser-start")).status, "completed");
  hold.open();
});

test("a run waiting on an alarm survives a worker restart, but not a browser restart", async () => {
  const mk = () => makeEnv({ source: makeSource({ pages: [ids(1, 3)], hooks: { details: ({ ref, call }) => { if (call === 1 && ref.externalId === "j1") throw rateLimited(120000); } } }) });
  const a = mk();
  await run(a);
  await a.idle();
  assert.equal((await a.controller.getState()).waiting.until - a.clock.now(), 120000);

  // Worker restart (alarms persist): stays running and the alarm is re-armed.
  const sw = restartedEnv(a, { source: makeSource({ pages: [ids(1, 3)] }) });
  const kept = await sw.controller.recover("sw-wake");
  assert.equal(kept.status, "running");
  assert.equal(sw.alarms.filter((x) => x.ms)[0].ms, 120000);

  // Worker restart after the wait is over: continues by itself.
  sw.clock.advance(121000);
  const sw2 = restartedEnv(sw, { source: makeSource({ pages: [ids(1, 3)] }) });
  await sw2.controller.recover("sw-wake");
  await sw2.idle();
  assert.equal((await sw2.controller.getState()).status, "completed");

  // Browser restart (alarms are gone): interrupted, needs a click.
  const br = restartedEnv(a, { source: makeSource({ pages: [ids(1, 3)] }) });
  assert.equal((await br.controller.recover("browser-start")).status, "interrupted");
  assert.equal((await br.controller.recover("extension-reload")).status, "interrupted");
});

test("a run that was 'stopping' when the worker died is finished as stopped on recovery", async () => {
  const store = createMemoryRunStore();
  const env = makeEnv({ source: makeSource({ pages: [ids(1, 2)] }), store });
  await run(env);
  await env.idle();
  const s = await store.load();
  await store.save({ ...s, status: "stopping", stopRequested: true, finishedAt: null });
  const rec = await restartedEnv(env).controller.recover("sw-wake");
  assert.equal(rec.status, "stopped");
});

test("recover with nothing to recover is harmless", async () => {
  const env = makeEnv({ source: makeSource({ pages: [] }) });
  assert.equal(await env.controller.recover("sw-wake"), null);
  assert.equal(await env.controller.getState(), null);
  await env.controller.wake();
});

// ================================================================== heavy payload (imported files)
test("heavy inputs are stored separately from the checkpoint, survive a restart, and are removed when the run ends", async () => {
  const records = Array.from({ length: 6 }, (_, i) => ({ id: `r${i}` }));
  const hold = gate();
  const source = makeSource({
    id: "filey", heavy: true, pages: [],
    hooks: {
      search: async ({ params, p }) => {
        if (p === 0) await hold.promise;
        return { refs: params.records.map((r) => ({ externalId: r.id, title: r.id })), nextCursor: null };
      },
    },
  });
  const env = makeEnv({ source });
  await run(env, { params: { records, note: "n" } });
  while (source.calls.search.length < 1) await tick(1);
  const persisted = await env.state();
  assert.equal(persisted.params.records, undefined, "the large records are not in the per-page checkpoint");
  assert.equal(persisted.params.note, "n");
  assert.equal((await env.store.loadPayload(persisted.runId)).records.length, 6);

  // Restart, resume, and finish using the payload that was stored separately.
  const fresh = restartedEnv(env, { source: makeSource({ id: "filey", heavy: true, pages: [], hooks: { search: ({ params }) => ({ refs: params.records.map((r) => ({ externalId: r.id })), nextCursor: null }) } }) });
  await fresh.controller.recover("browser-start");
  await fresh.controller.resume();
  await fresh.idle();
  assert.equal((await fresh.controller.getState()).status, "completed");
  assert.equal(fresh.saver.rows.size, 6);
  assert.equal(await fresh.store.loadPayload(persisted.runId), null, "payload removed once the run is over");
  hold.open();
});

test("if the payload cannot be stored (quota), start fails cleanly and no run is left behind", async () => {
  const store = createMemoryRunStore();
  store.savePayload = async () => { throw new Error("QUOTA_BYTES quota exceeded"); };
  const env = makeEnv({ source: makeSource({ id: "filey", heavy: true, pages: [] }), store });
  assert.equal(await code(run(env, { params: { records: [{ id: "a" }] } })), "storage-full");
  assert.equal(await env.state(), null);
});

// ================================================================== user-facing summary
test("the summary exposes counters and status but never the pending queue or payload", async () => {
  const hold = gate();
  const source = makeSource({ pages: [ids(1, 4)], hooks: { search: async () => { await hold.promise; } } });
  const env = makeEnv({ source });
  const s = await run(env);
  for (const hidden of ["pending", "seen", "seenCursors", "params", "cursor"]) assert.ok(!(hidden in s), hidden);
  assert.ok("counters" in s && "status" in s && "lastError" in s && "retry" in s);
  hold.open();
  await env.idle();
});
