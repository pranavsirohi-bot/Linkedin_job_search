// The auto-save session engine on its own: de-duplication within a session, debouncing of page-change pings,
// retries, Stop, recovery, and the content-script sender check.
import test from "node:test";
import assert from "node:assert/strict";
import { WATCH_LIMITS, cardMarks, createMemoryWatchStore, createWatchSession, summarizeWatch } from "../../src/watch/watch-session.js";
import { makeIsLinkedInContentSender, makeIsTrustedSender } from "../../src/background/trust.js";
import { DbError, ERR } from "../../src/db/errors.js";
import { gate, tick } from "../batch/helpers.mjs";

const card = (id) => ({ source: "card", jobId: String(id), url: `https://www.linkedin.com/jobs/view/${id}/`, title: `Job ${id}`, company: "Acme" });
const detail = (id) => ({ ...card(id), source: "detail", description: `About ${id}` });
const snap = (ids, open = null) => ({ ok: true, cards: ids.map(card), detail: open ? detail(open) : null });

// Manual timers so debouncing and retries are deterministic.
function timers() {
  const q = new Map();
  let n = 0;
  return {
    schedule: (fn, ms) => { const h = ++n; q.set(h, { fn, ms }); return h; },
    cancel: (h) => q.delete(h),
    pending: () => [...q.values()].map((t) => t.ms),
    async fire() { const all = [...q.entries()]; q.clear(); for (const [, t] of all) t.fn(); for (let i = 0; i < 20; i++) await tick(0); },
  };
}

function setup({ save, page = snap([1000001, 1000002], 1000001) } = {}) {
  const t = timers();
  const saved = [];
  let current = page;
  const reads = [];
  const w = createWatchSession({
    store: createMemoryWatchStore(),
    schedule: t.schedule,
    cancel: t.cancel,
    pullSnapshot: async (tabId) => { reads.push(tabId); return typeof current === "function" ? current() : current; },
    save: save || (async (jobs) => { saved.push(jobs.map((j) => j.jobId)); return { inserted: jobs.length, duplicates: 0, rejected: [] }; }),
  });
  // Idle = no scan running; a scheduled (manual) timer that has not been fired yet does not count as busy.
  const idle = async () => { for (let i = 0; i < 200 && w.isBusy() && !t.pending().length; i++) await tick(0); for (let i = 0; i < 10; i++) await tick(0); };
  return { w, t, saved, reads, idle, show: (p) => { current = p; } };
}

test("Start saves the open job; a ping is debounced and only the newly opened job is saved", async () => {
  const { w, t, saved, idle, show } = setup();
  await w.start({ tabId: 4 });
  await idle();
  assert.deepEqual(saved, [["1000001"]], "the open job only, never its neighbours' list cards");
  show(snap([1000002, 1000003], 1000003));
  assert.equal(await w.pageChanged(4), true);
  assert.equal(await w.pageChanged(4), true);
  assert.deepEqual(t.pending(), [WATCH_LIMITS.settleMs], "two quick pings -> one scheduled read");
  await t.fire();
  await idle();
  assert.deepEqual(saved, [["1000001"], ["1000003"]]);
  const s = await w.getState();
  assert.deepEqual(s.counters, { pages: 2, discovered: 3, processed: 2, saved: 2, duplicates: 0, full: 2, skipped: 0, partial: 0, failed: 0 });
  assert.equal(s.seenCount, 2);
  assert.ok(!("seen" in s), "the id list stays internal");
});

test("pings from other tabs, or when not watching, schedule nothing", async () => {
  const { w, t, idle } = setup();
  assert.equal(await w.pageChanged(4), false, "no session yet");
  await w.start({ tabId: 4 });
  await idle();
  assert.equal(await w.pageChanged(5), false);
  await w.stop();
  assert.equal(await w.pageChanged(4), false);
  assert.deepEqual(t.pending(), []);
});

test("list cards alone are never saved; a job is saved when it is opened, and only once", async () => {
  const ids = Array.from({ length: 12 }, (_, i) => 2000000 + i);
  const { w, t, saved, idle, show } = setup({ page: snap(ids) });
  await w.start({ tabId: 1 });
  await idle();
  assert.deepEqual(saved, [], "12 cards on screen, no job open: nothing is saved");
  assert.equal((await w.getState()).counters.discovered, 12, "but they are listed for the checklist");
  show(snap(ids, 2000004));
  await w.pageChanged(1);
  await t.fire();
  await idle();
  assert.deepEqual(saved, [["2000004"]]);
  show(snap(ids, 2000004));
  await w.pageChanged(1);
  await t.fire();
  await idle();
  assert.equal(saved.length, 1, "already saved with details: nothing more");
});

test("an older stored session that asked for list cards (saveCards) still saves only the open job", async () => {
  const t = timers();
  const saved = [];
  const store = createMemoryWatchStore({ v: 1, sessionId: "old", tabId: 1, status: "watching", current: "watching", saveCards: true, counters: { pages: 0, discovered: 0, processed: 0, saved: 0, duplicates: 0, full: 0, skipped: 0, partial: 0, failed: 0 }, seen: {}, known: {}, jobs: {}, dbStatus: {} });
  const w = createWatchSession({
    store, schedule: t.schedule, cancel: t.cancel,
    pullSnapshot: async () => snap([2100001, 2100002, 2100003], 2100002),
    save: async (jobs) => { saved.push(...jobs.map((j) => [j.jobId, j.source])); return { inserted: jobs.length, duplicates: 0, rejected: [] }; },
  });
  await w.pageChanged(1);
  await t.fire();
  for (let i = 0; i < 60; i++) await tick(0);
  assert.deepEqual(saved, [["2100002", "detail"]]);
});

