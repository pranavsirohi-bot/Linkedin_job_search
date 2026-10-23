// Drives the real popup.js (bundled with esbuild) in jsdom against a stubbed chrome API.
// Verifies UI behaviour only; the stubs stand in for the service worker and content script.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { build } from "esbuild";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { outputFiles } = await build({
  entryPoints: [path.join(root, "src/popup/popup.js")], bundle: true, format: "iife", write: false, logLevel: "silent",
});
const POPUP_JS = outputFiles[0].text;
const POPUP_HTML = fs.readFileSync(path.join(root, "src/popup/popup.html"), "utf8").replace(/<script[^>]*><\/script>/, "");

const USER = { id: "anon-1234-5678-abcd", email: "", isAnonymous: true };
const DETAIL = { source: "detail", jobId: "4480218579", url: "https://www.linkedin.com/jobs/view/4480218579/", title: "Junior Graphic Designer", company: "YourfriendlyHR", location: "India", description: "Design things." };
const cards = (n) => Array.from({ length: n }, (_, i) => ({ source: "card", jobId: String(4400000000 + i), title: `Job ${i}`, company: "Acme", location: "Pune" }));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(0); };
const SAVED_OK = (m) => ({ ok: true, result: { total: m.jobs.length, inserted: m.jobs.length, duplicates: 0, rejected: [] } });

const windows = [];
test.afterEach(() => { while (windows.length) windows.pop().close(); });

