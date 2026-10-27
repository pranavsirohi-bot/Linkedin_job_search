// The popup's "Batch import (CSV / JSON)" panel, end to end: the real popup (bundled) -> real message handlers -> real run
// controller + file source -> a saver that behaves like the idempotent upsert. Faked: chrome.*, Supabase. Local tests only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { createHandlers } from "../src/background/handlers.js";
import { makeBatchPreflight } from "../src/background/preflight.js";
import { makeIsTrustedSender } from "../src/background/trust.js";
import { RUN_KEY } from "../src/batch/run-store.js";
import { createFileSource } from "../src/sources/file-import.js";
import { DbError, ERR } from "../src/db/errors.js";
import { resultsCsv } from "../src/popup/import-panel.js";
import { gate, makeEnv, makeSaver, netDb, tick } from "./batch/helpers.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { outputFiles } = await build({ entryPoints: [path.join(root, "src/popup/popup.js")], bundle: true, format: "iife", write: false, logLevel: "silent" });
const POPUP_JS = outputFiles[0].text;
const HTML = fs.readFileSync(path.join(root, "src/popup/popup.html"), "utf8").replace(/<script[^>]*><\/script>/, "");
const EXT = "abcdefghijklmnopabcdefghijklmnop";
const SENDER = { id: EXT, url: `chrome-extension://${EXT}/src/popup/popup.html` };
const USER = { id: "anon-1234-5678-abcd", email: "", isAnonymous: true };
const settle = async (n = 14) => { for (let i = 0; i < n; i++) await tick(0); };
const windows = [];
test.afterEach(() => { while (windows.length) windows.pop().close(); });

const row = (n, over = {}) => { const f = { title: `Job ${n}`, company: "Acme", location: "Pune", url: `https://careers.example.com/jobs/${n}`, description: `Description ${n}`, id: `ext-${n}`, ...over }; return [f.title, f.company, f.location, f.url, f.description, f.id].map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(","); };
const csvText = (rows) => ["title,company,location,url,description,id", ...rows].join("\n");
const many = (n) => Array.from({ length: n }, (_, i) => row(i + 1));

// chrome.storage.onChanged: every checkpoint the controller writes is pushed to the open popups, as Chrome does.
function attachLive(env, listeners) {
  const realSave = env.store.save.bind(env.store);
  env.store.save = async (s) => { await realSave(s); for (const l of [...listeners]) { try { l({ [RUN_KEY]: { newValue: JSON.parse(JSON.stringify(s)) } }, "local"); } catch { /* closed popup */ } } };
}

function makeExt({ saver = makeSaver(), dbReady = true, configured = true } = {}) {
  const listeners = [];
  const preflight = makeBatchPreflight({ checkConfig: () => ({ ok: true }), ensureReady: async () => {}, providerColumnsReady: async () => dbReady });
  const env = makeEnv({ source: createFileSource(), saver, preflight });
  attachLive(env, listeners);
  const sources = { list: () => [{ id: "linkedin-page", label: "Jobs loaded on the current LinkedIn page", automatic: false }, { id: "file", label: "Import CSV / JSON file", automatic: false }] };
  const handle = createHandlers({ getClient: () => ({}), checkConfig: () => ({ ok: true }), isTrustedSender: makeIsTrustedSender(EXT), runs: env.controller, sources });
  return { env, saver, handle, listeners, dbReady, configured };
}