test("Stop during a save: that save is counted; nothing is saved after Stop", async () => {
  const hold = gate();
  let calls = 0;
  const ids = Array.from({ length: 12 }, (_, i) => 3000000 + i);
  const { w, t, idle, show } = setup({ page: snap(ids, 3000000), save: async (jobs) => { calls++; if (calls === 1) await hold.promise; return { inserted: jobs.length, duplicates: 0, rejected: [] }; } });
  const s0 = await w.start({ tabId: 1 });
  while (calls < 1) await tick(0);
  await w.stop(s0.sessionId);
  hold.open();
  await idle();
  const s = await w.getState();
  assert.equal(calls, 1);
  assert.deepEqual([s.status, s.endReason, s.counters.processed, s.counters.saved], ["stopped", "stopped", 1, 1]);
  show(snap(ids, 3000005));
  assert.equal(await w.pageChanged(1), false, "not watching any more");
  await t.fire(); await idle();
  assert.equal(calls, 1);
  await assert.rejects(w.stop("someone-else"), (e) => e.code === "stale-session");
});

test("connection problems are retried a few times without being counted as failed or discovered twice", async () => {
  let fails = 2;
  const { w, t, idle } = setup({ save: async (jobs) => { if (fails-- > 0) throw new DbError(ERR.NETWORK, "Can't reach the server."); return { inserted: jobs.length, duplicates: 0, rejected: [] }; } });
  await w.start({ tabId: 1 });
  await idle();
  assert.equal((await w.getState()).lastError.code, "NETWORK");
  assert.deepEqual(t.pending(), [WATCH_LIMITS.retryMs]);
  await t.fire(); await idle();
  await t.fire(); await idle();
  const s = await w.getState();
  assert.deepEqual(s.counters, { pages: 1, discovered: 2, processed: 1, saved: 1, duplicates: 0, full: 1, skipped: 0, partial: 0, failed: 0 });
  assert.equal(s.lastError, null);
});

test("retries stop after the limit; the jobs stay pending and are saved on the next page change", async () => {
  let down = true;
  const { w, t, idle, saved } = setup({ save: async (jobs) => { if (down) throw new DbError(ERR.NETWORK, "offline"); saved.push(jobs.map((j) => j.jobId)); return { inserted: jobs.length, duplicates: 0, rejected: [] }; } });
  await w.start({ tabId: 1 });
  await idle();
  for (let i = 0; i < WATCH_LIMITS.maxRetries; i++) { await t.fire(); await idle(); }
  assert.deepEqual(t.pending(), [], "gave up retrying");
  down = false;
  await w.pageChanged(1);
  await t.fire();
  await idle();
  assert.deepEqual(saved, [["1000001"]]);
  assert.equal((await w.getState()).counters.discovered, 2);
});

test("a rejected save is failed (not retried) and stays reported; the session continues", async () => {
  const { w, idle } = setup({ save: async () => { throw new DbError(ERR.VALIDATION, "bad rows"); } });
  await w.start({ tabId: 1 });
  await idle();
  const s = await w.getState();
  assert.deepEqual([s.status, s.counters.failed, s.counters.processed, s.lastError.code], ["watching", 1, 1, ERR.VALIDATION]);
});

test("recovery: worker wake keeps watching (and clears a stuck 'saving'); reload/restart end it; tab close ends it", async () => {
  const store = createMemoryWatchStore({ v: 1, sessionId: "s1", tabId: 3, status: "watching", current: "saving", counters: { pages: 1, discovered: 1, processed: 0, saved: 0, duplicates: 0, skipped: 0, failed: 0 }, seen: {}, lastError: null });
  const w = createWatchSession({ store, pullSnapshot: async () => snap([]), save: async () => ({}) });
  await w.recover("sw-wake");
  assert.deepEqual([(await w.getState()).status, (await w.getState()).current], ["watching", "watching"]);
  await w.tabClosed(99);
  assert.equal((await w.getState()).status, "watching", "another tab closing changes nothing");
  await w.tabClosed(3);
  assert.equal((await w.getState()).endReason, "tab-closed");
  const store2 = createMemoryWatchStore({ ...(await store.get()), status: "watching" });
  const w2 = createWatchSession({ store: store2, pullSnapshot: async () => snap([]), save: async () => ({}) });
  await w2.recover("browser-start");
  assert.equal((await w2.getState()).endReason, "browser-restarted");
});

test("start validates the tab; ids that are not LinkedIn job ids are ignored; the remembered list is bounded", async () => {
  const w = createWatchSession({ store: createMemoryWatchStore(), checkTab: async (id) => id === 1, pullSnapshot: async () => snap([]), save: async () => ({}) });
  await assert.rejects(w.start({ tabId: 2 }), (e) => e.code === "invalid-tab");
  await assert.rejects(w.start({ tabId: -1 }), (e) => e.code === "invalid-tab");
  const saved = [];
  const t = timers();
  const ids = Array.from({ length: 30 }, (_, i) => 5000000 + i);
  let open = 0;
  const w2 = createWatchSession({
    store: createMemoryWatchStore(), schedule: t.schedule, cancel: t.cancel, limits: { ...WATCH_LIMITS, maxSeen: 10 },
    pullSnapshot: async () => ({ ok: true, cards: [...ids.map(card), { jobId: "abc" }, null, { jobId: 12 }], detail: detail(ids[open]) }),
    save: async (jobs) => { saved.push(...jobs.map((j) => j.jobId)); return { inserted: jobs.length, duplicates: 0, rejected: [] }; },
  });
  await w2.start({ tabId: 1 });
  for (let i = 0; i < 200 && w2.isBusy(); i++) await tick(0);
  for (open = 1; open < 12; open++) { await w2.pageChanged(1); await t.fire(); for (let i = 0; i < 200 && w2.isBusy(); i++) await tick(0); }
  assert.equal(saved.length, 12, "one save per opened job");
  assert.ok(saved.every((id) => /^\d+$/.test(id)), "malformed card ids are ignored");
  assert.equal((await w2.getState()).seenCount, 10, "the remembered list is bounded");
});

test("summarizeWatch hides the id list and tolerates empty state", () => {
  assert.equal(summarizeWatch(null), null);
  assert.deepEqual(summarizeWatch({ sessionId: "a", counters: { saved: 1 }, seen: { 1: "card" } }), { sessionId: "a", counters: { partial: 0, full: 0, saved: 1 }, seenCount: 1, page: { visible: 0, full: 0, remaining: 0, next: null, jobs: [] }, trackedJobs: 0 });
});