async function openPopup({ configured = true, user = USER, pageUrl = "https://www.linkedin.com/jobs/view/4480218579/", online = true, extract, worker = {}, storage = {} } = {}) {
  const dom = new JSDOM(POPUP_HTML, { url: "chrome-extension://ext/src/popup/popup.html", runScripts: "outside-only" });
  windows.push(dom.window);
  const w = dom.window;
  Object.defineProperty(w.navigator, "onLine", { get: () => online });
  const sent = []; // every message sent to the service worker
  const defaultExtract = { ok: true, layout: "standalone-job", detail: DETAIL, detailReason: "ok", failedSelectors: [], fieldSources: {}, cards: [] };
  const opened = []; // tabs the popup asked Chrome to open
  const sentToPage = []; // messages the popup sent to the content script
  const downloads = [];
  w.chrome = {
    tabs: {
      create: (o) => { opened.push(o.url); },
      query: async () => [{ id: 1, url: pageUrl }],
      sendMessage: async (_id, msg) => {
        if (msg.type === "GET_PAGE_INFO") return { ok: true };
        if (msg.type === "EXTRACT_PREVIEW") { sentToPage.push(msg); return typeof extract === "function" ? extract() : extract ?? defaultExtract; }
        if (msg.type === "DIAGNOSE") return { ok: true, report: { layout: "standalone-job" } };
        return undefined;
      },
    },
    runtime: {
      getURL: (p) => `chrome-extension://ext/${p}`,
      sendMessage: async (msg) => {
        sent.push(msg);
        if (worker[msg.type]) return worker[msg.type](msg);
        if (msg.type === "AUTH_STATUS") return { ok: true, configured, reason: configured ? "" : "Supabase project URL is not configured.", user: configured ? user : null, sessionReplaced: false };
        if (msg.type === "COUNT_SAVED") return { ok: true, count: 3 };
        if (msg.type === "PING") return { ok: true };
        return { ok: false, error: { code: "UNKNOWN", message: `unhandled ${msg.type}` } };
      },
    },
    storage: {
      local: {
        get: async (k) => (k in storage ? { [k]: JSON.parse(JSON.stringify(storage[k])) } : {}),
        set: async (o) => { for (const [k, v] of Object.entries(o)) storage[k] = JSON.parse(JSON.stringify(v)); },
      },
    },
  };
  w.URL.createObjectURL = (blob) => { downloads.push({ blob }); return "blob:test"; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function click() { if (this.download) downloads.at(-1).name = this.download; };
  w.eval(POPUP_JS);
  await settle();
  const $ = (id) => w.document.getElementById(id);
  const click = async (id) => { $(id).click(); await settle(); };
  const types = () => sent.map((m) => m.type);
  const k = () => Object.fromEntries(["found", "details", "new", "existing", "skipped"].map((n) => [n, Number($(`k-${n}`).textContent)]));
  const readBlob = (blob) => new Promise((resolve) => { const r = new w.FileReader(); r.onload = () => resolve(new TextDecoder().decode(new Uint8Array(r.result))); r.readAsArrayBuffer(blob); });
  return { w, $, click, sent, sentToPage, opened, downloads, storage, types, k, readBlob, status: () => $("status").textContent, statusClass: () => $("status").className, collect: () => $("collect-status").textContent };
}

// ================================================================== layout of the simplified popup
test("the popup is simple: Start, Save open job, progress, Download CSV; no batch, Greenhouse or import controls", async () => {
  const p = await openPopup();
  for (const id of ["btn-start", "btn-stop", "btn-save-job", "collect-status", "collect-bar", "k-discovered", "k-processed", "k-saved", "k-existing", "k-skipped", "k-failed", "btn-download-csv", "btn-open-library", "btn-diagnose", "btn-extract"]) assert.ok(p.$(id), id);
  for (const id of ["btn-save-all", "batch-section", "source", "boards", "file", "paste-text", "max-jobs", "btn-pause", "btn-open-batch", "run-line"]) assert.equal(p.$(id), null, `${id} removed`);
  const text = p.w.document.body.textContent;
  assert.doesNotMatch(text, /Greenhouse|board token|CSV \/ JSON|Import/i);
  assert.equal(p.$("collect-section").hidden, false);
  assert.equal(p.$("download-section").hidden, false);
  assert.equal(p.$("btn-start").disabled, false);
  assert.match(p.$("collect-hint").textContent, /never clicks or navigates for you/);
  assert.equal(p.$("btn-stop").disabled, true, "Stop is disabled when no run is active");
  assert.ok(!p.types().some((t) => t === "RUN_START" || t === "WATCH_START"), "opening the popup never starts anything");
});

test("not configured: explains why, hides profile/collect/download, preview and diagnostics still work", async () => {
  const p = await openPopup({ configured: false });
  assert.match(p.$("account-note").textContent, /not configured/);
  assert.equal(p.$("collect-section").hidden, true);
  assert.equal(p.$("download-section").hidden, true);
  assert.equal(p.$("tools").hidden, false);
  await p.click("btn-extract");
  assert.match(p.$("output").textContent, /Junior Graphic Designer/);
  assert.ok(!p.types().includes("SAVE_JOBS"));
});

test("on a non-LinkedIn tab: Start and Save are disabled with guidance; Download CSV still works", async () => {
  const p = await openPopup({ pageUrl: "https://example.com/" });
  assert.equal(p.$("page-status").textContent, "Not a LinkedIn page");
  assert.equal(p.$("btn-start").disabled, true);
  assert.equal(p.$("btn-save-job").disabled, true);
  assert.equal(p.$("btn-download-csv").disabled, false);
  assert.match(p.collect(), /Open a LinkedIn jobs page/);
  assert.equal(p.$("tools").hidden, true);
});

// ================================================================== Start
// ================================================================== Save open job only
test("Save open job: saves the detail record with a clear result and refreshes the total", async () => {
  const p = await openPopup({ worker: { SAVE_JOBS: SAVED_OK } });
  await p.click("btn-save-job");
  const save = p.sent.find((m) => m.type === "SAVE_JOBS");
  assert.equal(JSON.stringify(save.jobs.map((j) => j.jobId)), JSON.stringify(["4480218579"])); // array comes from jsdom's realm
  assert.equal(p.status(), "1 new job saved.");
  assert.equal(p.statusClass(), "ok");
});

test("Save open job: duplicates, unread fields, and closed/open status are described", async () => {
  const dup = await openPopup({ worker: { SAVE_JOBS: () => ({ ok: true, result: { total: 1, inserted: 0, duplicates: 1, rejected: [] } }) } });
  await dup.click("btn-save-job");
  assert.match(dup.status(), /1 duplicate \(already saved, updated\)/);
  const warn = await openPopup({ extract: { ok: true, layout: "x", detail: { ...DETAIL, applicationStatus: "closed" }, detailReason: "ok", failedSelectors: ["location", "postedText"], cards: [] }, worker: { SAVE_JOBS: SAVED_OK } });
  await warn.click("btn-save-job");
  assert.match(warn.status(), /Couldn't read: location, postedText/);
  assert.match(warn.status(), /no longer accepting applications/);
  const open = await openPopup({ extract: { ok: true, layout: "x", detail: { ...DETAIL, applicationStatus: "open" }, detailReason: "ok", failedSelectors: [], cards: [] }, worker: { SAVE_JOBS: SAVED_OK } });
  await open.click("btn-save-job");
  assert.match(open.status(), /Applications are open\./);
});

test("Save open job without a loaded job explains why and sends nothing", async () => {
  let reads = 0;
  const p = await openPopup({ extract: () => { reads++; return { ok: true, layout: "standalone-job", detail: null, detailReason: "description-not-loaded", failedSelectors: [], cards: [] }; } });
  reads = 0;
  p.$("btn-save-job").click();
  for (let i = 0; i < 80 && !/Nothing saved/.test(p.status()); i++) await tick(50);
  assert.match(p.status(), /^Nothing saved: the job's description has not loaded yet \(description-not-loaded\)/);
  assert.equal(reads, 1, "one read: the content script itself waits (bounded) for the details to render");
  assert.equal(p.sentToPage.at(-1).waitForDetailMs, 4000);
  assert.ok(!p.types().includes("SAVE_JOBS"));
});

test("Save open job failure keeps the extracted data visible", async () => {
  const p = await openPopup({ worker: { SAVE_JOBS: () => ({ ok: false, error: { code: "AUTH_REQUIRED", message: "Your session has expired. Please sign in again." } }) } });
  await p.click("btn-save-job");
  assert.equal(p.statusClass(), "error");
  const out = JSON.parse(p.$("output").textContent);
  assert.equal(out.notSaved, true);
  assert.equal(out.extracted.jobId, "4480218579");
  assert.equal(p.$("btn-retry").hidden, false);
});

// ================================================================== Download CSV
test("Download CSV exports every saved job with all details, paging through the list", async () => {
  const all = Array.from({ length: 450 }, (_, i) => ({ id: `id-${i}`, jobId: String(4400000000 + i), url: `https://www.linkedin.com/jobs/view/${4400000000 + i}/`, title: `Job ${i}`, company: "Acme, Inc.", location: "Pune", description: i % 2 ? "" : `Line one\nLine two for ${i}`, skills: ["sql"], applicationStatus: "open" }));
  const p = await openPopup({ worker: { LIST_JOBS: (m) => ({ ok: true, jobs: all.slice(m.filters.offset, m.filters.offset + m.filters.limit), total: all.length }) } });
  await p.click("btn-download-csv");
  const lists = p.sent.filter((m) => m.type === "LIST_JOBS");
  assert.deepEqual(lists.map((m) => m.filters.offset), [0, 200, 400]);
  assert.ok(lists.every((m) => m.filters.includeDescription === true));
  assert.equal(p.downloads.length, 1);
  assert.match(p.downloads[0].name, /^linkedin-saved-jobs-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.match(p.$("download-status").textContent, /Downloaded 450 jobs to linkedin-saved-jobs-.*\.csv \(225 with a full description\)/);
  const csv = await p.readBlob(p.downloads[0].blob);
  const header = csv.replace(/^﻿/, "").split("\r\n")[0];
  for (const h of ["Job title", "Company", "Location", "Job URL", "Description", "Application status", "Skills"]) assert.ok(header.includes(h), h);
  assert.ok(csv.includes('"Acme, Inc."'), "values with commas are quoted");
  assert.ok(csv.includes('"Line one\nLine two for 0"'), "multi-line descriptions are kept");
  assert.ok(!p.types().some((t) => ["DELETE_JOB", "UPDATE_JOB", "SAVE_JOBS"].includes(t)), "download never changes data");
});

test("Download CSV with nothing saved, or when listing fails, explains and downloads nothing", async () => {
  const empty = await openPopup({ worker: { LIST_JOBS: () => ({ ok: true, jobs: [], total: 0 }) } });
  await empty.click("btn-download-csv");
  assert.equal(empty.downloads.length, 0);
  assert.match(empty.$("download-status").textContent, /no saved jobs yet/);
  const bad = await openPopup({ worker: { LIST_JOBS: () => ({ ok: false, error: { code: "NETWORK", message: "Can't reach the server." } }) } });
  await bad.click("btn-download-csv");
  assert.equal(bad.downloads.length, 0);
  assert.match(bad.$("download-status").textContent, /Download failed: Can't reach the server\..*not changed/);
  assert.equal(bad.$("btn-download-csv").disabled, false);
});

// ================================================================== profile (unchanged behaviour)
test("ready state: private profile, data-loss warning, no credential fields", async () => {
  const p = await openPopup();
  assert.equal(p.$("profile").hidden, false);
  assert.equal(p.$("profile-id").textContent, "(anon-123…)");
  assert.match(p.$("profile").textContent, /cannot be recovered/);
  assert.equal(p.w.document.querySelector('input[type="email"], input[type="password"], form'), null);
  assert.doesNotMatch(p.w.document.body.textContent, /Create account|Sign in|Sign out/);
  assert.equal(p.$("saved-count").textContent, "3");
});

test("loading state: message shown and collect/download hidden until the profile is ready", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const p = await openPopup({ worker: { AUTH_STATUS: async () => { await gate; return { ok: true, configured: true, user: USER, sessionReplaced: false }; } } });
  assert.match(p.$("account-note").textContent, /Setting up your private profile/);
  assert.equal(p.$("collect-section").hidden, true);
  assert.equal(p.$("download-section").hidden, true);
  release();
  await settle();
  assert.equal(p.$("collect-section").hidden, false);
});

test("setup failure shows Try again; retry recovers", async () => {
  let attempts = 0;
  const p = await openPopup({ worker: { AUTH_STATUS: () => (++attempts === 1 ? { ok: false, error: { code: "NETWORK", message: "Can't reach the server." } } : { ok: true, configured: true, user: USER, sessionReplaced: false }) } });
  assert.match(p.$("account-note").textContent, /Can't reach the server/);
  assert.equal(p.$("collect-section").hidden, true);
  await p.click("btn-retry");
  assert.equal(p.$("collect-section").hidden, false);
});

test("opening the popup asks for the session once and sends no credentials or user ids", async () => {
  const p = await openPopup();
  assert.equal(p.types().filter((t) => t === "AUTH_STATUS").length, 1);
  assert.deepEqual([...new Set(p.types())].sort(), ["AUTH_STATUS", "COUNT_SAVED", "PING", "WATCH_STATUS"]);
  assert.doesNotMatch(JSON.stringify(p.sent), /password|credentials|user_id|userId/);
});

test("a replaced profile is announced", async () => {
  const p = await openPopup({ worker: { AUTH_STATUS: () => ({ ok: true, configured: true, user: USER, sessionReplaced: true }) } });
  assert.match(p.status(), /previous private profile could not be restored/);
});

test("Open saved jobs table opens the library page; Preview and diagnostics stay read-only", async () => {
  const p = await openPopup();
  await p.click("btn-open-library");
  assert.deepEqual(p.opened, ["chrome-extension://ext/src/library/library.html"]);
  await p.click("btn-extract");
  const preview = JSON.parse(p.$("output").textContent);
  assert.equal(preview.detail.title, "Junior Graphic Designer");
  await p.click("btn-diagnose");
  assert.match(p.$("output").textContent, /standalone-job/);
  assert.ok(!p.types().includes("SAVE_JOBS"));
});

// ------------------------------------------------------------------ full-field extraction in the popup
const FULL_DETAIL = {
  ...DETAIL, country: "India", postedText: "1 day ago", workplaceType: "Remote", employmentType: "Full-time", applicationStatus: "open",
  applicationMethod: "easy_apply", hiringInsight: "No response insights available yet", salary: "Up to ₹35,000/month", salaryCurrency: "INR",
  salaryPeriod: "month", extractionStatus: "complete", extractionWarnings: [],
};
const completeness = {
  detail: { status: "complete", found: ["jobId", "title", "country"], missingCore: [], missingExpected: ["applicantsText"], notStatedOnPage: ["seniorityLevel", "certifications"], selectorIssues: [] },
  cards: { count: 2, status: "partial (card-only)", fieldsFound: ["title"], cardsMissing: {}, detailOnlyFields: ["description", "salary"] },
};

test("Preview extraction: completeness summary, missing fields, mapping check and database state; nothing is saved", async () => {
  const p = await openPopup({
    extract: { ok: true, layout: "standalone-job", detail: FULL_DETAIL, detailReason: "ok", failedSelectors: [], fieldSources: {}, completeness, cards: cards(2) },
    worker: { SCHEMA_STATUS: () => ({ ok: true, detailColumns: false }) },
  });
  await p.click("btn-extract");
  const out = JSON.parse(p.$("output").textContent);
  assert.match(out.summary, /^Open job: complete - 3 fields found/m);
  assert.match(out.summary, /Missing \(usually shown\): applicantsText/);
  assert.match(out.summary, /Not stated for this job: seniorityLevel, certifications/);
  assert.match(out.summary, /Cards in the list: 2 \(card-only = partial; 2 fields exist only in the open job's details\)/);
  assert.match(out.summary, /Mapping: \d+ fields kept; nothing dropped/);
  assert.match(out.summary, /Not stored until the database update \(migration 20261022000200\): .*country/);
  assert.ok(!p.types().includes("SAVE_JOBS") && !p.types().includes("WATCH_START"), "preview never saves");
});

test("Preview extraction reports a failed detail extraction and values the mapper would drop", async () => {
  const p = await openPopup({
    extract: { ok: true, layout: "search-results", detail: { ...FULL_DETAIL, seniorityLevel: "Senior" }, detailReason: "ok", failedSelectors: [], fieldSources: {}, completeness, cards: [] },
    worker: { SCHEMA_STATUS: () => ({ ok: true, detailColumns: true }) },
  });
  await p.click("btn-extract");
  assert.match(JSON.parse(p.$("output").textContent).summary, /dropped: seniorityLevel/);
  const q = await openPopup({ extract: { ok: true, layout: "search-results", detail: null, detailReason: "description-not-loaded", failedSelectors: [], fieldSources: {}, completeness: { detail: { status: "failed" }, cards: {} }, cards: [] } });
  await q.click("btn-extract");
  assert.match(JSON.parse(q.$("output").textContent).summary, /^Open job: not extracted \(description-not-loaded\)/m);
});

test("Save open job: a partial extraction and a not-yet-migrated database are both stated", async () => {
  const p = await openPopup({
    extract: { ok: true, layout: "standalone-job", detail: { ...FULL_DETAIL, location: "", extractionStatus: "partial", extractionWarnings: ["missing:location", "selector-empty:title"] }, detailReason: "ok", failedSelectors: ["location"], fieldSources: {}, cards: [] },
    worker: { SAVE_JOBS: SAVED_OK, SCHEMA_STATUS: () => ({ ok: true, detailColumns: false }) },
  });
  await p.click("btn-save-job");
  assert.match(p.status(), /^1 new job saved\./);
  assert.match(p.status(), /Partial extraction \(location not found\)\./);
  assert.match(p.status(), /stored once the database update is applied\./);
});

test("Preview extraction shows the selected job, the panel's job, whether they match, and the failed stage", async () => {
  const ok = await openPopup({
    extract: { ok: true, layout: "search-results", detail: { ...FULL_DETAIL, jobId: "4476650532", responsibilities: ["a", "b"], qualifications: ["q"], experience: "3 years" }, detailReason: "ok", failedSelectors: [], fieldSources: {}, completeness,
      checks: { pageUrlId: "4476650532", aboutId: "4476650532", titleLinkId: "4476650532", descriptionContainerFound: true, descriptionChars: 5326 }, cards: [] },
  });
  await ok.click("btn-extract");
  const out = JSON.parse(ok.$("output").textContent);
  assert.match(out.summary, /^Selected job \(URL\): 4476650532 \| panel job: 4476650532 \| match: yes$/m);
  assert.match(out.summary, /^Description: found, 5326 characters \| failed stage: none \(extracted\)$/m);
  assert.match(out.summary, /Responsibilities: 2 \| qualifications: 1 \| preferred: 0 \| experience: yes/);
  assert.deepEqual([out.identity.selectedJobId, out.identity.panelJobId], ["4476650532", "4476650532"]);

  const stale = await openPopup({
    extract: { ok: true, layout: "search-results", detail: null, detailReason: "page-id-mismatch", failedSelectors: [], fieldSources: {}, completeness: { detail: { status: "failed" }, cards: {} },
      checks: { pageUrlId: "4476650532", aboutId: "4480307941", descriptionContainerFound: false }, cards: [] },
  });
  await stale.click("btn-extract");
  const s = JSON.parse(stale.$("output").textContent).summary;
  assert.match(s, /panel job: 4480307941 \| match: NO/);
  assert.match(s, /failed stage: detail panel - the panel still shows a different job than the one selected/);
});