async function openPopup(ext, { pageUrl = "https://example.com/" } = {}) {
  const dom = new JSDOM(HTML, { url: SENDER.url, runScripts: "outside-only" });
  const w = dom.window;
  windows.push(w);
  Object.defineProperty(w.navigator, "onLine", { get: () => true });
  const sent = [];
  w.chrome = {
    tabs: { query: async () => [{ id: 1, url: pageUrl }], create: () => {}, sendMessage: async () => ({ ok: true }) },
    runtime: {
      getURL: (p) => `chrome-extension://${EXT}/${p}`,
      sendMessage: async (raw) => {
        const msg = JSON.parse(JSON.stringify(raw));
        sent.push(msg);
        if (msg.type.startsWith("RUN_")) return ext.handle(msg, SENDER);
        if (msg.type === "AUTH_STATUS") return ext.configured ? { ok: true, configured: true, user: USER, sessionReplaced: false } : { ok: true, configured: false, reason: "Supabase project URL is not configured.", user: null };
        if (msg.type === "SCHEMA_STATUS") return { ok: true, detailColumns: ext.dbReady, multiProvider: ext.dbReady };
        if (msg.type === "COUNT_SAVED") return { ok: true, count: ext.saver.rows.size };
        if (msg.type === "WATCH_STATUS") return { ok: true, watch: null, automaticSources: [] };
        if (msg.type === "PING") return { ok: true };
        return { ok: false, error: { code: "UNKNOWN", message: `unhandled ${msg.type}` } };
      },
    },
    storage: { onChanged: { addListener: (l) => ext.listeners.push(l) }, local: { get: async () => ({}), set: async () => {} } },
  };
  const downloads = [];
  w.URL.createObjectURL = (blob) => { downloads.push({ blob }); return "blob:test"; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function click() { if (this.download && downloads.length) downloads.at(-1).name = this.download; };
  const blobText = (blob) => new Promise((resolve) => { const r = new w.FileReader(); r.onload = () => resolve(new TextDecoder("utf-8", { ignoreBOM: true }).decode(new Uint8Array(r.result))); r.readAsArrayBuffer(blob); });
  w.eval(POPUP_JS);
  await settle();
  const $ = (id) => w.document.getElementById(id);
  const click = async (id) => { $(id).click(); await settle(); };
  const paste = async (text) => { $("import-paste").value = text; await click("import-paste-btn"); };
  const k = () => Object.fromEntries(["total", "processed", "saved", "duplicates", "partial", "skipped", "failed"].map((n) => [n, Number($(`ik-${n}`).textContent)]));
  const dis = (...ids) => Object.fromEntries(ids.map((id) => [id, $(id).disabled]));
  return { w, $, click, paste, k, dis, sent, downloads, blobText, types: () => sent.map((m) => m.type), status: () => $("import-status").textContent };
}

// ------------------------------------------------------------------ the panel
test("the panel appears with the profile, offers the file source only, and needs no LinkedIn page", async () => {
  const ext = makeExt();
  const p = await openPopup(ext);
  assert.equal(p.$("import-section").hidden, false);
  assert.deepEqual([...p.$("import-source").options].map((o) => o.value), ["file"], "the internal LinkedIn snapshot source is not offered");
  assert.equal(p.$("import-source").disabled, true);
  assert.match(p.w.document.body.textContent, /An authorised job-data API would appear in this list once one is configured/);
  assert.deepEqual(p.dis("import-start", "import-pause", "import-resume", "import-stop"), { "import-start": true, "import-pause": true, "import-resume": true, "import-stop": true });
  assert.equal(p.status(), "Choose a CSV or JSON file of jobs.");
  const off = await openPopup(makeExt({ configured: false }));
  assert.equal(off.$("import-section").hidden, true, "hidden until the private profile is ready");
});

test("pasted CSV: preview with rejected rows, then Start import processes everything automatically", async () => {
  const ext = makeExt();
  const p = await openPopup(ext);
  await p.paste(csvText([...many(6), row(7, { title: "" }), row(1), row(8, { description: "" })]));
  assert.match(p.$("import-summary").textContent, /^7 valid jobs ready to import from pasted\.csv\. 1 record rejected \(not imported\)\. 1 duplicate inside the file ignored\./);
  assert.match(p.$("import-summary").textContent, /Row 7: missing-title/);
  assert.equal(p.$("import-start").disabled, false);
  assert.equal(p.status(), "Ready: 7 jobs from pasted.csv. Press Start import.");
  await p.click("import-start");
  await ext.env.idle();
  await settle();
  assert.deepEqual(p.k(), { total: 7, processed: 7, saved: 7, duplicates: 0, partial: 1, skipped: 0, failed: 0 });
  assert.match(p.status(), /^Completed: 7 new jobs saved, 0 already saved \(updated\), 1 partial, 0 skipped, 0 failed\.$/);
  assert.equal(p.$("import-bar").getAttribute("aria-valuenow"), "100");
  assert.equal(ext.saver.rows.size, 7);
  assert.equal(p.$("import-dismiss").hidden, false);
  assert.deepEqual(p.dis("import-start", "import-pause", "import-resume", "import-stop"), { "import-start": false, "import-pause": true, "import-resume": true, "import-stop": true });
});

test("a chosen file works like pasted text; wrong file types and unreadable files are explained", async () => {
  const p = await openPopup(makeExt());
  const choose = async (file) => { Object.defineProperty(p.$("import-file"), "files", { value: [file], configurable: true }); p.$("import-file").dispatchEvent(new p.w.Event("change")); await settle(); };
  const text = JSON.stringify([{ title: "A", url: "https://x.example/a", company: "Co", description: "d" }]);
  await choose({ name: "jobs.json", size: text.length, text: async () => text });
  assert.match(p.$("import-summary").textContent, /^1 valid job ready to import from jobs\.json\./);
  await choose({ name: "jobs.pdf", size: 10, text: async () => "x" });
  assert.equal(p.$("import-summary").textContent, "Only .csv and .json files can be imported.");
  assert.equal(p.$("import-start").disabled, true);
  await choose({ name: "big.csv", size: 3 * 1024 * 1024, text: async () => "x" });
  assert.equal(p.$("import-summary").textContent, "The file is larger than 2 MB.");
  await choose({ name: "jobs.csv", size: 10, text: async () => { throw new Error("read failed"); } });
  assert.equal(p.$("import-summary").textContent, "The file could not be read.");
});

test("the maximum-records box caps the import; markup in a title is stripped (a title that is only markup is rejected)", async () => {
  const p = await openPopup(makeExt());
  await p.paste(csvText([row(1, { title: "<img src=x onerror=alert(1)>" }), ...many(6).slice(1)])); // 1 rejected + 5 valid
  assert.equal(p.$("import-summary").querySelector("img"), null);
  assert.match(p.$("import-summary").textContent, /^5 valid jobs ready to import from pasted\.csv\. 1 record rejected \(not imported\)\./);
  assert.match(p.$("import-summary").textContent, /Row 1: missing-title/);
  p.$("import-max").value = "3";
  p.$("import-max").dispatchEvent(new p.w.Event("input"));
  await settle();
  assert.match(p.$("import-summary").textContent, /2 records beyond the maximum-records limit will not be imported/);
  assert.equal(p.status(), "Ready: 3 jobs from pasted.csv. Press Start import.");
});

// ------------------------------------------------------------------ the database must be ready
test("without the database update: a note explains why, and Start import is refused with the real reason (nothing saved)", async () => {
  const ext = makeExt({ dbReady: false });
  const p = await openPopup(ext);
  assert.equal(p.$("import-db-note").hidden, false);
  assert.match(p.$("import-db-note").textContent, /20261022000200 and 20261023000100/);
  await p.paste(csvText(many(3)));
  await p.click("import-start");
  assert.match(p.status(), /^Importing jobs needs a database update first/);
  assert.equal(p.$("import-status").className, "run-status error");
  assert.equal(ext.saver.rows.size, 0);
  assert.equal(await ext.env.state(), null, "no run was created");
  assert.equal(p.$("import-start").disabled, false, "the user can try again after the update");
});

// ------------------------------------------------------------------ Pause / Resume / Stop / Retry
test("Pause, Resume and Stop: buttons enable and disable with the run, progress is live, nothing is saved twice", async () => {
  const hold = gate();
  const saver = makeSaver({ hook: async ({ call }) => { if (call === 2) await hold.promise; } });
  const ext = makeExt({ saver });
  const p = await openPopup(ext);
  await p.paste(csvText(many(40)));
  p.$("import-start").click();
  while (saver.batches.length < 2) await tick(1);
  await settle();
  assert.match(p.status(), /^Importing\.\.\. 10 of 40 processed\.$/);
  assert.equal(p.$("import-current").hidden, false);
  assert.equal(p.$("import-current").textContent, "Now: Job 11 (source: Import CSV / JSON file)");
  assert.deepEqual(p.dis("import-start", "import-pause", "import-resume", "import-stop"), { "import-start": true, "import-pause": false, "import-resume": true, "import-stop": false });
  assert.equal(p.$("import-file").disabled, true, "inputs are locked during a run");
  await p.click("import-pause");
  assert.match(p.status(), /^Pausing/);
  hold.open();
  await ext.env.idle();
  await settle();
  assert.match(p.status(), /^Paused\. Press Resume to continue \(nothing is duplicated\), or Stop to end\.$/);
  assert.deepEqual(p.dis("import-pause", "import-resume", "import-stop"), { "import-pause": true, "import-resume": false, "import-stop": false });
  const atPause = saver.rows.size;
  await p.click("import-resume");
  await ext.env.idle();
  await settle();
  assert.match(p.status(), /^Completed: 40 new jobs saved/);
  assert.ok(atPause < 40 && saver.rows.size === 40);
  assert.equal(p.k().duplicates, 0);
});

test("Stop ends the run after the save in flight; saved jobs stay and the status says 'Stopped', never 'Completed'", async () => {
  const hold = gate();
  const saver = makeSaver({ hook: async ({ call }) => { if (call === 2) await hold.promise; } });
  const ext = makeExt({ saver });
  const p = await openPopup(ext);
  await p.paste(csvText(many(40)));
  p.$("import-start").click();
  while (saver.batches.length < 2) await tick(1);
  await p.click("import-stop");
  assert.match(p.status(), /^Stopping: finishing the save already in progress/);
  assert.equal(p.$("import-stop").disabled, true);
  hold.open();
  await ext.env.idle();
  await settle();
  assert.match(p.status(), /^Stopped by you after 20 of 40: 20 new jobs saved, 0 already saved \(updated\), 0 partial, 0 skipped, 0 failed\. Jobs saved so far are kept\.$/);
  assert.equal(saver.batches.length, 2);
  assert.equal(saver.rows.size, 20);
});

test("an outage pauses with the real error and a 'Retry' button; Retry finishes the import without duplicates", async () => {
  let down = true;
  const saver = makeSaver({ hook: async ({ call }) => { if (call >= 2 && down) throw netDb(); } });
  const ext = makeExt({ saver });
  const p = await openPopup(ext);
  await p.paste(csvText(many(25)));
  await p.click("import-start");
  await ext.env.idle();
  await settle();
  assert.match(p.status(), /^Paused: the jobs could not be saved \(connection problem\)\. Press Retry to try again/);
  assert.equal(p.$("import-resume").textContent, "Retry");
  assert.equal(p.$("import-error").hidden, false);
  assert.match(p.$("import-error").textContent, /Last problem: Can't reach the server/);
  down = false;
  await p.click("import-resume");
  await ext.env.idle();
  await settle();
  assert.match(p.status(), /^Completed: 25 new jobs saved, 0 already saved \(updated\)/);
  assert.equal(saver.rows.size, 25);
  assert.equal(p.$("import-resume").textContent, "Resume");
});

test("failed records are listed with their reason", async () => {
  const saver = makeSaver({ hook: async ({ records }) => { if (records.some((r) => r.externalId === "ext-3")) throw new (await import("../src/db/errors.js")).DbError("VALIDATION", "rejected by the database (23514)"); } });
  const ext = makeExt({ saver });
  const p = await openPopup(ext);
  await p.paste(csvText(many(12)));
  await p.click("import-start");
  await ext.env.idle();
  await settle();
  assert.equal(p.k().failed, 10);
  assert.equal(p.$("import-failures").hidden, false);
  assert.match(p.$("import-failure-items").textContent, /ext-\d+: rejected by the database \(23514\)/);
  assert.equal(p.$("import-failure-items").querySelector("img"), null);
});

// ------------------------------------------------------------------ closing and reopening the popup
test("closing and reopening the popup shows the running import; a second popup cannot start another", async () => {
  const hold = gate();
  const saver = makeSaver({ hook: async ({ call }) => { if (call === 2) await hold.promise; } });
  const ext = makeExt({ saver });
  const a = await openPopup(ext);
  await a.paste(csvText(many(30)));
  a.$("import-start").click();
  while (saver.batches.length < 2) await tick(1);
  a.w.close();
  const b = await openPopup(ext);
  assert.match(b.status(), /^Importing\.\.\. 10 of 30 processed\.$/);
  assert.deepEqual(b.dis("import-start", "import-pause", "import-stop"), { "import-start": true, "import-pause": false, "import-stop": false });
  const direct = await ext.handle({ type: "RUN_START", sourceId: "file", params: { records: [{ title: "x", url: "https://x.example/x", externalId: "e", __canonical: true }] }, limits: {} }, SENDER);
  assert.equal(direct.error.code, "run-active");
  hold.open();
  await ext.env.idle();
  await settle();
  assert.match(b.status(), /^Completed: 30 new jobs saved/);
});

test("after a browser restart an unfinished import shows as interrupted with Resume; Resume finishes it", async () => {
  const hold = gate();
  const saver = makeSaver({ hook: async ({ call }) => { if (call === 3) await hold.promise; } });
  const first = makeExt({ saver });
  const a = await openPopup(first);
  await a.paste(csvText(many(50)));
  a.$("import-start").click();
  while (saver.batches.length < 3) await tick(1);
  const { restartedEnv } = await import("./batch/helpers.mjs");
  const reborn = makeExt({ saver });
  reborn.env = restartedEnv(first.env, { source: createFileSource(), saver });
  attachLive(reborn.env, reborn.listeners);
  reborn.handle = createHandlers({ getClient: () => ({}), checkConfig: () => ({ ok: true }), isTrustedSender: makeIsTrustedSender(EXT), runs: reborn.env.controller, sources: { list: () => [{ id: "file", label: "Import CSV / JSON file", automatic: false }] }, ready: reborn.env.controller.recover("browser-start") });
  const b = await openPopup(reborn);
  assert.match(b.status(), /^Interrupted \(the browser or extension restarted\)/);
  assert.equal(b.$("import-resume").disabled, false);
  await b.click("import-resume");
  await reborn.env.idle();
  await settle();
  hold.open();
  assert.match(b.status(), /^Completed: 50 new jobs saved/);
  assert.equal(saver.rows.size, 50);
});


// ------------------------------------------------------------------ retry failed records, results download
test("Retry failed: the button names how many, runs only those records, and the results can be downloaded", async () => {
  let refuse = true;
  const saver = makeSaver({ hook: async ({ records }) => { if (refuse && records.some((r) => r.externalId === "ext-3")) throw new DbError(ERR.VALIDATION, "rejected (23514)"); } });
  const ext = makeExt({ saver });
  const p = await openPopup(ext);
  await p.paste(csvText(many(25)));
  await p.click("import-start");
  await ext.env.idle();
  await settle();
  assert.match(p.status(), /^Paused after repeated failures\./);
  assert.equal(p.$("import-retry").hidden, true, "not offered while the run is still open");
  await p.click("import-stop");
  assert.match(p.status(), /10 records failed: press "Retry failed" to process them again\./);
  assert.equal(p.$("import-retry").hidden, false);
  assert.equal(p.$("import-retry").textContent, "Retry failed (10)");
  refuse = false;
  await p.click("import-retry");
  await ext.env.idle();
  await settle();
  assert.match(p.status(), /^Completed: 10 new jobs saved, 0 already saved \(updated\), 0 partial, 0 skipped, 0 failed\.$/);
  assert.equal(p.$("import-retry").hidden, true, "nothing left to retry");
  assert.equal(saver.rows.size, 10);
  // results download: one line per record, with the outcome
  assert.equal(p.$("import-results").hidden, false);
  await p.click("import-results");
  assert.match(p.downloads[0].name, /^import-results-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = await p.blobText(p.downloads[0].blob);
  assert.ok(text.startsWith("﻿"), "UTF-8 BOM so Excel reads it");
  const lines = text.slice(1).trim().split("\r\n");
  assert.equal(lines[0], "Record ID,Title,Outcome,Reason");
  assert.equal(lines.length, 11);
  assert.ok(lines.slice(1).every((l) => /,Saved \(new\),$/.test(l)));
});

test("a refused Retry is explained and does not disturb the finished run", async () => {
  const ext = makeExt();
  const p = await openPopup(ext);
  await p.paste(csvText(many(3)));
  await p.click("import-start");
  await ext.env.idle();
  await settle();
  assert.equal(p.$("import-retry").hidden, true, "no failures: no Retry button");
  const direct = await ext.handle({ type: "RUN_RETRY_FAILED" }, SENDER);
  assert.equal(direct.error.code, "nothing-to-retry");
  assert.match(p.status(), /^Completed: 3 new jobs saved/);
});

test("results CSV: quoting, line breaks and formula-looking text are made safe", () => {
  const csv = resultsCsv([
    { id: "x1", title: '=HYPERLINK("http://e")', outcome: "failed", reason: 'a, "b"\nc' },
    { id: "x2", title: "Café", outcome: "partial", reason: "missing:description" },
  ]);
  assert.ok(csv.startsWith("﻿Record ID,Title,Outcome,Reason\r\n"));
  assert.ok(csv.includes('"\'=HYPERLINK(""http://e"")"'), "a leading = is neutralised and quotes are doubled");
  assert.ok(csv.includes('"a, ""b""\nc"'));
  assert.ok(csv.includes("x2,Café,Saved (partial),missing:description"));
});
