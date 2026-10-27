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
import { PROTOCOL } from "../src/shared/messages.js";
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

async function openPopup(ext, { pageUrl = SEARCH_URL, tabId = TAB, online = true, prefs } = {}) {
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
        if (msg.type === "PING") return ext.ping || { ok: true, protocol: PROTOCOL };
        return { ok: false, error: { code: "UNKNOWN", message: `unhandled ${msg.type}` } };
      },
    },
    storage: { onChanged: { addListener: (l) => ext.listeners.push(l) }, local: { get: async (k) => (k === "ljs:prefs" ? { "ljs:prefs": prefs || { autoClick: false, v: 2 } } : {}), set: async () => {} } },
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
test("Start saves the open job with its full details and keeps auto-save on; list cards are never saved", async () => {
  const ext = makeExtension();
  const p = await openPopup(ext);
  assert.equal(p.$("opt-save-cards"), null, "the 'Also save list cards' option is gone");
  assert.deepEqual(disabled(p, "btn-start", "btn-stop"), { "btn-start": false, "btn-stop": true });
  await p.click("btn-start");
  await ext.idle();
  await settle();
  assert.deepEqual(ext.db.calls, [["4400000000"]], "one save: the open job, not the 24 other cards on the page");
  assert.deepEqual(p.k(), { pages: 1, discovered: 25, processed: 1, saved: 1, existing: 0, skipped: 0, failed: 0 });
  assert.match(p.status(), /^Auto-save is on: 1 new job saved, 0 already saved \(updated\), 0 skipped, 0 partial, 0 failed\. Click the next job/);
  assert.equal(ext.db.rows.get("4400000000").description, "Full description of job 0", "the open job's card and details became one full record");
  assert.equal(ext.db.rows.get("4400000000").location, "Pune", "an empty detail value did not erase the card's value");
  assert.equal(ext.db.rows.size, 1, "no card-only rows");
  assert.deepEqual(disabled(p, "btn-start", "btn-stop"), { "btn-start": true, "btn-stop": false }, "Start once; Stop ends it");
  assert.equal(p.$("collect-bar").getAttribute("aria-valuenow"), "4", "1 of the 25 listed jobs saved with full details");
});

test("on the next results page nothing is saved until a job is opened; each opened job is saved once", async () => {
  const ext = makeExtension();
  const p = await openPopup(ext);
  await p.click("btn-start");
  await ext.idle();
  const res = await ext.browse(page(25, { from: 25, detail: null })); // the user clicked Next
  assert.deepEqual(res, { ok: true, watching: true });
  await ext.idle();
  await settle();
  assert.equal(ext.db.calls.length, 1, "a page of cards alone costs no save");
  assert.equal((await ext.watch.getState()).counters.discovered, 50, "but its jobs are listed");
  await ext.browse(page(25, { from: 25, detail: openJob(4400000030) })); // the user opened job 30
  await waitFor(async () => (await ext.watch.getState()).counters.processed === 2, "job 30 to be saved");
  await ext.idle();
  await settle();
  assert.deepEqual(p.k(), { pages: 2, discovered: 50, processed: 2, saved: 2, existing: 0, skipped: 0, failed: 0 });
  assert.equal(ext.db.rows.size, 2);
  // Page changes that bring nothing new (LinkedIn re-rendering, going back) cost no save at all.
  await ext.browse(page(25, { from: 25, detail: openJob(4400000030) }));
  await ext.idle();
  assert.equal(ext.db.calls.length, 2);
});