// ------------------------------------------------------------------ who may send the "page changed" ping
test("only our content script in the top frame of a www.linkedin.com tab counts as a content sender", () => {
  const ID = "abcdefghijklmnopabcdefghijklmnop";
  const ok = makeIsLinkedInContentSender(ID);
  const base = { id: ID, url: "https://www.linkedin.com/jobs/search-results/", tab: { id: 3 }, frameId: 0 };
  assert.equal(ok(base), true);
  assert.equal(ok({ ...base, frameId: 1 }), false, "sub-frame");
  assert.equal(ok({ ...base, tab: undefined }), false, "no tab");
  assert.equal(ok({ ...base, id: "other" }), false, "another extension");
  assert.equal(ok({ ...base, url: "https://linkedin.com.evil.example/" }), false);
  assert.equal(ok({ ...base, url: "http://www.linkedin.com/jobs/" }), false, "not https");
  assert.equal(ok({ ...base, url: `chrome-extension://${ID}/src/popup/popup.html` }), false, "extension pages are not content senders");
  assert.equal(ok(undefined), false);
  // And the content script is still not a trusted (database) sender.
  assert.equal(makeIsTrustedSender(ID)(base), false);
});

test("card + open job of the same id: the saved record keeps the detail's status and warnings, not the card's", async () => {
  const saved = [];
  const w = createWatchSession({
    store: createMemoryWatchStore(), schedule: () => 0, cancel: () => {},
    pullSnapshot: async () => ({ ok: true, cards: [{ ...card(7000001), extractionStatus: "partial", extractionWarnings: ["card-only"] }], detail: { ...detail(7000001), extractionStatus: "complete", extractionWarnings: [] } }),
    save: async (jobs) => { saved.push(...jobs); return { inserted: jobs.length, duplicates: 0, rejected: [] }; },
  });
  await w.start({ tabId: 1 });
  for (let i = 0; i < 200 && w.isBusy(); i++) await tick(0);
  assert.equal(saved.length, 1);
  assert.deepEqual([saved[0].source, saved[0].extractionStatus, saved[0].extractionWarnings, saved[0].description], ["detail", "complete", [], "About 7000001"]);
});

test("an open job whose panel is still loading is read again (bounded), then its details are saved", async () => {
  const t = timers();
  const saved = [];
  let reads = 0;
  const w = createWatchSession({
    store: createMemoryWatchStore(), schedule: t.schedule, cancel: t.cancel,
    pullSnapshot: async () => { reads++; return reads < 3 ? { ok: true, cards: [card(8000001)], detail: null, detailReason: "description-not-loaded" } : { ok: true, cards: [card(8000001)], detail: detail(8000001), detailReason: "ok" }; },
    save: async (jobs) => { saved.push(...jobs.map((j) => [j.jobId, j.source])); return { inserted: jobs.length, duplicates: 0, rejected: [] }; },
  });
  await w.start({ tabId: 1 });
  for (let i = 0; i < 50; i++) await tick(0);
  assert.deepEqual(saved, [], "nothing is saved while the details are still loading (never a card-only row)");
  assert.deepEqual(t.pending(), [WATCH_LIMITS.detailRereadMs]);
  await t.fire(); for (let i = 0; i < 50; i++) await tick(0);
  await t.fire(); for (let i = 0; i < 50; i++) await tick(0);
  assert.deepEqual(saved, [["8000001", "detail"]], "the details arrive on a re-read and are saved");
  assert.deepEqual(t.pending(), [], "no more re-reads");
});

test("re-reads are bounded when the panel never finishes loading", async () => {
  const t = timers();
  let reads = 0;
  const w = createWatchSession({
    store: createMemoryWatchStore(), schedule: t.schedule, cancel: t.cancel,
    pullSnapshot: async () => { reads++; return { ok: true, cards: [], detail: null, detailReason: "description-not-loaded" }; },
    save: async () => ({ inserted: 0, duplicates: 0, rejected: [] }),
  });
  await w.start({ tabId: 1 });
  for (let k = 0; k < 6; k++) { for (let i = 0; i < 50; i++) await tick(0); await t.fire(); }
  assert.equal(reads, 1 + WATCH_LIMITS.detailRereads);
});

// ------------------------------------------------------------------ default: only jobs the user opens are saved
test("default mode saves only the opened job (with full details); list cards are tracked for the checklist, not saved", async () => {
  const t = timers();
  const saved = [];
  let page = { ok: true, cards: [card(9000001), card(9000002), card(9000003)], detail: { ...detail(9000002), extractionStatus: "complete" }, detailReason: "ok" };
  const w = createWatchSession({
    store: createMemoryWatchStore(), schedule: t.schedule, cancel: t.cancel,
    pullSnapshot: async () => page,
    save: async (jobs) => { saved.push(...jobs.map((j) => [j.jobId, j.source])); return { inserted: jobs.length, duplicates: 0, rejected: [] }; },
  });
  await w.start({ tabId: 1 });
  for (let i = 0; i < 60; i++) await tick(0);
  assert.deepEqual(saved, [["9000002", "detail"]], "only the open job, merged with its own card");
  let s = await w.getState();
  assert.ok(!("saveCards" in s), "there is no list-card option any more");
  assert.deepEqual([s.counters.discovered, s.counters.processed, s.counters.saved, s.counters.partial], [3, 1, 1, 0]);
  assert.deepEqual({ ...s.page, jobs: undefined }, { visible: 3, full: 1, remaining: 2, next: { jobId: "9000001", title: "Job 9000001", company: "Acme" }, jobs: undefined });
  assert.deepEqual(s.page.jobs.map((r) => [r.jobId, r.outcome, r.isNext]), [["9000001", null, true], ["9000002", "full", false], ["9000003", null, false]]);
  assert.deepEqual([s.openJob.jobId, s.openJob.state, s.counters.full], ["9000002", "full", 1]);

  // The user opens the next job: it is saved too; the checklist moves on.
  page = { ...page, detail: { ...detail(9000001), extractionStatus: "complete" } };
  await w.pageChanged(1); await t.fire(); for (let i = 0; i < 60; i++) await tick(0);
  s = await w.getState();
  assert.deepEqual(saved, [["9000002", "detail"], ["9000001", "detail"]]);
  assert.deepEqual([s.page.full, s.page.next.jobId], [2, "9000003"]);

  // A page change with no job open saves nothing (no card-only rows are created).
  page = { ok: true, cards: [card(9000004)], detail: null, detailReason: "no-detail-panel" };
  await w.pageChanged(1); await t.fire(); for (let i = 0; i < 60; i++) await tick(0);
  s = await w.getState();
  assert.equal(saved.length, 2);
  assert.deepEqual([s.counters.discovered, s.page.visible, s.page.next.jobId, s.openJob], [4, 1, "9000004", null]);
});

