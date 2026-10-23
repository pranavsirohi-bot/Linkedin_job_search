// Auto-save while browsing, end to end: the real popup (bundled) -> real message handlers -> real watch session ->
// real saveJobs data layer -> a fake database that behaves like the idempotent, merge-safe upsert.
// Faked: chrome.*, the page the user is looking at (what the content script would return), the content script's
// "page changed" ping, and Supabase. This is a local test, not a Chrome test.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { createHandlers } from "../src/background/handlers.js";
import { makeIsLinkedInContentSender, makeIsTrustedSender } from "../src/background/trust.js";
import { saveJobs } from "../src/db/saved-jobs.js";
import { WATCH_KEY, WATCH_LIMITS, createMemoryWatchStore, createWatchSession } from "../src/watch/watch-session.js";
import { fakeClient } from "./db/fake-client.mjs";
import { gate, tick } from "./batch/helpers.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { outputFiles } = await build({ entryPoints: [path.join(root, "src/popup/popup.js")], bundle: true, format: "iife", write: false, logLevel: "silent" });
const POPUP_JS = outputFiles[0].text;
const HTML = fs.readFileSync(path.join(root, "src/popup/popup.html"), "utf8").replace(/<script[^>]*><\/script>/, "");

const EXT = "abcdefghijklmnopabcdefghijklmnop";
const TAB = 1;
const POPUP_SENDER = { id: EXT, url: `chrome-extension://${EXT}/src/popup/popup.html` };
const USER = { id: "anon-1234-5678-abcd", email: "", isAnonymous: true };
const SEARCH_URL = "https://www.linkedin.com/jobs/search-results/?currentJobId=4400000000";
const contentSender = (tabId = TAB, url = SEARCH_URL) => ({ id: EXT, url, tab: { id: tabId }, frameId: 0 });
const settle = async () => { for (let i = 0; i < 12; i++) await tick(0); };
const cards = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ source: "card", jobId: String(4400000000 + from + i), url: `https://www.linkedin.com/jobs/view/${4400000000 + from + i}/`, title: `Job ${from + i}`, company: "Acme", location: "Pune" }));
const openJob = (id = 4400000000) => ({ source: "detail", jobId: String(id), url: `https://www.linkedin.com/jobs/view/${id}/`, title: `Job ${id - 4400000000}`, company: "Acme", location: "", description: `Full description of job ${id - 4400000000}`, workplaceType: "Remote", applicationStatus: "open" });
const page = (n = 25, { from = 0, detail = openJob() } = {}) => ({ ok: true, layout: "search-results", detail, detailReason: detail ? "ok" : "no-detail-panel", failedSelectors: [], fieldSources: {}, cards: cards(n, from) });

async function waitFor(cond, what = "condition") {
  for (let i = 0; i < 400; i++) { if (await cond()) return; await tick(1); }
  throw new Error(`timed out waiting for ${what}`);
}

const windows = [];
test.afterEach(() => { while (windows.length) windows.pop().close(); });

// A fake Supabase: upsert keyed by linkedin_job_id, non-empty values win, empty ones never erase (like the real RPC).
function fakeDb({ hook } = {}) {
  const rows = new Map();
  const calls = [];
  const client = fakeClient({
    onRpc: async (name, args) => {
      calls.push(args.p_jobs.map((r) => r.linkedin_job_id));
      if (hook) { const r = await hook(calls.length, args.p_jobs); if (r !== undefined) return r; }
      let inserted = 0;
      for (const row of args.p_jobs) {
        const prev = rows.get(row.linkedin_job_id);
        if (!prev) { rows.set(row.linkedin_job_id, row); inserted++; continue; }
        const merged = { ...prev };
        for (const [k, v] of Object.entries(row)) if (v != null && v !== "" && !(Array.isArray(v) && !v.length)) merged[k] = v;
        rows.set(row.linkedin_job_id, merged);
      }
      return { data: { inserted, duplicates: args.p_jobs.length - inserted }, error: null };
    },
  });
  return { rows, calls, save: (jobs) => saveJobs(client, jobs) };
}