test("a job saved earlier from its list card (older versions) is upgraded to full details when opened: an update, not a duplicate", async () => {
  const ext = makeExtension();
  await ext.db.save([cards(10)[3]]); // a "Card only" row left by an older version
  assert.equal(ext.db.rows.get("4400000003").description ?? null, null, "a card has no description");
  ext.tabs.get(TAB).snapshot = page(10, { detail: openJob(4400000003) }); // the user opened job 3
  const p = await openPopup(ext);
  await p.click("btn-start");
  await ext.idle();
  await settle();
  assert.equal(ext.db.rows.get("4400000003").description, "Full description of job 3");
  assert.equal(ext.db.rows.size, 1);
  assert.deepEqual(p.k(), { pages: 1, discovered: 10, processed: 1, saved: 0, existing: 1, skipped: 0, failed: 0 });
  await ext.browse(page(10, { detail: openJob(4400000003) })); // same job still open
  await ext.idle();
  assert.equal(ext.db.calls.length, 2, "the old card save + 1 for the details; nothing more");
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
  assert.equal(ext.db.rows.size, 1, "only the job that was open");
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
test("Stop during saving: the save in progress completes and is kept; nothing is saved after Stop", async () => {
  const hold = gate();
  const ext = makeExtension({ db: fakeDb({ hook: async (call) => { if (call === 1) await hold.promise; } }) });
  const p = await openPopup(ext);
  p.$("btn-start").click();
  await waitFor(() => ext.db.calls.length >= 1, "the first save");
  await settle();
  assert.equal(p.status(), "Saving... 0 processed.");
  await p.click("btn-stop");
  hold.open();
  await ext.idle();
  await settle();
  assert.match(p.status(), /^Stopped by you\. 1 new job saved, 0 already saved \(updated\), 0 skipped, 0 partial, 0 failed from 1 page\. Jobs saved so far are kept\./);
  await ext.browse(page(25, { detail: openJob(4400000005) }));
  await settle();
  assert.equal(ext.db.calls.length, 1, "no save after the Stop");
  assert.equal(ext.db.rows.size, 1);
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
  assert.deepEqual(p.k(), { pages: 1, discovered: 25, processed: 1, saved: 0, existing: 1, skipped: 0, failed: 0 });
  assert.equal(ext.db.rows.size, 1);
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
  assert.match(p.status(), /^Stopped because the LinkedIn tab was closed\. 1 new job saved/);
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
  const ext = makeExtension({ db: fakeDb({ hook: async (call) => { if (call === 1 && offline) { offline = false; throw new TypeError("Failed to fetch"); } } }) });
  const p = await openPopup(ext);
  await p.click("btn-start");
  await waitFor(async () => (await ext.watch.getState()).counters.processed === 1, "the retry to finish");
  await ext.idle();
  await settle();
  assert.deepEqual(p.k(), { pages: 1, discovered: 25, processed: 1, saved: 1, existing: 0, skipped: 0, failed: 0 });
  assert.equal(ext.db.calls.length, 2, "the failed attempt + the retry");
  assert.equal(ext.db.rows.size, 1);
  assert.equal(p.$("collect-error").hidden, true, "the problem line clears after a successful save");
});

test("a job the database rejects is counted as failed and auto-save keeps going; an unusable open job is skipped", async () => {
  const bad = { source: "detail", jobId: "4499999999", url: "https://www.linkedin.com/jobs/view/4499999999/" }; // no title/company/description
  const ext = makeExtension({ db: fakeDb({ hook: async (call) => (call === 1 ? { data: null, error: { code: "23514", message: "violates check constraint" } } : undefined) }) });
  ext.tabs.get(TAB).snapshot = page(9);
  const p = await openPopup(ext);
  await p.click("btn-start");
  await ext.idle();
  await settle();
  assert.deepEqual(p.k(), { pages: 1, discovered: 9, processed: 1, saved: 0, existing: 0, skipped: 0, failed: 1 });
  assert.match(p.$("collect-error").textContent, /^Last problem: /);
  await ext.browse({ ...page(9, { detail: bad }), cards: [...cards(9)] }); // the user opened a job with nothing usable
  await ext.idle();
  await settle();
  assert.deepEqual(p.k(), { pages: 2, discovered: 10, processed: 2, saved: 0, existing: 0, skipped: 1, failed: 1 });
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
  assert.equal(ext.db.rows.size, 1, "the job open on the next readable page is saved");
});

// ================================================================== popup lifecycle
test("closing and reopening the popup shows the live session; another tab sees it too and can Stop it", async () => {
  const hold = gate();
  const ext = makeExtension({ db: fakeDb({ hook: async (call) => { if (call === 1) await hold.promise; } }) });
  const a = await openPopup(ext);
  a.$("btn-start").click();
  await waitFor(() => ext.db.calls.length >= 1, "the first save");
  a.w.close();
  const b = await openPopup(ext);
  assert.equal(b.status(), "Saving... 0 processed.");
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
test("Start saves the open job only, shows the checklist and the next job to open", async () => {
  const ext = makeExtension();
  const p = await openPopup(ext);
  await p.click("btn-start");
  await ext.idle();
  await settle();
  assert.deepEqual(ext.db.calls, [["4400000000"]], "one save: the open job with its details");
  assert.equal(ext.db.rows.get("4400000000").description, "Full description of job 0");
  assert.equal(ext.db.rows.size, 1, "no card-only rows were created");
  assert.equal(`${p.$("job-state").textContent} ${p.$("job-name").textContent}`, "Full details saved: Job 0 - Acme");
  assert.match(p.$("collect-guide").textContent, /^This page: 1 of 25 jobs saved with full details\. Next to save: Job 1 - Acme \(marked ▶ under "Jobs on this page" below; click it yourself\)\.$/);
  assert.equal(p.$("k-full").textContent, "1");
  assert.equal(p.$("collect-bar").getAttribute("aria-valuenow"), "4");
  assert.ok(p.sent.some((m) => m.type === "WATCH_START" && !("saveCards" in m)), "no list-card option is sent");
  // The user opens job 3 in LinkedIn: saved with details; the checklist moves on.
  await ext.browse(page(25, { detail: openJob(4400000003) }));
  await ext.idle();
  await settle();
  assert.equal(ext.db.rows.size, 2);
  assert.match(p.$("collect-guide").textContent, /This page: 2 of 25 jobs saved with full details\. Next to save: Job 1 - Acme/);
});

test("'Also save list cards' is gone: a remembered saveCards:true is ignored, and the worker refuses to save cards even if asked", async () => {
  const ext = makeExtension();
  const p = await openPopup(ext, { prefs: { saveCards: true, autoClick: false, maxPages: 5, v: 2 } }); // saved by 0.13.0
  assert.equal(p.$("opt-save-cards"), null);
  await p.click("btn-start");
  await ext.idle();
  const start = p.sent.find((m) => m.type === "WATCH_START");
  assert.ok(start && !("saveCards" in start), "the old preference is not sent");
  assert.equal(ext.db.rows.size, 1, "only the open job");
  // A stale popup (or anything else) asking the worker for list cards directly changes nothing.
  await p.click("btn-stop");
  await ext.handle({ type: "WATCH_START", tabId: TAB, saveCards: true }, POPUP_SENDER);
  await ext.idle();
  assert.equal(ext.db.rows.size, 1);
  assert.ok(!("saveCards" in (await ext.watch.getState())));
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
  assert.deepEqual([s.sessionId, s.status, s.counters.saved], [first, "watching", 1]);
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

// ------------------------------------------------------------------ per-job list in the popup
test("popup lists every job on the page with its tracking status; next job marked; text only", async () => {
  const ext = makeExtension();
  ext.tabs.get(TAB).snapshot = { ...page(4, { detail: openJob(4400000001) }), cards: [...cards(3), { ...cards(1, 3)[0], title: "<img src=x onerror=alert(1)>" }] };
  const p = await openPopup(ext);
  await p.click("btn-start");
  await ext.idle();
  await settle();
  const rows = [...p.w.document.querySelectorAll("#job-items li")].map((li) => li.textContent);
  assert.equal(p.$("job-list").hidden, false);
  assert.equal(p.$("job-count").textContent, "4");
  assert.equal(rows.length, 4);
  assert.equal(rows[0], "▶ Job 0 - Acme: next to save");
  assert.match(rows[1], /^Job 1 - Acme: full details saved$/, "the opened job, confirmed by the database");
  assert.match(rows[2], /^Job 2 - Acme: listed$/);
  assert.match(rows[3], /^<img src=x onerror=alert\(1\)> - Acme: listed$/);
  assert.equal(p.$("job-items").querySelector("img"), null, "saved text is never interpreted as HTML");
  assert.equal([...p.w.document.querySelectorAll("#job-items li")][0].dataset.mark, "next");
});

test("popup list shows failures and unreadable details with the reason; and the list clears when auto-save is off", async () => {
  const ext = makeExtension({ db: fakeDb({ hook: async () => ({ data: null, error: { code: "23514", message: "violates check constraint" } }) }) });
  const p = await openPopup(ext);
  await p.click("btn-start");
  await ext.idle();
  await settle();
  const first = p.w.document.querySelector("#job-items li").textContent;
  assert.match(first, /^Job 0 - Acme: failed: The data was rejected by the database \(23514\)\.$/);
  await p.click("btn-stop");
  assert.equal(p.$("job-list").hidden, true, "nothing is listed once auto-save is off");
});

// ================================================================== Pause / Resume / Retry (v0.12.0)
test("Pause keeps the session and counters, shows that nothing is saved, and Resume continues; Stop works while paused", async () => {
  const ext = makeExtension();
  const p = await openPopup(ext);
  assert.deepEqual(disabled(p, "btn-watch-pause", "btn-watch-resume"), { "btn-watch-pause": true, "btn-watch-resume": true }, "nothing to pause before Start");
  await p.click("btn-start");
  await ext.idle();
  assert.deepEqual(disabled(p, "btn-watch-pause", "btn-watch-resume"), { "btn-watch-pause": false, "btn-watch-resume": true });
  await p.click("btn-watch-pause");
  await settle();
  assert.match(p.status(), /^Auto-save is paused: jobs you open are NOT saved\. 1 new job saved/);
  assert.deepEqual(disabled(p, "btn-start", "btn-stop", "btn-watch-pause", "btn-watch-resume"), { "btn-start": true, "btn-stop": false, "btn-watch-pause": true, "btn-watch-resume": false });
  assert.equal((await ext.watch.getState()).status, "paused");
  await p.click("btn-watch-resume");
  await ext.idle();
  await settle();
  assert.equal((await ext.watch.getState()).status, "watching");
  assert.match(p.status(), /^Auto-save is on/);
  await p.click("btn-watch-pause");
  await p.click("btn-stop");
  await settle();
  assert.match(p.status(), /^Stopped by you\./);
  assert.deepEqual(disabled(p, "btn-start", "btn-stop", "btn-watch-pause", "btn-watch-resume"), { "btn-start": false, "btn-stop": true, "btn-watch-pause": true, "btn-watch-resume": true });
});

test("Retry is hidden when there is nothing to retry; the content script cannot pause, resume or retry", async () => {
  const ext = makeExtension();
  const p = await openPopup(ext);
  assert.equal(p.$("btn-watch-retry").hidden, true);
  await p.click("btn-start");
  await ext.idle();
  assert.equal(p.$("btn-watch-retry").hidden, true, "a healthy session offers no Retry");
  for (const type of ["WATCH_PAUSE", "WATCH_RESUME", "WATCH_RETRY"]) {
    const res = await ext.handle({ type, tabId: TAB }, contentSender());
    assert.equal(res.error.code, "PERMISSION", type);
  }
  const stale = await ext.handle({ type: "WATCH_PAUSE", sessionId: "old" }, POPUP_SENDER);
  assert.equal(stale.error.code, "stale-session");
  const bad = await ext.handle({ type: "WATCH_RETRY", sessionId: { $ne: 1 } }, POPUP_SENDER);
  assert.equal(bad.ok, true, "a non-string session id is ignored, not trusted");
});

test("after a database problem the popup shows the error with a Retry button; Retry saves now and clears it", async () => {
  let offline = true;
  const ext = makeExtension({ db: fakeDb({ hook: async () => { if (offline) throw new TypeError("Failed to fetch"); } }) });
  const p = await openPopup(ext);
  await p.click("btn-start");
  await ext.idle();
  await settle();
  assert.equal(p.$("collect-error").hidden, false);
  assert.equal(p.$("btn-watch-retry").hidden, false, "a reported problem offers Retry");
  offline = false;
  await p.click("btn-watch-retry");
  await ext.idle();
  await waitFor(async () => (await ext.watch.getState()).counters.saved === 1, "the retried save");
  await settle();
  assert.equal(ext.db.rows.size, 1);
  assert.equal(p.$("collect-error").hidden, true);
  assert.equal(p.$("btn-watch-retry").hidden, true);
});

// ------------------------------------------------------------------ auto-click: the extension opens the jobs itself
test("auto-click: the option and page limit reach the worker; only the watched tab's content script may drive it; it ends the session when finished", async () => {
  const ext = makeExtension();
  const p = await openPopup(ext, { prefs: {} });
  assert.equal(p.$("opt-auto-click").checked, true, "on by default");
  p.$("opt-auto-click").checked = false;
  p.$("opt-auto-click").dispatchEvent(new p.w.Event("change"));
  await settle();
  assert.equal(p.$("opt-max-pages").disabled, true, "the page limit only applies with auto-click");
  p.$("opt-auto-click").checked = true;
  p.$("opt-auto-click").dispatchEvent(new p.w.Event("change"));
  await settle();
  assert.equal(p.$("opt-max-pages").disabled, false);
  p.$("opt-max-pages").value = "3";
  await p.click("btn-start");
  await ext.idle();
  await settle();
  assert.ok(p.sent.some((m) => m.type === "WATCH_START" && m.autoClick === true && m.maxPages === 3));

  // Only our content script in the watched tab is told to click.
  assert.deepEqual(await ext.handle({ type: "PILOT_EVENT", event: "hello" }, contentSender()), { ok: true, pilot: true });
  assert.deepEqual(await ext.handle({ type: "PILOT_EVENT", event: "hello" }, contentSender(2)), { ok: true, pilot: false }, "another LinkedIn tab never clicks");
  assert.equal((await ext.handle({ type: "PILOT_EVENT", event: "hello" }, POPUP_SENDER)).error.code, "PERMISSION");
  assert.equal((await ext.handle({ type: "PILOT_EVENT", event: "hello" }, { ...contentSender(), frameId: 2 })).error.code, "PERMISSION");

  await ext.handle({ type: "PILOT_EVENT", event: "clicked" }, contentSender());
  await ext.handle({ type: "PILOT_EVENT", event: "clicked" }, contentSender(2)); // ignored
  await ext.handle({ type: "PILOT_EVENT", event: "page" }, contentSender());
  await settle();
  assert.match(p.status(), /Auto-click: 1 job opened, page 2 of at most 3\. The extension is opening the jobs one by one/);
  assert.match(p.$("collect-guide").textContent, /the extension opens it next\)/);

  await ext.handle({ type: "PILOT_EVENT", event: "finished", reason: "max-pages" }, contentSender());
  await settle();
  const s = await ext.watch.getState();
  assert.deepEqual([s.status, s.endReason, s.pilot.finishReason], ["stopped", "auto-finished", "max-pages"]);
  assert.match(p.status(), /^Finished: reached the results-page limit you set\./);
  assert.deepEqual(await ext.handle({ type: "PILOT_EVENT", event: "hello" }, contentSender()), { ok: true, pilot: false }, "nothing clicks after the session ended");
});

test("auto-click turned off: the content script is never told to click", async () => {
  const ext = makeExtension();
  const p = await openPopup(ext, { prefs: { autoClick: false, v: 2 } });
  assert.equal(p.$("opt-auto-click").checked, false, "the user's choice is remembered");
  await p.click("btn-start");
  await ext.idle();
  assert.ok(p.sent.some((m) => m.type === "WATCH_START" && m.autoClick === false));
  assert.deepEqual(await ext.handle({ type: "PILOT_EVENT", event: "hello" }, contentSender()), { ok: true, pilot: false });
  await ext.handle({ type: "PILOT_EVENT", event: "finished" }, contentSender());
  assert.equal((await ext.watch.getState()).status, "watching", "a stray 'finished' cannot end a normal session");
});

test("auto-click can be switched on while a session already runs (no Stop / Start needed), and off again", async () => {
  const ext = makeExtension();
  const p = await openPopup(ext, { prefs: { autoClick: false, v: 2 } });
  await p.click("btn-start");
  await ext.idle();
  await settle();
  assert.deepEqual(await ext.handle({ type: "PILOT_EVENT", event: "hello" }, contentSender()), { ok: true, pilot: false });
  assert.match(p.status(), /Or tick "Click through the jobs for me"/);
  assert.equal(p.$("opt-auto-click").disabled, false, "switchable while running");
  p.$("opt-max-pages").value = "7";
  p.$("opt-auto-click").checked = true;
  p.$("opt-auto-click").dispatchEvent(new p.w.Event("change"));
  await settle();
  assert.ok(p.sent.some((m) => m.type === "WATCH_SET_AUTOCLICK" && m.autoClick === true && m.maxPages === 7));
  const s = await ext.watch.getState();
  assert.deepEqual([s.status, s.autoClick, s.pilot.maxPages, s.counters.processed], ["watching", true, 7, 1], "same session, nothing lost");
  assert.deepEqual(await ext.handle({ type: "PILOT_EVENT", event: "hello" }, contentSender()), { ok: true, pilot: true });
  assert.match(p.status(), /The extension is opening the jobs one by one/);
  p.$("opt-auto-click").checked = false;
  p.$("opt-auto-click").dispatchEvent(new p.w.Event("change"));
  await settle();
  assert.equal((await ext.watch.getState()).autoClick, false);
  assert.equal(p.$("opt-auto-click").checked, false);
  assert.equal((await ext.handle({ type: "WATCH_SET_AUTOCLICK", autoClick: true }, contentSender())).error.code, "PERMISSION", "never from the page");
});

test("an extension updated on disk but not reloaded (old worker): a clear banner, and the checkbox says why it cannot switch", async () => {
  const ext = makeExtension();
  const p = await openPopup(ext, { prefs: { autoClick: false, v: 2 } });
  assert.equal(p.$("stale-banner").hidden, true, "same version: no banner");
  await p.click("btn-start");
  await ext.idle();
  // Simulate the old worker: it answers PING without a protocol and ignores messages it does not know.
  ext.ping = { ok: true, from: "service-worker" };
  const old = ext.handle;
  const p2 = await openPopup({ ...ext, handle: (m, s) => (m.type === "WATCH_SET_AUTOCLICK" ? undefined : old(m, s)) }, { prefs: { autoClick: false, v: 2 } });
  await settle();
  assert.equal(p2.$("stale-banner").hidden, false);
  assert.match(p2.$("stale-banner").textContent, /press the reload button on LinkedIn Job Saver, then refresh the LinkedIn tab/);
  p2.$("opt-auto-click").checked = true;
  p2.$("opt-auto-click").dispatchEvent(new p2.w.Event("change"));
  await settle();
  assert.equal(p2.$("opt-auto-click").checked, false, "flips back to the session's real setting");
  assert.equal(p2.$("auto-click-error").hidden, false);
  assert.match(p2.$("auto-click-error").textContent, /the extension must be reloaded first/);
});

test("preferences saved by the first auto-click version (autoClick false, no version) do not untick the new default", async () => {
  const ext = makeExtension();
  const p = await openPopup(ext, { prefs: { autoClick: false, maxPages: 5 } });
  assert.equal(p.$("opt-auto-click").checked, true);
  const p2 = await openPopup(ext, { prefs: { autoClick: false, maxPages: 5, v: 2 } });
  assert.equal(p2.$("opt-auto-click").checked, false, "a choice made in this version is kept");
});