test("open-job state: still loading vs unreadable; partial counter counts only confirmed partial saves", async () => {
  const t = timers();
  let page = { ok: true, cards: [], detail: null, detailReason: "description-not-loaded" };
  const w = createWatchSession({
    store: createMemoryWatchStore(), schedule: t.schedule, cancel: t.cancel, pullSnapshot: async () => page,
    save: async (jobs) => ({ inserted: jobs.length, duplicates: 0, rejected: [] }),
  });
  await w.start({ tabId: 1 });
  for (let i = 0; i < 60; i++) await tick(0);
  assert.equal((await w.getState()).openJob.state, "loading");
  page = { ok: true, cards: [], detail: null, detailReason: "ambiguous-detail-root" };
  await t.fire(); for (let i = 0; i < 60; i++) await tick(0);
  assert.deepEqual([(await w.getState()).openJob.state, (await w.getState()).openJob.reason], ["unreadable", "ambiguous-detail-root"]);
  page = { ok: true, cards: [], detail: { ...detail(9100001), location: "", extractionStatus: "partial", extractionWarnings: ["missing:location"] }, detailReason: "ok" };
  await w.pageChanged(1); await t.fire(); for (let i = 0; i < 60; i++) await tick(0);
  const s = await w.getState();
  assert.deepEqual([s.counters.saved, s.counters.partial], [1, 1]);
});

test("a failed save is never counted as saved and the job is not marked done in the checklist", async () => {
  const t = timers();
  const w = createWatchSession({
    store: createMemoryWatchStore(), schedule: t.schedule, cancel: t.cancel,
    pullSnapshot: async () => ({ ok: true, cards: [card(9200001)], detail: { ...detail(9200001), extractionStatus: "complete" }, detailReason: "ok" }),
    save: async () => { throw new DbError(ERR.VALIDATION, "rejected"); },
  });
  await w.start({ tabId: 1 });
  for (let i = 0; i < 60; i++) await tick(0);
  const s = await w.getState();
  assert.deepEqual([s.counters.saved, s.counters.failed, s.page.full, s.openJob.state, s.page.next], [0, 1, 0, "failed", null], "a failed job is not suggested again");
  assert.equal(s.lastError.code, ERR.VALIDATION);
});

// ------------------------------------------------------------------ card marks, database state, ready pings
test("cardMarks: confirmed outcomes and database state decide the badges; card-only rows are still 'next'", () => {
  const st = { pageIds: ["1", "2", "3", "4", "5", "6"], seen: { 1: "detail", 2: "partial", 3: "failed", 4: "pending" }, dbStatus: { 5: "card", 6: "full" } };
  assert.deepEqual(cardMarks(st), { marks: { 1: "full", 2: "partial", 3: "failed", 4: "saving", 5: "next", 6: "full" }, next: "5" });
  assert.deepEqual(cardMarks({ pageIds: ["7", "8"], seen: {}, dbStatus: { 7: "full" } }), { marks: { 7: "full", 8: "next" }, next: "8" });
  assert.deepEqual(cardMarks({ pageIds: ["9"], seen: { 9: "card" } }).marks, { 9: "next" }, "saved from the card only: still needs its details");
  assert.deepEqual(cardMarks({ pageIds: ["9", "10"], seen: { 9: "card" }, dbStatus: {} }).marks, { 9: "next" }, "only one job is 'next'; unsaved later jobs get no badge yet");
});

test("jobs already saved with full details (earlier sessions) are not suggested again; the lookup runs once per job", async () => {
  const t = timers();
  const asked = [];
  const store = createMemoryWatchStore();
  const w = createWatchSession({
    store, schedule: t.schedule, cancel: t.cancel,
    pullSnapshot: async () => ({ ok: true, cards: [card(9300001), card(9300002), card(9300003)], detail: null, detailReason: "no-detail-panel" }),
    save: async () => ({ inserted: 0, duplicates: 0, rejected: [] }),
    lookup: async (ids) => { asked.push(ids); return { 9300001: "full", 9300002: "card" }; },
  });
  await w.start({ tabId: 1 });
  for (let i = 0; i < 60; i++) await tick(0);
  let raw = await store.get();
  assert.ok(!("marks" in raw) && !("nextId" in raw), "per-card marks are not stored: nothing is drawn on LinkedIn's page");
  const s = await w.getState();
  assert.deepEqual([s.page.full, s.page.next.jobId], [1, "9300002"]);
  assert.deepEqual(s.page.jobs.map((j) => [j.jobId, j.mark]), [["9300001", "full"], ["9300002", "next"], ["9300003", null]], "the popup still gets each job's status");
  await w.pageChanged(1); await t.fire(); for (let i = 0; i < 60; i++) await tick(0);
  assert.deepEqual(asked, [["9300001", "9300002", "9300003"]], "already-known ids are not looked up again");
  await w.stop();
  raw = await store.get();
  assert.ok(!("marks" in raw) && !("nextId" in raw));
});