// The "browser": what each tab currently shows, a storage area that notifies listeners, the worker's handlers.
function makeExtension({ db = fakeDb(), store = createMemoryWatchStore(), sources } = {}) {
  const tabs = new Map([[TAB, { url: SEARCH_URL, snapshot: page() }]]);
  const listeners = [];
  const reads = [];
  const notifying = {
    get: () => store.get(),
    set: async (s) => { await store.set(s); for (const l of [...listeners]) { try { l({ [WATCH_KEY]: { newValue: JSON.parse(JSON.stringify(s)) } }, "local"); } catch { /* closed popup */ } } },
  };
  const watch = createWatchSession({
    store: notifying,
    save: db.save,
    limits: { ...WATCH_LIMITS, settleMs: 0, retryMs: 0 },
    checkTab: async (id) => tabs.has(id) && tabs.get(id).url.startsWith("https://www.linkedin.com/"),
    pullSnapshot: async (id) => { reads.push(id); const t = tabs.get(id); if (!t) throw new Error("No tab"); return typeof t.snapshot === "function" ? t.snapshot() : t.snapshot; },
  });
  const handle = createHandlers({
    getClient: () => ({}),
    checkConfig: () => ({ ok: true, reason: "" }),
    isTrustedSender: makeIsTrustedSender(EXT),
    isContentSender: makeIsLinkedInContentSender(EXT),
    watch,
    sources,
    watchPreflight: async () => {},
  });
  // The user browses: the tab shows a new page and our content script sends its data-free ping.
  const browse = async (snapshot, { tabId = TAB } = {}) => {
    tabs.get(tabId).snapshot = snapshot;
    return handle({ type: "PAGE_CHANGED" }, contentSender(tabId));
  };
  const idle = () => waitFor(async () => { if (watch.isBusy()) return false; const s = await watch.getState(); return !s || s.status !== "watching" || s.current === "watching"; }, "the session to be idle");
  return { db, watch, handle, listeners, tabs, reads, browse, idle, store };
}

async function openPopup(ext, { pageUrl = SEARCH_URL, tabId = TAB, online = true, saveCards = true } = {}) {
  const dom = new JSDOM(HTML, { url: POPUP_SENDER.url, runScripts: "outside-only" });
  const w = dom.window;
  windows.push(w);
  Object.defineProperty(w.navigator, "onLine", { get: () => online });
  const sent = [];
  w.chrome = {
    tabs: {
      query: async () => [{ id: tabId, url: pageUrl }],
      create: () => {},
      sendMessage: async (id, msg) => {
        if (msg.type === "GET_PAGE_INFO") return { ok: true };
        if (msg.type === "EXTRACT_PREVIEW") return ext.tabs.get(id).snapshot;
        return undefined;
      },
    },
    runtime: {
      getURL: (p) => `chrome-extension://${EXT}/${p}`,
      sendMessage: async (raw) => {
        const msg = JSON.parse(JSON.stringify(raw));
        sent.push(msg);
        if (msg.type.startsWith("WATCH_")) return ext.handle(msg, POPUP_SENDER);
        if (msg.type === "AUTH_STATUS") return { ok: true, configured: true, user: USER, sessionReplaced: false };
        if (msg.type === "COUNT_SAVED") return { ok: true, count: ext.db.rows.size };
        if (msg.type === "SAVE_JOBS") return { ok: true, result: await ext.db.save(msg.jobs) };
        if (msg.type === "PING") return { ok: true };
        return { ok: false, error: { code: "UNKNOWN", message: `unhandled ${msg.type}` } };
      },
    },
    storage: { onChanged: { addListener: (l) => ext.listeners.push(l) }, local: { get: async (k) => (k === "ljs:prefs" ? { "ljs:prefs": { saveCards } } : {}), set: async () => {} } },
  };
  w.eval(POPUP_JS);
  await settle();
  const $ = (id) => w.document.getElementById(id);
  const click = async (id) => { $(id).click(); await settle(); };
  const k = () => Object.fromEntries(["pages", "discovered", "processed", "saved", "existing", "skipped", "failed"].map((n) => [n, Number($(`k-${n}`).textContent)]));
  return { w, $, click, sent, k, types: () => sent.map((m) => m.type), status: () => $("collect-status").textContent };
}
const disabled = (p, ...ids) => Object.fromEntries(ids.map((id) => [id, p.$(id).disabled]));

