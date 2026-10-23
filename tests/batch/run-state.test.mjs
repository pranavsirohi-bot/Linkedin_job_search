import test from "node:test";
import assert from "node:assert/strict";
import { MAX_RETRY_AFTER_MS, computeDelay } from "../../src/batch/backoff.js";
import { ACTIVE_STATUSES, DEFAULT_LIMITS, HARD_LIMITS, STATUS, TERMINAL_STATUSES, canTransition, newRunState, summarize, validateLimits } from "../../src/batch/run-state.js";
import { PAYLOAD_KEY, RUN_KEY, createChromeRunStore, createMemoryRunStore } from "../../src/batch/run-store.js";

// ------------------------------------------------------------------ backoff
test("backoff doubles per attempt up to the cap, with zero jitter at random=0.5", () => {
  const mid = () => 0.5;
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((n) => computeDelay(n, {}, mid)), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

test("jitter stays within +/-30% and never goes negative", () => {
  for (let n = 1; n <= 6; n++) {
    const base = Math.min(30000, 1000 * 2 ** (n - 1));
    const lo = computeDelay(n, {}, () => 0);
    const hi = computeDelay(n, {}, () => 1);
    assert.ok(lo >= Math.floor(base * 0.7) - 1 && lo <= base, `n=${n} lo=${lo}`);
    assert.ok(hi <= Math.ceil(base * 1.3) + 1 && hi >= base, `n=${n} hi=${hi}`);
    assert.ok(lo >= 0);
  }
  assert.equal(computeDelay(1, { baseMs: 0 }, Math.random), 0);
});

test("Retry-After is a floor, capped at one hour; junk values are ignored", () => {
  const mid = () => 0.5;
  assert.equal(computeDelay(1, { retryAfterMs: 5000 }, mid), 5000);
  assert.equal(computeDelay(3, { retryAfterMs: 500 }, mid), 4000, "the exponential delay wins when it is longer");
  assert.equal(computeDelay(1, { retryAfterMs: 1e12 }, mid), MAX_RETRY_AFTER_MS);
  for (const junk of [null, undefined, NaN, -5, 0, "x"]) assert.equal(computeDelay(2, { retryAfterMs: junk }, mid), 2000, String(junk));
  assert.equal(computeDelay(0, {}, mid), 1000);
  assert.equal(computeDelay(-4, {}, mid), 1000);
  assert.equal(computeDelay(2.9, {}, mid), 2000, "attempts are rounded down to whole numbers (2.9 -> attempt 2)");
});

// ------------------------------------------------------------------ limits
test("limits: defaults, valid values, and rejection (not clamping) beyond the hard maximums", () => {
  assert.deepEqual(validateLimits().limits, DEFAULT_LIMITS);
  assert.deepEqual(validateLimits({}).limits, { maxJobs: 200, maxPages: 10, pageSize: 25 });
  assert.deepEqual(validateLimits({ maxJobs: "30", maxPages: 3, pageSize: null }).limits, { maxJobs: 30, maxPages: 3, pageSize: 25 });
  assert.deepEqual(validateLimits({ maxJobs: HARD_LIMITS.maxJobs, maxPages: HARD_LIMITS.maxPages, pageSize: HARD_LIMITS.pageSize }).limits, { maxJobs: 500, maxPages: 50, pageSize: 50 });
  for (const bad of [{ maxJobs: 501 }, { maxPages: 51 }, { pageSize: 51 }, { maxJobs: 0 }, { maxJobs: -1 }, { maxPages: 2.5 }, { maxJobs: "x" }, { maxJobs: NaN }, { maxJobs: Infinity }]) {
    const r = validateLimits(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(r.errors.length >= 1);
  }
  assert.ok(Object.isFrozen(HARD_LIMITS) && Object.isFrozen(DEFAULT_LIMITS));
});

test("limits: extra or hostile keys in the input are ignored", () => {
  const r = validateLimits({ maxJobs: 5, __proto__: { maxJobs: 9999 }, constructor: "x", detailBatch: 9999, paceMs: 0 });
  assert.deepEqual(r.limits, { maxJobs: 5, maxPages: 10, pageSize: 25 });
});

// ------------------------------------------------------------------ state machine
test("legal and illegal transitions", () => {
  const ok = [["idle", "running"], ["running", "paused"], ["running", "stopping"], ["running", "completed"], ["running", "failed"], ["running", "interrupted"],
    ["paused", "running"], ["paused", "stopped"], ["interrupted", "running"], ["interrupted", "stopped"], ["stopping", "stopped"], ["completed", "idle"], ["stopped", "idle"], ["failed", "idle"]];
  for (const [a, b] of ok) assert.equal(canTransition(a, b), true, `${a} -> ${b}`);
  const bad = [["completed", "running"], ["stopped", "running"], ["failed", "running"], ["paused", "completed"], ["stopping", "running"], ["idle", "paused"], ["completed", "paused"], ["nonsense", "running"]];
  for (const [a, b] of bad) assert.equal(canTransition(a, b), false, `${a} -> ${b}`);
  assert.deepEqual([...ACTIVE_STATUSES].sort(), ["interrupted", "paused", "running", "stopping"]);
  assert.deepEqual([...TERMINAL_STATUSES].sort(), ["completed", "failed", "stopped"]);
  assert.equal(Object.keys(STATUS).length, 8);
});

test("a new run starts RUNNING with zeroed counters, the hard detail batch size, and no secrets", () => {
  const s = newRunState({ runId: "r1", now: 5, sourceId: "greenhouse", params: { boards: ["figma"] }, limits: { maxJobs: 7, maxPages: 2, pageSize: 3 } });
  assert.equal(s.status, "running");
  assert.deepEqual(s.counters, { discovered: 0, processed: 0, saved: 0, duplicates: 0, skipped: 0, failed: 0 });
  assert.deepEqual(s.config, { maxJobs: 7, maxPages: 2, pageSize: 3, detailBatch: HARD_LIMITS.detailBatch });
  assert.deepEqual([s.pending, s.seen, s.seenCursors, s.failures, s.warnings], [[], [], [], [], []]);
  assert.deepEqual([s.cursor, s.exhausted, s.pauseRequested, s.stopRequested, s.retry, s.waiting, s.lastError], [null, false, false, false, null, null, null]);
});

test("summarize is a safe view: counters/status only, no queue, cursor, params or seen ids", () => {
  const s = newRunState({ runId: "r1", now: 5, sourceId: "file", params: { fileName: "x.csv" }, limits: { maxJobs: 7, maxPages: 2, pageSize: 3 } });
  s.pending = [{ externalId: "a" }, { externalId: "b" }];
  s.seen = ["a", "b"];
  s.cursor = { o: 3 };
  s.retry = { key: "item:a", attempt: 2, until: 99, reason: "net" };
  const v = summarize(s);
  assert.equal(v.pendingCount, 2);
  assert.deepEqual(v.retry, { attempt: 2, until: 99, reason: "net" });
  for (const hidden of ["pending", "seen", "seenCursors", "params", "cursor", "v", "createdAt"]) assert.ok(!(hidden in v), hidden);
  assert.equal(summarize(null), null);
  v.counters.saved = 99;
  assert.equal(s.counters.saved, 0, "the summary is a copy");
});

// ------------------------------------------------------------------ stores
test("memory store: round-trips, isolates copies, scopes payloads to their run, snapshots", async () => {
  const st = createMemoryRunStore();
  assert.equal(await st.load(), null);
  const state = { runId: "r1", status: "running", counters: { saved: 1 } };
  await st.save(state);
  state.counters.saved = 50;
  assert.equal((await st.load()).counters.saved, 1, "stored copy is independent");
  await st.savePayload("r1", { records: [1, 2] });
  assert.deepEqual(await st.loadPayload("r1"), { records: [1, 2] });
  assert.equal(await st.loadPayload("other-run"), null, "a payload only belongs to its own run");
  const copy = createMemoryRunStore(st.snapshot());
  assert.equal((await copy.load()).runId, "r1");
  await st.clear();
  await st.clearPayload();
  assert.equal(await st.load(), null);
  assert.equal(await st.loadPayload("r1"), null);
  assert.equal((await copy.load()).runId, "r1", "snapshots are independent of the original");
});

test("chrome store: uses the documented keys on chrome.storage.local semantics", async () => {
  const mem = {};
  const area = {
    get: async (k) => (k in mem ? { [k]: mem[k] } : {}),
    set: async (o) => Object.assign(mem, o),
    remove: async (k) => { delete mem[k]; },
  };
  const st = createChromeRunStore(area);
  assert.equal(await st.load(), null);
  await st.save({ runId: "r1" });
  await st.savePayload("r1", { a: 1 });
  assert.deepEqual(Object.keys(mem).sort(), [PAYLOAD_KEY, RUN_KEY].sort());
  assert.equal((await st.load()).runId, "r1");
  assert.deepEqual(await st.loadPayload("r1"), { a: 1 });
  assert.equal(await st.loadPayload("r2"), null);
  await st.clearPayload();
  await st.clear();
  assert.deepEqual(mem, {});
  assert.throws(() => createChromeRunStore(undefined), /chrome\.storage/);
});