test("a failing database lookup only means fewer hints; saving still works", async () => {
  const t = timers();
  const saved = [];
  const w = createWatchSession({
    store: createMemoryWatchStore(), schedule: t.schedule, cancel: t.cancel,
    pullSnapshot: async () => ({ ok: true, cards: [card(9400001)], detail: { ...detail(9400001), extractionStatus: "complete" }, detailReason: "ok" }),
    save: async (jobs) => { saved.push(...jobs.map((j) => j.jobId)); return { inserted: 1, duplicates: 0, rejected: [] }; },
    lookup: async () => { throw new DbError(ERR.NETWORK, "offline"); },
  });
  await w.start({ tabId: 1 });
  for (let i = 0; i < 60; i++) await tick(0);
  assert.deepEqual(saved, ["9400001"]);
  assert.equal((await w.getState()).openJob.state, "full");
});

test("a 'ready' ping is read almost at once; an ordinary ping waits the settle time", async () => {
  const t = timers();
  const w = createWatchSession({ store: createMemoryWatchStore(), schedule: t.schedule, cancel: t.cancel, pullSnapshot: async () => ({ ok: true, cards: [] }), save: async () => ({}) });
  await w.start({ tabId: 1 });
  for (let i = 0; i < 30; i++) await tick(0);
  await w.pageChanged(1, { ready: true });
  assert.deepEqual(t.pending(), [WATCH_LIMITS.readySettleMs]);
  await w.pageChanged(1);
  assert.deepEqual(t.pending(), [WATCH_LIMITS.settleMs], "debounced: the latest ping decides");
  assert.ok(WATCH_LIMITS.readySettleMs < WATCH_LIMITS.settleMs);
});

test("a partial detail read that later reads complete is saved again (upgrade), a complete one is not re-saved", async () => {
  const t = timers();
  const saved = [];
  let d = { ...detail(9500001), location: "", extractionStatus: "partial", extractionWarnings: ["missing:location"] };
  const w = createWatchSession({
    store: createMemoryWatchStore(), schedule: t.schedule, cancel: t.cancel,
    pullSnapshot: async () => ({ ok: true, cards: [], detail: d, detailReason: "ok" }),
    save: async (jobs) => { saved.push(...jobs.map((j) => j.extractionStatus)); return { inserted: 1, duplicates: 0, rejected: [] }; },
  });
  await w.start({ tabId: 1 });
  for (let i = 0; i < 60; i++) await tick(0);
  assert.equal((await w.getState()).openJob.state, "partial");
  d = { ...detail(9500001), extractionStatus: "complete" };
  await w.pageChanged(1, { ready: true }); await t.fire(); for (let i = 0; i < 60; i++) await tick(0);
  await w.pageChanged(1, { ready: true }); await t.fire(); for (let i = 0; i < 60; i++) await tick(0);
  assert.deepEqual(saved, ["partial", "complete"]);
  const s = await w.getState();
  assert.deepEqual([s.openJob.state, s.counters.full, s.counters.partial], ["full", 1, 1]);
});

// ------------------------------------------------------------------ per-job tracking records
const settle = async (n = 80) => { for (let i = 0; i < n; i++) await tick(0); };
const rowOf = (s, id) => s.page.jobs.find((r) => r.jobId === id);
const mk = (over = {}) => {
  const t = timers();
  const clock = { v: 1_000_000 };
  let snapshot = { ok: true, cards: [card(9600001), card(9600002), card(9600003)], detail: null, detailReason: "no-detail-panel", checks: {} };
  const saves = [];
  let saveImpl = async (jobs) => ({ inserted: jobs.length, duplicates: 0, rejected: [] });
  const w = createWatchSession({
    store: createMemoryWatchStore(), schedule: t.schedule, cancel: t.cancel, now: () => clock.v,
    pullSnapshot: async () => (typeof snapshot === "function" ? snapshot() : snapshot),
    save: async (jobs) => { saves.push(jobs.map((j) => j.jobId)); return saveImpl(jobs); },
    ...over,
  });
  return { w, t, clock, saves, setSnap: (s) => { snapshot = s; }, setSave: (f) => { saveImpl = f; } };
};
const full = (id) => ({ ...detail(id), extractionStatus: "complete" });

test("tracking: every listed job gets one record (title, company, discovered); a card seen again never adds a second", async () => {
  const x = mk();
  await x.w.start({ tabId: 1 });
  await settle();
  await x.w.pageChanged(1); await x.t.fire(); await settle();
  await x.w.pageChanged(1); await x.t.fire(); await settle();
  const s = await x.w.getState();
  assert.equal(s.trackedJobs, 3);
  assert.deepEqual(s.page.jobs.map((r) => [r.jobId, r.title, r.company, r.det, r.save, r.outcome, r.mark]), [
    ["9600001", "Job 9600001", "Acme", "none", "none", null, "next"],
    ["9600002", "Job 9600002", "Acme", "none", "none", null, undefined].map((v) => v ?? null),
    ["9600003", "Job 9600003", "Acme", "none", "none", null, null],
  ]);
  assert.equal(s.counters.discovered, 3);
  assert.deepEqual(x.saves, [], "listing alone saves nothing");
});

test("tracking lifecycle of the opened job: loading -> extracted -> saving -> saved, with the database's answer per job", async () => {
  const x = mk();
  x.setSnap({ ok: true, cards: [card(9600001), card(9600002)], detail: null, detailReason: "description-not-loaded", checks: { pageUrlId: "9600002" } });
  await x.w.start({ tabId: 1 });
  await settle();
  let s = await x.w.getState();
  assert.deepEqual([rowOf(s, "9600002").det, rowOf(s, "9600002").save, rowOf(s, "9600002").outcome], ["loading", "none", null], "details still loading: nothing saved");
  assert.deepEqual([s.openJob.state], ["loading"]);
  let gate = null;
  x.setSave((jobs) => new Promise((resolve) => { gate = () => resolve({ inserted: 0, duplicates: jobs.length, rejected: [] }); }));
  x.setSnap({ ok: true, cards: [card(9600001), card(9600002)], detail: full(9600002), detailReason: "ok", checks: { pageUrlId: "9600002" } });
  await x.t.fire(); await settle(); // the re-read finds the details
  s = await x.w.getState();
  assert.deepEqual([rowOf(s, "9600002").det, rowOf(s, "9600002").save, rowOf(s, "9600002").outcome], ["full", "saving", null], "extracted; the save is in flight, not confirmed");
  assert.equal(s.counters.saved + s.counters.duplicates, 0, "not counted before the database answers");
  gate(); await settle();
  s = await x.w.getState();
  const r = rowOf(s, "9600002");
  assert.deepEqual([r.det, r.save, r.outcome, r.dup, r.error], ["full", "saved", "full", true, null], "confirmed: an update of an existing row");
  assert.equal(s.page.full, 1);
});