// ================================================================== Start once, then the user browses
test("Start saves the page on screen in batches of 5 and keeps auto-save on", async () => {
  const ext = makeExtension();
  const p = await openPopup(ext);
  assert.deepEqual(disabled(p, "btn-start", "btn-stop"), { "btn-start": false, "btn-stop": true });
  await p.click("btn-start");
  await ext.idle();
  await settle();
  assert.deepEqual(ext.db.calls.map((c) => c.length), [5, 5, 5, 5, 5], "bounded batches, one after another");
  assert.deepEqual(p.k(), { pages: 1, discovered: 25, processed: 25, saved: 25, existing: 0, skipped: 0, failed: 0 });
  assert.match(p.status(), /^Auto-save is on: 25 new jobs saved, 0 already saved \(updated\), 0 skipped, 24 partial, 0 failed\. Keep browsing/);
  assert.equal(ext.db.rows.get("4400000000").description, "Full description of job 0", "the open job's card and details became one full record");
  assert.equal(ext.db.rows.get("4400000000").location, "Pune", "an empty detail value did not erase the card's value");
  assert.deepEqual(disabled(p, "btn-start", "btn-stop"), { "btn-start": true, "btn-stop": false }, "Start once; Stop ends it");
  assert.equal(p.$("collect-bar").getAttribute("aria-valuenow"), "100");
});

test("when the user clicks Next, the new page is saved automatically; the previous page is not saved again", async () => {
  const ext = makeExtension();
  const p = await openPopup(ext);
  await p.click("btn-start");
  await ext.idle();
  const res = await ext.browse(page(25, { from: 25, detail: null })); // the user clicked Next
  assert.deepEqual(res, { ok: true, watching: true });
  await waitFor(async () => (await ext.watch.getState()).counters.processed === 50, "page 2 to be saved");
  await ext.idle();
  await settle();
  assert.deepEqual(p.k(), { pages: 2, discovered: 50, processed: 50, saved: 50, existing: 0, skipped: 0, failed: 0 });
  assert.equal(ext.db.calls.length, 10, "5 batches per page, page 1 was not re-sent");
  assert.equal(ext.db.rows.size, 50);
  // Page changes that bring nothing new (LinkedIn re-rendering, going back) cost no save at all.
  await ext.browse(page(25, { from: 0, detail: null }));
  await ext.idle();
  assert.equal(ext.db.calls.length, 10);
});

test("opening a job whose card was saved earlier saves its full details once (an update, not a duplicate)", async () => {
  const ext = makeExtension();
  ext.tabs.get(TAB).snapshot = page(10, { detail: null });
  const p = await openPopup(ext);
  await p.click("btn-start");
  await ext.idle();
  assert.equal(ext.db.rows.get("4400000003").description ?? null, null, "a card has no description");
  await ext.browse(page(10, { detail: openJob(4400000003) })); // the user clicked job 3
  await ext.idle();
  await settle();
  assert.equal(ext.db.rows.get("4400000003").description, "Full description of job 3");
  assert.equal(ext.db.rows.size, 10);
  assert.deepEqual(p.k(), { pages: 2, discovered: 10, processed: 11, saved: 10, existing: 1, skipped: 0, failed: 0 });
  await ext.browse(page(10, { detail: openJob(4400000003) })); // same job still open
  await ext.idle();
  assert.equal(ext.db.calls.length, 3, "2 batches for the page + 1 for the details; nothing more");
});

test("pings from another tab, from a web page, or after Stop are ignored; only the watched tab is ever read", async () => {
  const ext = makeExtension();
  ext.tabs.set(2, { url: SEARCH_URL, snapshot: page(5, { from: 900 }) });
  const p = await openPopup(ext);
  await p.click("btn-start");
  await ext.idle();
  const readsBefore = ext.reads.length;
  assert.deepEqual(await ext.handle({ type: "PAGE_CHANGED" }, contentSender(2)), { ok: true, watching: false }, "another LinkedIn tab");
  const evil = await ext.handle({ type: "PAGE_CHANGED" }, { id: EXT, url: "https://evil.example/", tab: { id: TAB }, frameId: 0 });
  assert.equal(evil.error.code, "PERMISSION");
  const frame = await ext.handle({ type: "PAGE_CHANGED" }, { ...contentSender(), frameId: 3 });
  assert.equal(frame.error.code, "PERMISSION", "only the top frame");
  const other = await ext.handle({ type: "PAGE_CHANGED" }, { id: "someotherextension", url: SEARCH_URL, tab: { id: TAB }, frameId: 0 });
  assert.equal(other.error.code, "PERMISSION");
  await settle();
  assert.equal(ext.reads.length, readsBefore);
  await p.click("btn-stop");
  await ext.browse(page(25, { from: 100 }));
  await settle();
  assert.equal(ext.reads.length, readsBefore, "nothing is read after Stop");
  assert.equal(ext.db.rows.size, 25);
});

