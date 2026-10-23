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

function setup({ save, page = snap([1000001, 1000002]) } = {}) {
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

test("Start saves the page on screen; a ping is debounced and only new jobs are saved", async () => {
  const { w, t, saved, idle, show } = setup();
  await w.start({ saveCards: true, tabId: 4 });
  await idle();
  assert.deepEqual(saved, [["1000001", "1000002"]]);
  show(snap([1000002, 1000003]));
  assert.equal(await w.pageChanged(4), true);
  assert.equal(await w.pageChanged(4), true);
  assert.deepEqual(t.pending(), [WATCH_LIMITS.settleMs], "two quick pings -> one scheduled read");
  await t.fire();
  await idle();
  assert.deepEqual(saved, [["1000001", "1000002"], ["1000003"]]);
  const s = await w.getState();
  assert.deepEqual(s.counters, { pages: 2, discovered: 3, processed: 3, saved: 3, duplicates: 0, full: 0, skipped: 0, partial: 3, failed: 0 });
  assert.equal(s.seenCount, 3);
  assert.ok(!("seen" in s), "the id list stays internal");
});

test("pings from other tabs, or when not watching, schedule nothing", async () => {
  const { w, t, idle } = setup();
  assert.equal(await w.pageChanged(4), false, "no session yet");
  await w.start({ saveCards: true, tabId: 4 });
  await idle();
  assert.equal(await w.pageChanged(5), false);
  await w.stop();
  assert.equal(await w.pageChanged(4), false);
  assert.deepEqual(t.pending(), []);
});

test("a job opened later is saved once more with its details; saved in batches of 5", async () => {
  const ids = Array.from({ length: 12 }, (_, i) => 2000000 + i);
  const { w, t, saved, idle, show } = setup({ page: snap(ids) });
  await w.start({ saveCards: true, tabId: 1 });
  await idle();
  assert.deepEqual(saved.map((b) => b.length), [5, 5, 2]);
  show(snap(ids, 2000004));
  await w.pageChanged(1);
  await t.fire();
  await idle();
  assert.deepEqual(saved.at(-1), ["2000004"]);
  show(snap(ids, 2000004));
  await w.pageChanged(1);
  await t.fire();
  await idle();
  assert.equal(saved.length, 4, "already saved with details: nothing more");
});

test("Stop during a save: that save is counted, no further batch starts", async () => {
  const hold = gate();
  let calls = 0;
  const ids = Array.from({ length: 12 }, (_, i) => 3000000 + i);
  const { w, idle } = setup({ page: snap(ids), save: async (jobs) => { calls++; if (calls === 1) await hold.promise; return { inserted: jobs.length, duplicates: 0, rejected: [] }; } });
  const s0 = await w.start({ saveCards: true, tabId: 1 });
  while (calls < 1) await tick(0);
  await w.stop(s0.sessionId);
  hold.open();
  await idle();
  const s = await w.getState();
  assert.equal(calls, 1);
  assert.deepEqual([s.status, s.endReason, s.counters.processed, s.counters.saved], ["stopped", "stopped", 5, 5]);
  await assert.rejects(w.stop("someone-else"), (e) => e.code === "stale-session");
});

test("connection problems are retried a few times without being counted as failed or discovered twice", async () => {
  let fails = 2;
  const { w, t, idle } = setup({ save: async (jobs) => { if (fails-- > 0) throw new DbError(ERR.NETWORK, "Can't reach the server."); return { inserted: jobs.length, duplicates: 0, rejected: [] }; } });
  await w.start({ saveCards: true, tabId: 1 });
  await idle();
  assert.equal((await w.getState()).lastError.code, "NETWORK");
  assert.deepEqual(t.pending(), [WATCH_LIMITS.retryMs]);
  await t.fire(); await idle();
  await t.fire(); await idle();
  const s = await w.getState();
  assert.deepEqual(s.counters, { pages: 1, discovered: 2, processed: 2, saved: 2, duplicates: 0, full: 0, skipped: 0, partial: 2, failed: 0 });
  assert.equal(s.lastError, null);
});

test("retries stop after the limit; the jobs stay pending and are saved on the next page change", async () => {
  let down = true;
  const { w, t, idle, saved } = setup({ save: async (jobs) => { if (down) throw new DbError(ERR.NETWORK, "offline"); saved.push(jobs.map((j) => j.jobId)); return { inserted: jobs.length, duplicates: 0, rejected: [] }; } });
  await w.start({ saveCards: true, tabId: 1 });
  await idle();
  for (let i = 0; i < WATCH_LIMITS.maxRetries; i++) { await t.fire(); await idle(); }
  assert.deepEqual(t.pending(), [], "gave up retrying");
  down = false;
  await w.pageChanged(1);
  await t.fire();
  await idle();
  assert.deepEqual(saved, [["1000001", "1000002"]]);
  assert.equal((await w.getState()).counters.discovered, 2);
});

test("a rejected batch is failed (not retried) and stays reported; the session continues", async () => {
  const { w, idle } = setup({ save: async () => { throw new DbError(ERR.VALIDATION, "bad rows"); } });
  await w.start({ saveCards: true, tabId: 1 });
  await idle();
  const s = await w.getState();
  assert.deepEqual([s.status, s.counters.failed, s.counters.processed, s.lastError.code], ["watching", 2, 2, ERR.VALIDATION]);
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
  await assert.rejects(w.start({ saveCards: true, tabId: 2 }), (e) => e.code === "invalid-tab");
  await assert.rejects(w.start({ saveCards: true, tabId: -1 }), (e) => e.code === "invalid-tab");
  const saved = [];
  const t = timers();
  const ids = Array.from({ length: 30 }, (_, i) => 5000000 + i);
  const w2 = createWatchSession({
    store: createMemoryWatchStore(), schedule: t.schedule, cancel: t.cancel, limits: { ...WATCH_LIMITS, maxSeen: 10 },
    pullSnapshot: async () => ({ ok: true, cards: [...ids.map(card), { jobId: "abc" }, null, { jobId: 12 }], detail: null }),
    save: async (jobs) => { saved.push(...jobs.map((j) => j.jobId)); return { inserted: jobs.length, duplicates: 0, rejected: [] }; },
  });
  await w2.start({ saveCards: true, tabId: 1 });
  for (let i = 0; i < 200 && w2.isBusy(); i++) await tick(0);
  assert.equal(saved.length, 30);
  assert.ok(saved.every((id) => /^\d+$/.test(id)));
  assert.equal((await w2.getState()).seenCount, 10);
});

test("summarizeWatch hides the id list and tolerates empty state", () => {
  assert.equal(summarizeWatch(null), null);
  assert.deepEqual(summarizeWatch({ sessionId: "a", counters: { saved: 1 }, seen: { 1: "card" } }), { sessionId: "a", counters: { partial: 0, full: 0, saved: 1 }, seenCount: 1, page: { visible: 0, full: 0, remaining: 0, next: null } });
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
  await w.start({ saveCards: true, tabId: 1 });
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
  await w.start({ saveCards: true, tabId: 1 });
  for (let i = 0; i < 50; i++) await tick(0);
  assert.deepEqual(saved, [["8000001", "card"]], "the card is saved right away");
  assert.deepEqual(t.pending(), [WATCH_LIMITS.detailRereadMs]);
  await t.fire(); for (let i = 0; i < 50; i++) await tick(0);
  await t.fire(); for (let i = 0; i < 50; i++) await tick(0);
  assert.deepEqual(saved, [["8000001", "card"], ["8000001", "detail"]], "the details arrive on a re-read and are saved");
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
  await w.start({ saveCards: true, tabId: 1 });
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
  assert.equal(s.saveCards, false);
  assert.deepEqual([s.counters.discovered, s.counters.processed, s.counters.saved, s.counters.partial], [3, 1, 1, 0]);
  assert.deepEqual(s.page, { visible: 3, full: 1, remaining: 2, next: { jobId: "9000001", title: "Job 9000001", company: "Acme" } });
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
  assert.deepEqual(raw.marks, { 9300001: "full", 9300002: "next" });
  assert.equal(raw.nextId, "9300002");
  const s = await w.getState();
  assert.deepEqual([s.page.full, s.page.next.jobId], [1, "9300002"]);
  await w.pageChanged(1); await t.fire(); for (let i = 0; i < 60; i++) await tick(0);
  assert.deepEqual(asked, [["9300001", "9300002", "9300003"]], "already-known ids are not looked up again");
  await w.stop();
  raw = await store.get();
  assert.deepEqual([raw.marks, raw.nextId], [{}, null], "no badges once stopped");
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