test("tracking: new row vs update is read from the database's answer, per job when it can be, never guessed for a mixed batch", async () => {
  const x = mk();
  x.setSnap({ ok: true, cards: [card(9610001)], detail: full(9610001), detailReason: "ok", checks: { pageUrlId: "9610001" } });
  await x.w.start({ tabId: 1 });
  await settle();
  assert.equal(rowOf(await x.w.getState(), "9610001").dup, false, "inserted: a new row");
  // The database says the opened job already existed: an update, never guessed otherwise.
  const y = mk();
  y.setSave(async (jobs) => ({ inserted: 0, duplicates: jobs.length, rejected: [] }));
  y.setSnap({ ok: true, cards: [card(9620001), card(9620002)], detail: full(9620001), detailReason: "ok", checks: { pageUrlId: "9620001" } });
  await y.w.start({ tabId: 1 });
  await settle();
  const s = await y.w.getState();
  assert.deepEqual(s.page.jobs.map((r) => r.dup), [true, null], "the unopened card is not saved, so it has no answer");
  assert.deepEqual([s.counters.saved, s.counters.duplicates], [0, 1]);
});

test("tracking: a job the database refuses is Failed with its error; reopening it later is retried a bounded number of times", async () => {
  const x = mk();
  x.setSave(async () => { throw new DbError(ERR.VALIDATION, "The data was rejected by the database (23514)."); });
  x.setSnap({ ok: true, cards: [card(9630001)], detail: full(9630001), detailReason: "ok", checks: { pageUrlId: "9630001" } });
  await x.w.start({ tabId: 1 });
  await settle();
  let s = await x.w.getState();
  let r = rowOf(s, "9630001");
  assert.deepEqual([r.save, r.outcome, r.mark, r.error], ["failed", "failed", "failed", "The data was rejected by the database (23514)."]);
  assert.deepEqual([s.counters.saved, s.counters.failed], [0, 1]);
  // Read again at once (pings, re-renders): no tight retry loop.
  await x.w.pageChanged(1); await x.t.fire(); await settle();
  assert.equal(x.saves.length, 1, "not retried within the back-off window");
  // The user reopens it later; the database accepts it now.
  x.clock.v += 6000;
  x.setSave(async (jobs) => ({ inserted: jobs.length, duplicates: 0, rejected: [] }));
  await x.w.pageChanged(1, { ready: true }); await x.t.fire(); await settle();
  s = await x.w.getState();
  r = rowOf(s, "9630001");
  assert.deepEqual([r.save, r.outcome, r.error, r.mark], ["saved", "full", null, "full"], "recovered, error cleared");
  // A job the database keeps refusing is given up on after maxTries.
  const z = mk();
  z.setSave(async () => { throw new DbError(ERR.VALIDATION, "bad"); });
  z.setSnap({ ok: true, cards: [], detail: full(9630002), detailReason: "ok", checks: { pageUrlId: "9630002" } });
  await z.w.start({ tabId: 1 });
  for (let i = 0; i < 6; i++) { z.clock.v += 6000; await z.w.pageChanged(1, { ready: true }); await z.t.fire(); await settle(); }
  assert.equal(z.saves.length, WATCH_LIMITS.maxTries);
});

test("tracking: connection retries that run out say Failed per job (not a stuck 'Saving...'), and the job is tried again if read again", async () => {
  const x = mk();
  x.setSave(async () => { throw new DbError(ERR.NETWORK, "Can't reach the server."); });
  x.setSnap({ ok: true, cards: [card(9640001)], detail: full(9640001), detailReason: "ok", checks: { pageUrlId: "9640001" } });
  await x.w.start({ tabId: 1 });
  await settle();
  let s = await x.w.getState();
  assert.equal(rowOf(s, "9640001").save, "retry");
  for (let i = 0; i < WATCH_LIMITS.maxRetries; i++) { await x.t.fire(); await settle(); }
  s = await x.w.getState();
  const r = rowOf(s, "9640001");
  assert.deepEqual([r.save, r.mark], ["failed", "failed"]);
  assert.match(r.error, /^Gave up after 3 retries/);
  assert.equal(s.counters.saved, 0);
  x.setSave(async (jobs) => ({ inserted: jobs.length, duplicates: 0, rejected: [] }));
  await x.w.pageChanged(1, { ready: true }); await x.t.fire(); await settle();
  assert.deepEqual([rowOf(await x.w.getState(), "9640001").save, rowOf(await x.w.getState(), "9640001").outcome], ["saved", "full"]);
});