test("the content script can only ping: it cannot save, list or control auto-save", async () => {
  const ext = makeExtension();
  for (const type of ["SAVE_JOBS", "WATCH_START", "WATCH_STOP", "WATCH_STATUS"]) {
    const res = await ext.handle({ type, jobs: cards(1), tabId: TAB }, contentSender());
    assert.equal(res.error.code, "PERMISSION", type);
  }
  const popupPing = await ext.handle({ type: "PAGE_CHANGED" }, POPUP_SENDER);
  assert.equal(popupPing.error.code, "PERMISSION", "PAGE_CHANGED must come from a LinkedIn tab");
});

// ================================================================== Stop
test("Stop during saving: the save in progress completes, no further batch starts, saved jobs stay", async () => {
  const hold = gate();
  const ext = makeExtension({ db: fakeDb({ hook: async (call) => { if (call === 2) await hold.promise; } }) });
  const p = await openPopup(ext);
  p.$("btn-start").click();
  await waitFor(() => ext.db.calls.length >= 2, "the second batch");
  await settle();
  assert.equal(p.status(), "Saving... 5 of 25 processed.");
  await p.click("btn-stop");
  hold.open();
  await ext.idle();
  await settle();
  assert.match(p.status(), /^Stopped by you\. 10 new jobs saved, 0 already saved \(updated\), 0 skipped, 9 partial, 0 failed from 1 page\. Jobs saved so far are kept\./);
  assert.equal(ext.db.calls.length, 2, "no batch after the Stop");
  assert.equal(ext.db.rows.size, 10);
  assert.deepEqual(disabled(p, "btn-start", "btn-stop"), { "btn-start": false, "btn-stop": true });
});

test("Start after Stop begins a new session from the page on screen; jobs saved before are updated, not duplicated", async () => {
  const ext = makeExtension();
  const p = await openPopup(ext);
  await p.click("btn-start");
  await ext.idle();
  await p.click("btn-stop");
  await p.click("btn-start");
  await ext.idle();
  await settle();
  assert.deepEqual(p.k(), { pages: 1, discovered: 25, processed: 25, saved: 0, existing: 25, skipped: 0, failed: 0 });
  assert.equal(ext.db.rows.size, 25);
  assert.equal(ext.db.rows.get("4400000000").description, "Full description of job 0");
});

test("a Stop meant for an older session is refused and does not end the current one", async () => {
  const ext = makeExtension();
  const p = await openPopup(ext);
  await p.click("btn-start");
  await ext.idle();
  const old = (await ext.watch.getState()).sessionId;
  await p.click("btn-stop");
  await p.click("btn-start");
  await ext.idle();
  const res = await ext.handle({ type: "WATCH_STOP", sessionId: old }, POPUP_SENDER);
  assert.equal(res.error.code, "stale-session");
  assert.equal((await ext.watch.getState()).status, "watching");
});

test("closing the watched tab ends auto-save and says why", async () => {
  const ext = makeExtension();
  const p = await openPopup(ext);
  await p.click("btn-start");
  await ext.idle();
  await ext.watch.tabClosed(TAB);
  await settle();
  assert.match(p.status(), /^Stopped because the LinkedIn tab was closed\. 25 new jobs saved/);
});

test("an extension reload or browser restart ends auto-save; a plain worker wake-up keeps it on", async () => {
  const ext = makeExtension();
  const p = await openPopup(ext);
  await p.click("btn-start");
  await ext.idle();
  await ext.watch.recover("sw-wake");
  assert.equal((await ext.watch.getState()).status, "watching");
  await ext.watch.recover("extension-reload");
  await settle();
  assert.match(p.status(), /^Stopped because the extension was reloaded/);
});

// ================================================================== errors
test("a connection failure is shown and retried automatically; nothing is counted as failed or saved twice", async () => {
  let offline = true;
  const ext = makeExtension({ db: fakeDb({ hook: async (call) => { if (call === 2 && offline) { offline = false; throw new TypeError("Failed to fetch"); } } }) });
  const p = await openPopup(ext);
  await p.click("btn-start");
  await waitFor(async () => (await ext.watch.getState()).counters.processed === 25, "the retry to finish");
  await ext.idle();
  await settle();
  assert.deepEqual(p.k(), { pages: 1, discovered: 25, processed: 25, saved: 25, existing: 0, skipped: 0, failed: 0 });
  assert.equal(ext.db.rows.size, 25);
  assert.equal(p.$("collect-error").hidden, true, "the problem line clears after a successful save");
});