test("tracking: an unreadable open job is Failed with the reason (only for the SELECTED job); once read it is cleared; full is never downgraded", async () => {
  const x = mk();
  x.setSnap({ ok: true, cards: [card(9650001), card(9650002)], detail: null, detailReason: "ambiguous-detail-root", checks: { pageUrlId: "9650002" } });
  await x.w.start({ tabId: 1 });
  await settle();
  let s = await x.w.getState();
  assert.deepEqual([rowOf(s, "9650002").det, rowOf(s, "9650002").mark, rowOf(s, "9650002").error], ["unreadable", "failed", "several job panels on the page, none matches the selected job"]);
  assert.deepEqual([rowOf(s, "9650001").det, rowOf(s, "9650001").error], ["none", null], "another job on the page is untouched");
  x.setSnap({ ok: true, cards: [card(9650001), card(9650002)], detail: full(9650002), detailReason: "ok", checks: { pageUrlId: "9650002" } });
  await x.w.pageChanged(1, { ready: true }); await x.t.fire(); await settle();
  s = await x.w.getState();
  assert.deepEqual([rowOf(s, "9650002").det, rowOf(s, "9650002").error, rowOf(s, "9650002").outcome], ["full", null, "full"]);
  // A half-rendered re-read later must not undo it.
  x.setSnap({ ok: true, cards: [card(9650001), card(9650002)], detail: null, detailReason: "description-not-loaded", checks: { pageUrlId: "9650002" } });
  await x.w.pageChanged(1); await x.t.fire(); await settle();
  assert.deepEqual([rowOf(await x.w.getState(), "9650002").det, rowOf(await x.w.getState(), "9650002").outcome], ["full", "full"]);
});

test("tracking: a record the database skips is 'skipped' with its reason; it is not counted as saved", async () => {
  const x = mk();
  x.setSave(async () => ({ inserted: 0, duplicates: 0, rejected: [{ jobId: "9660001", reason: "no-usable-fields" }] }));
  x.setSnap({ ok: true, cards: [card(9660001)], detail: full(9660001), detailReason: "ok", checks: { pageUrlId: "9660001" } });
  await x.w.start({ tabId: 1 });
  await settle();
  const s = await x.w.getState();
  const r = rowOf(s, "9660001");
  assert.deepEqual([r.save, r.outcome, r.error, r.mark], ["none", "skipped", "Not saved: no-usable-fields", "failed"]);
  assert.deepEqual([s.counters.skipped, s.counters.saved, s.counters.full], [1, 0, 0]);
});

test("tracking: a weaker later result never lowers a saved full record; a partial read is upgraded when it later reads complete", async () => {
  const x = mk();
  const rows = new Set(); // behave like the database: the first save of an id inserts, later saves update
  x.setSave(async (jobs) => { const dup = jobs.filter((j) => rows.has(j.jobId)).length; jobs.forEach((j) => rows.add(j.jobId)); return { inserted: jobs.length - dup, duplicates: dup, rejected: [] }; });
  x.setSnap({ ok: true, cards: [card(9670001)], detail: { ...detail(9670001), extractionStatus: "partial", extractionWarnings: ["missing:location"] }, detailReason: "ok", checks: { pageUrlId: "9670001" } });
  await x.w.start({ tabId: 1 });
  await settle();
  assert.deepEqual([rowOf(await x.w.getState(), "9670001").det, rowOf(await x.w.getState(), "9670001").outcome], ["partial", "partial"]);
  x.setSnap({ ok: true, cards: [card(9670001)], detail: full(9670001), detailReason: "ok", checks: { pageUrlId: "9670001" } });
  await x.w.pageChanged(1, { ready: true }); await x.t.fire(); await settle();
  assert.deepEqual([rowOf(await x.w.getState(), "9670001").outcome, rowOf(await x.w.getState(), "9670001").dup], ["full", true]);
  // Now only the bare card is on screen again (cards mode): it is not saved again and cannot lower the record.
  const before = x.saves.length;
  x.setSnap({ ok: true, cards: [card(9670001)], detail: null, detailReason: "no-detail-panel", checks: {} });
  await x.w.pageChanged(1); await x.t.fire(); await settle();
  assert.equal(x.saves.length, before);
  assert.equal(rowOf(await x.w.getState(), "9670001").outcome, "full");
});

test("tracking: the same job read twice in one snapshot or on repeated pings is saved once; records are bounded", async () => {
  const x = mk();
  x.setSnap({ ok: true, cards: [card(9680001), card(9680001)], detail: full(9680001), detailReason: "ok", checks: { pageUrlId: "9680001" } });
  await x.w.start({ tabId: 1 });
  for (let i = 0; i < 4; i++) { await x.w.pageChanged(1, { ready: true }); await x.t.fire(); await settle(); }
  assert.deepEqual(x.saves, [["9680001"]]);
  assert.equal((await x.w.getState()).trackedJobs, 1);
  // Bounded: only the newest maxJobRecords stay.
  const ids = Array.from({ length: 30 }, (_, i) => 9690000 + i);
  const y = mk({ limits: { ...WATCH_LIMITS, maxJobRecords: 10 } });
  y.setSnap({ ok: true, cards: ids.map(card), detail: null, detailReason: "no-detail-panel", checks: {} });
  await y.w.start({ tabId: 1 });
  await settle();
  assert.equal((await y.w.getState()).trackedJobs, 10);
});

test("tracking: Stop leaves every record as it was; badges clear; nothing new starts", async () => {
  const x = mk();
  x.setSnap({ ok: true, cards: [card(9700001), card(9700002)], detail: full(9700001), detailReason: "ok", checks: { pageUrlId: "9700001" } });
  const raw = x.w;
  await raw.start({ tabId: 1 });
  await settle();
  await raw.stop();
  const s = await raw.getState();
  assert.equal(s.status, "stopped");
  assert.equal(rowOf(s, "9700001").outcome, "full");
  const before = x.saves.length;
  x.setSnap({ ok: true, cards: [card(9700002)], detail: full(9700002), detailReason: "ok", checks: { pageUrlId: "9700002" } });
  assert.equal(await raw.pageChanged(1, { ready: true }), false);
  await settle();
  assert.equal(x.saves.length, before);
});

// ------------------------------------------------------------------ pause / resume / retry
const withDetail = (id) => ({ ok: true, cards: [card(id)], detail: full(id), detailReason: "ok", checks: { pageUrlId: String(id) } });