test("a batch the database rejects is counted as failed and auto-save keeps going; unusable records are skipped", async () => {
  const bad = { source: "card", jobId: "4499999999", url: "https://www.linkedin.com/jobs/view/4499999999/" }; // no title/company/description
  const ext = makeExtension({ db: fakeDb({ hook: async (call) => (call === 1 ? { data: null, error: { code: "23514", message: "violates check constraint" } } : undefined) }) });
  ext.tabs.get(TAB).snapshot = { ...page(9, { detail: null }), cards: [...cards(9), bad] };
  const p = await openPopup(ext);
  await p.click("btn-start");
  await ext.idle();
  await settle();
  assert.deepEqual(p.k(), { pages: 1, discovered: 10, processed: 10, saved: 4, existing: 0, skipped: 1, failed: 5 });
  assert.match(p.$("collect-error").textContent, /^Last problem: /);
  assert.match(p.status(), /^Auto-save is on/);
});

test("if the tab cannot be read, auto-save says so and stays on for the next page", async () => {
  const ext = makeExtension();
  ext.tabs.get(TAB).snapshot = () => { throw new Error("Could not establish connection"); };
  const p = await openPopup(ext);
  await p.click("btn-start");
  await ext.idle();
  await settle();
  assert.match(p.$("collect-error").textContent, /Could not read the LinkedIn tab/);
  await ext.browse(page(5));
  await ext.idle();
  assert.equal(ext.db.rows.size, 5);
});

// ================================================================== popup lifecycle
test("closing and reopening the popup shows the live session; another tab sees it too and can Stop it", async () => {
  const hold = gate();
  const ext = makeExtension({ db: fakeDb({ hook: async (call) => { if (call === 3) await hold.promise; } }) });
  const a = await openPopup(ext);
  a.$("btn-start").click();
  await waitFor(() => ext.db.calls.length >= 3, "the third batch");
  a.w.close();
  const b = await openPopup(ext);
  assert.equal(b.status(), "Saving... 10 of 25 processed.");
  hold.open();
  await ext.idle();
  ext.tabs.set(7, { url: SEARCH_URL, snapshot: page(1) });
  const c = await openPopup(ext, { tabId: 7 });
  assert.match(c.$("collect-detail").textContent, /Auto-save is on for another LinkedIn tab/);
  assert.deepEqual(disabled(c, "btn-start", "btn-stop"), { "btn-start": true, "btn-stop": false });
  await c.click("btn-stop");
  assert.equal((await ext.watch.getState()).status, "stopped");
});

// ================================================================== guidance
test("not on LinkedIn or offline: clear guidance and nothing starts", async () => {
  const ext = makeExtension();
  const away = await openPopup(ext, { pageUrl: "https://example.com/" });
  assert.deepEqual(disabled(away, "btn-start", "btn-stop"), { "btn-start": true, "btn-stop": true });
  assert.match(away.status(), /Open a LinkedIn jobs page/);
  const off = await openPopup(ext, { online: false });
  await off.click("btn-start");
  assert.match(off.status(), /offline/);
  assert.ok(![away, off].some((p) => p.types().includes("WATCH_START")));
  const direct = await ext.handle({ type: "WATCH_START", tabId: 99 }, POPUP_SENDER);
  assert.equal(direct.error.code, "invalid-tab", "the worker checks the tab is a LinkedIn tab");
  assert.equal(await ext.watch.getState(), null);
});

test("Save open job only still saves just the open job through the same merge-safe path", async () => {
  const ext = makeExtension();
  const p = await openPopup(ext);
  await p.click("btn-save-job");
  assert.equal(p.$("status").textContent, "1 new job saved. Applications are open.");
  assert.equal(ext.db.rows.size, 1);
  assert.ok(!p.types().includes("WATCH_START"));
});