test("pause: the session is kept, the page is ignored, nothing is read or saved; resume reads what is on screen now", async () => {
  const x = mk();
  x.setSnap(withDetail(9800001));
  await x.w.start({ tabId: 1 });
  await settle();
  assert.equal(x.saves.length, 1);
  const paused = await x.w.pause();
  assert.equal(paused.status, "paused");
  assert.equal(paused.counters.saved, 1, "counters are kept");
  x.setSnap(withDetail(9800002));
  assert.equal(await x.w.pageChanged(1, { ready: true }), false, "a paused session ignores page pings");
  await settle();
  assert.equal(x.saves.length, 1);
  assert.deepEqual(x.t.pending(), []);
  assert.equal((await x.w.resume()).status, "watching");
  await settle();
  assert.deepEqual(x.saves.at(-1), ["9800002"], "the job open at Resume is saved");
  assert.equal((await x.w.getState()).counters.saved, 2);
});

test("pause/resume/retry refuse clearly: no session, wrong state, stale session id; Start refuses while paused", async () => {
  const x = mk();
  for (const op of ["pause", "resume", "retry"]) await assert.rejects(x.w[op](), (e) => e.code === "no-session", op);
  const s = await x.w.start({ tabId: 1 });
  await assert.rejects(x.w.pause("old-id"), (e) => e.code === "stale-session");
  await assert.rejects(x.w.resume("old-id"), (e) => e.code === "stale-session");
  assert.equal((await x.w.resume()).status, "watching", "resume while watching is a no-op");
  await x.w.pause();
  await assert.rejects(x.w.retry(), (e) => e.code === "invalid-state" && /Resume/.test(e.message));
  await assert.rejects(x.w.start({ tabId: 1 }), (e) => e.code === "watch-active" && /paused/.test(e.message));
  assert.equal((await x.w.pause()).status, "paused", "pause while paused is a no-op");
  await x.w.stop(s.sessionId);
  await assert.rejects(x.w.pause(), (e) => e.code === "invalid-state");
  await assert.rejects(x.w.resume(), (e) => e.code === "invalid-state");
});

test("a paused session can be stopped, and closing its tab ends it", async () => {
  const a = mk();
  await a.w.start({ tabId: 1 });
  await a.w.pause();
  assert.equal((await a.w.stop()).status, "stopped");
  const b = mk();
  await b.w.start({ tabId: 7 });
  await b.w.pause();
  await b.w.tabClosed(7);
  const s = await b.w.getState();
  assert.deepEqual([s.status, s.endReason], ["stopped", "tab-closed"]);
});

test("retry: a job that failed and is in back-off is tried again right now, and the error clears when it saves", async () => {
  const x = mk();
  x.setSnap(withDetail(9810001));
  x.setSave(async () => { throw new DbError(ERR.NETWORK, "offline"); });
  await x.w.start({ tabId: 1 });
  await settle();
  let s = await x.w.getState();
  assert.equal(rowOf(s, "9810001").save, "retry", "the save is waiting for its back-off");
  assert.ok(s.lastError, "the failure is reported");
  x.setSave(async (jobs) => ({ inserted: jobs.length, duplicates: 0, rejected: [] }));
  await x.w.retry();
  await settle();
  s = await x.w.getState();
  assert.deepEqual([rowOf(s, "9810001").save, s.lastError], ["saved", null]);
  assert.equal(s.counters.saved, 1);
});

test("while the panel is loading, the selected job is shown by title from its list card; unreadable names it too", async () => {
  const x = mk();
  x.setSnap({ ok: true, cards: [card(9820001), card(9820002)], detail: null, detailReason: "description-not-loaded", checks: { pageUrlId: "9820002" } });
  await x.w.start({ tabId: 1 });
  await settle();
  let o = (await x.w.getState()).openJob;
  assert.deepEqual([o.state, o.jobId, o.title, o.company], ["loading", "9820002", "Job 9820002", "Acme"]);
  x.setSnap({ ok: true, cards: [card(9820001), card(9820002)], detail: null, detailReason: "ambiguous-detail-root", checks: { pageUrlId: "9820002" } });
  await x.w.pageChanged(1); await x.t.fire(); await settle();
  o = (await x.w.getState()).openJob;
  assert.deepEqual([o.state, o.jobId, o.title], ["unreadable", "9820002", "Job 9820002"]);
});

test("paused sessions survive a service-worker restart as paused, but a browser restart ends them", async () => {
  const x = mk();
  await x.w.start({ tabId: 1 });
  await x.w.pause();
  await x.w.recover("worker-restart");
  assert.equal((await x.w.getState()).status, "paused");
  await x.w.recover("browser-start");
  const s = await x.w.getState();
  assert.deepEqual([s.status, s.endReason], ["stopped", "browser-restarted"]);
});

// ------------------------------------------------------------------ auto-click bookkeeping
test("auto-click: page limit is clamped; counters move only while watching; 'finished' stops the session with its reason", async () => {
  const { w, idle } = setup();
  await w.start({ tabId: 7, autoClick: true, maxPages: 999 });
  await idle();
  assert.deepEqual((await w.getState()).pilot, { maxPages: 100, pages: 1, clicked: 0, finishReason: null });
  assert.deepEqual(await w.pilotEvent(8, { event: "hello" }), { pilot: false }, "only the watched tab");
  await w.pilotEvent(7, { event: "clicked" });
  await w.pilotEvent(7, { event: "page" });
  await w.pause();
  await w.pilotEvent(7, { event: "clicked" }); // paused: not counted
  assert.deepEqual((await w.getState()).pilot, { maxPages: 100, pages: 2, clicked: 1, finishReason: null });
  await w.resume();
  await idle();
  await w.pilotEvent(7, { event: "finished", reason: "bogus" });
  const s = await w.getState();
  assert.deepEqual([s.status, s.endReason, s.pilot.finishReason], ["stopped", "auto-finished", "no-more-pages"]);
});

test("auto-click: default page limit, and sessions without it have no pilot", async () => {
  const a = setup();
  await a.w.start({ tabId: 1, autoClick: true });
  assert.equal((await a.w.getState()).pilot.maxPages, WATCH_LIMITS.defaultMaxPages);
  const b = setup();
  await b.w.start({ tabId: 1 });
  const s = await b.w.getState();
  assert.deepEqual([s.autoClick, s.pilot], [false, null]);
  assert.deepEqual(await b.w.pilotEvent(1, { event: "hello" }), { pilot: false });
});