// ------------------------------------------------------------------ default mode: only opened jobs, guided checklist
test("default (cards not saved): Start saves the open job only, shows the checklist and the next job to open", async () => {
  const ext = makeExtension();
  const p = await openPopup(ext, { saveCards: false });
  assert.equal(p.$("opt-save-cards").checked, false);
  await p.click("btn-start");
  await ext.idle();
  await settle();
  assert.deepEqual(ext.db.calls, [["4400000000"]], "one save: the open job with its details");
  assert.equal(ext.db.rows.get("4400000000").description, "Full description of job 0");
  assert.equal(ext.db.rows.size, 1, "no card-only rows were created");
  assert.equal(`${p.$("job-state").textContent} ${p.$("job-name").textContent}`, "Full details saved: Job 0 - Acme");
  assert.match(p.$("collect-guide").textContent, /^This page: 1 of 25 jobs saved with full details\. Next to save: Job 1 - Acme \(marked "Next to save" in the list; click it yourself\)\.$/);
  assert.equal(p.$("k-full").textContent, "1");
  assert.equal(p.$("collect-bar").getAttribute("aria-valuenow"), "4");
  assert.equal(p.$("opt-save-cards").disabled, true, "the option is fixed while auto-save runs");
  assert.ok(p.sent.some((m) => m.type === "WATCH_START" && m.saveCards === false));
  // The user opens job 3 in LinkedIn: saved with details; the checklist moves on.
  await ext.browse(page(25, { detail: openJob(4400000003) }));
  await ext.idle();
  await settle();
  assert.equal(ext.db.rows.size, 2);
  assert.match(p.$("collect-guide").textContent, /This page: 2 of 25 jobs saved with full details\. Next to save: Job 1 - Acme/);
});

test("'Also save list cards' is sent to the worker and remembered", async () => {
  const ext = makeExtension();
  const p = await openPopup(ext, { saveCards: true });
  assert.equal(p.$("opt-save-cards").checked, true, "restored from the saved preference");
  await p.click("btn-start");
  await ext.idle();
  assert.ok(p.sent.some((m) => m.type === "WATCH_START" && m.saveCards === true));
  assert.equal(ext.db.rows.size, 25);
});

// ------------------------------------------------------------------ automatic collection: only from an authorised source
test("no authorised source configured: the popup says automatic collection is not available (never claims it)", async () => {
  const ext = makeExtension();
  const p = await openPopup(ext);
  assert.match(p.$("collect-auto").textContent, /^Automatic job-to-job or page-to-page collection is not available: no authorised job-data source is configured, and LinkedIn is never clicked or paged automatically\./);
  const st = await ext.handle({ type: "WATCH_STATUS" }, POPUP_SENDER);
  assert.deepEqual(st.automaticSources, []);
  // The one registered source (the LinkedIn page snapshot) cannot fetch jobs by itself.
  const { createLinkedInPageSource } = await import("../src/sources/linkedin-page.js");
  assert.equal(createLinkedInPageSource().automatic, false);
});

test("the popup reflects the worker's configuration: an automatic source would be named, not assumed", async () => {
  const ext = makeExtension({ sources: { list: () => [{ id: "authorised-api", label: "Example authorised API", automatic: true }, { id: "linkedin-page", label: "LinkedIn page", automatic: false }] } });
  const p = await openPopup(ext);
  assert.equal(p.$("collect-auto").textContent, "Automatic collection is available from: Example authorised API.");
});

test("a second Start while auto-save is on is refused; the running session and its first read are untouched", async () => {
  const ext = makeExtension();
  const p = await openPopup(ext);
  await p.click("btn-start");
  await ext.idle();
  const first = (await ext.watch.getState()).sessionId;
  const again = await ext.handle({ type: "WATCH_START", tabId: TAB }, POPUP_SENDER);
  assert.equal(again.error.code, "watch-active");
  const s = await ext.watch.getState();
  assert.deepEqual([s.sessionId, s.status, s.counters.saved], [first, "watching", 25]);
  assert.equal(p.$("btn-start").disabled, true, "the popup does not offer Start while a session runs");
});

test("PAGE_CHANGED: only a strict 'ready: true' is passed on; everything else in the ping is ignored", async () => {
  const calls = [];
  const fakeWatch = { pageChanged: async (tabId, opts) => { calls.push([tabId, opts]); return true; }, getState: async () => null };
  const handle = createHandlers({
    getClient: () => ({}), checkConfig: () => ({ ok: true }), isTrustedSender: makeIsTrustedSender(EXT), isContentSender: makeIsLinkedInContentSender(EXT), watch: fakeWatch,
  });
  await handle({ type: "PAGE_CHANGED", ready: true }, contentSender());
  await handle({ type: "PAGE_CHANGED", ready: "yes", jobs: [{ jobId: "1" }] }, contentSender());
  await handle({ type: "PAGE_CHANGED" }, contentSender());
  assert.deepEqual(calls, [[TAB, { ready: true }], [TAB, { ready: false }], [TAB, { ready: false }]]);
  const fromPage = await handle({ type: "PAGE_CHANGED", ready: true }, { id: EXT, url: "https://evil.example/", tab: { id: TAB }, frameId: 0 });
  assert.equal(fromPage.error.code, "PERMISSION");
});
