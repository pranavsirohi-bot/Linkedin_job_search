// The real batch page (bundled with esbuild) in jsdom, wired through the real message handlers to the real run
// controller, with the real Greenhouse and file adapters. Faked: the network (fixtures), Supabase (an in-memory saver),
// chrome.* (stubs). Verifies the UI and the control chain locally; it is not a browser or provider test.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { createHandlers } from "../src/background/handlers.js";
import { makeIsTrustedSender } from "../src/background/trust.js";
import { RUN_KEY } from "../src/batch/run-store.js";
import { createFileSource } from "../src/sources/file-import.js";
import { createGreenhouseSource } from "../src/sources/greenhouse.js";
import { SourceError } from "../src/sources/http.js";
import { makeEnv, makeSaver, restartedEnv, tick, gate } from "./batch/helpers.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { outputFiles } = await build({ entryPoints: [path.join(root, "src/batchpage/batch.js")], bundle: true, format: "iife", write: false, logLevel: "silent" });
const BATCH_JS = outputFiles[0].text;
const HTML = fs.readFileSync(path.join(root, "src/batchpage/batch.html"), "utf8").replace(/<script[^>]*><\/script>/, "");
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures", n), "utf8"));
const LIST = fixture("greenhouse-board-list.json");
const DETAIL = fixture("greenhouse-job-detail.json");

const EXT = "abcdefghijklmnopabcdefghijklmnop";
const PAGE_SENDER = { id: EXT, tab: { id: 4 }, url: `chrome-extension://${EXT}/src/batchpage/batch.html` };
const settle = async () => { for (let i = 0; i < 12; i++) await tick(0); };

const windows = [];
test.afterEach(() => { while (windows.length) windows.pop().close(); });

// Greenhouse fixtures: board "figma" has the 6 real list entries; any job id returns the real detail record.
function ghSource(hooks = {}) {
  const calls = [];
  const fetchJson = async (url) => {
    calls.push(url);
    if (hooks.fetch) { const r = await hooks.fetch(url, calls.length); if (r !== undefined) return r; }
    const list = url.match(/\/boards\/([^/]+)\/jobs$/);
    if (list) {
      if (decodeURIComponent(list[1]) === "figma") return LIST;
      throw new SourceError("not-found", "nf", { status: 404 });
    }
    const one = url.match(/\/jobs\/(\d+)\?pay_transparency=true$/);
    if (one) return { ...DETAIL, id: Number(one[1]), absolute_url: `https://boards.greenhouse.io/figma/jobs/${one[1]}` };
    throw new Error(`unexpected ${url}`);
  };
  const src = createGreenhouseSource({ fetchJson, now: () => Date.now() });
  src.calls = calls;
  return src;
}

function wire({ gh = ghSource(), saver = makeSaver(), env: existing } = {}) {
  const registry = new Map([["greenhouse", gh], ["file", createFileSource()]]);
  const env = existing || makeEnv({ sources: registry, source: gh, saver });
  const listeners = [];
  const realSave = env.store.save.bind(env.store);
  env.store.save = async (state) => { await realSave(state); for (const l of listeners) { try { l({ [RUN_KEY]: { newValue: JSON.parse(JSON.stringify(state)) } }, "local"); } catch { /* a closed page's listener must not affect the store */ } } };
  const handle = createHandlers({
    getClient: () => { throw new Error("batch control must not need a client"); },
    checkConfig: () => ({ ok: true, reason: "" }),
    isTrustedSender: makeIsTrustedSender(EXT),
    runs: env.controller,
    sources: { list: () => [{ id: "greenhouse", label: "Greenhouse" }, { id: "file", label: "File" }] },
  });
  return { env, handle, listeners, saver: env.saver, gh };
}

async function openPage(ctx) {
  const dom = new JSDOM(HTML, { url: PAGE_SENDER.url, runScripts: "outside-only" });
  const w = dom.window;
  windows.push(w);
  const sent = [];
  const opened = [];
  w.chrome = {
    runtime: {
      getURL: (p) => `chrome-extension://${EXT}/${p}`,
      sendMessage: async (msg) => { sent.push(JSON.parse(JSON.stringify(msg))); return ctx.handle(JSON.parse(JSON.stringify(msg)), PAGE_SENDER); },
    },
    tabs: { create: (o) => opened.push(o.url) },
    storage: { onChanged: { addListener: (l) => ctx.listeners.push(l) } },
  };
  w.eval(BATCH_JS);
  await settle();
  const $ = (id) => w.document.getElementById(id);
  const click = async (id) => { $(id).click(); await settle(); };
  const counters = () => Object.fromEntries(["discovered", "processed", "saved", "duplicates", "skipped", "failed"].map((k) => [k, Number($(`c-${k}`).textContent)]));
  const chooseFile = async (name, text, { size = text.length, reject = false } = {}) => {
    const file = { name, size, text: () => (reject ? Promise.reject(new Error("unreadable")) : Promise.resolve(text)) };
    Object.defineProperty($("file"), "files", { value: [file], configurable: true });
    $("file").dispatchEvent(new w.Event("change"));
    await settle();
  };
  return { w, $, click, sent, opened, counters, chooseFile, types: () => sent.map((m) => m.type), status: () => $("run-status").textContent, message: () => $("message").textContent, messageClass: () => $("message").className };
}

const disabled = (p, ...ids) => Object.fromEntries(ids.map((id) => [id, p.$(id).disabled]));
const CSV = ["title,company,url,location,employment type,skills", "Designer,Acme,https://jobs.acme.example/1,Berlin,full time,figma;sketch", "Analyst,Globex,https://jobs.globex.example/2,Remote,contract,sql", "Writer,Initech,https://jobs.initech.example/3,,part time,", "NoUrl,Acme,,x,,", "Bad,Acme,http://insecure.example/9,x,,"].join("\n");

// ================================================================== initial state
test("idle: no run, Start available for Greenhouse, only Start and the library link are active", async () => {
  const p = await openPage(wire());
  assert.match(p.status(), /No run yet/);
  assert.deepEqual(p.counters(), { discovered: 0, processed: 0, saved: 0, duplicates: 0, skipped: 0, failed: 0 });
  assert.deepEqual(disabled(p, "btn-start", "btn-pause", "btn-resume", "btn-stop", "btn-dismiss"), { "btn-start": false, "btn-pause": true, "btn-resume": true, "btn-stop": true, "btn-dismiss": true });
  assert.equal(p.$("btn-dismiss").hidden, true);
  assert.equal(p.$("cfg-file").hidden, true);
  assert.match(p.w.document.body.textContent, /does not crawl LinkedIn/);
  assert.match(p.w.document.body.textContent, /cannot be recovered/);
  assert.equal(p.$("max-jobs").value, "200");
  assert.equal(p.$("max-pages").value, "10");
  assert.equal(p.$("page-size").value, "25");
});

test("switching to file mode shows the file section and keeps Start disabled until a valid file is chosen", async () => {
  const p = await openPage(wire());
  p.$("source").value = "file";
  p.$("source").dispatchEvent(new p.w.Event("change"));
  assert.equal(p.$("cfg-file").hidden, false);
  assert.equal(p.$("cfg-greenhouse").hidden, true);
  assert.equal(p.$("btn-start").disabled, true);
});

// ================================================================== Greenhouse run, live progress, controls
test("a Greenhouse run from the page: live progress, inputs locked while active, completes and saves every job", async () => {
  const hold = gate();
  const gh = ghSource({ fetch: async (url) => { if (/\/jobs\/\d+\?/.test(url) && url.includes(String(LIST.jobs[2].id))) await hold.promise; } });
  const ctx = wire({ gh });
  const p = await openPage(ctx);
  p.$("boards").value = "figma";
  await p.click("btn-start");
  assert.equal(p.message(), "Run started.");
  while (ctx.gh.calls.filter((u) => /\/jobs\/\d+\?/.test(u)).length < 3) await tick(1);
  await settle();

  // Mid-run: the UI shows progress that came from the persisted checkpoint, and locks the form.
  assert.match(p.status(), /Running/);
  assert.equal(p.counters().discovered, 6);
  assert.ok(p.counters().processed < 6);
  assert.deepEqual(disabled(p, "btn-start", "btn-pause", "btn-resume", "btn-stop"), { "btn-start": true, "btn-pause": false, "btn-resume": true, "btn-stop": false });
  for (const id of ["source", "boards", "keyword", "max-jobs", "max-pages", "page-size"]) assert.equal(p.$(id).disabled, true, id);
  assert.match(p.$("page-line").textContent, /Pages fetched: 1 of at most 10/);

  hold.open();
  await ctx.env.idle();
  await settle();
  assert.match(p.status(), /Completed\. All available jobs were processed/);
  assert.deepEqual(p.counters(), { discovered: 6, processed: 6, saved: 6, duplicates: 0, skipped: 0, failed: 0 });
  assert.equal(p.$("bar").getAttribute("aria-valuenow"), "100");
  assert.equal(ctx.saver.rows.size, 6);
  const sample = [...ctx.saver.rows.values()][0];
  assert.equal(sample.provider, "greenhouse");
  assert.match(sample.description, /Figma is growing our team/);
  assert.equal(p.$("btn-dismiss").hidden, false);
  assert.equal(p.$("btn-start").disabled, false, "a new run can start once the previous one has finished");
  assert.equal(p.$("boards").disabled, false);
});

test("the start request carries the form's source, boards (split on lines, commas, spaces) and limits only", async () => {
  const ctx = wire();
  const p = await openPage(ctx);
  p.$("boards").value = "figma\n gitlab, acme ;  \n";
  p.$("keyword").value = " designer ";
  p.$("max-jobs").value = "30";
  p.$("max-pages").value = "3";
  p.$("page-size").value = "10";
  await p.click("btn-start");
  const start = p.sent.find((m) => m.type === "RUN_START");
  assert.deepEqual(start, { type: "RUN_START", sourceId: "greenhouse", params: { boards: ["figma", "gitlab", "acme"], keyword: "designer" }, limits: { maxJobs: 30, maxPages: 3, pageSize: 10 } });
  await ctx.env.idle();
});

test("pause, resume and stop from the page; buttons reflect each state; Clear result removes only the run record", async () => {
  const hold = gate();
  const gh = ghSource({ fetch: async (url) => { if (url.includes(String(LIST.jobs[1].id)) && /\?pay/.test(url)) await hold.promise; } });
  const ctx = wire({ gh });
  const p = await openPage(ctx);
  p.$("boards").value = "figma";
  p.$("page-size").value = "50";
  await p.click("btn-start");
  while (!ctx.gh.calls.some((u) => u.includes(String(LIST.jobs[1].id)))) await tick(1);

  await p.click("btn-pause");
  assert.match(p.status(), /Pausing after the current step/);
  assert.deepEqual(disabled(p, "btn-pause", "btn-resume"), { "btn-pause": true, "btn-resume": false }, "'pausing' can be cancelled with Resume");
  hold.open();
  await ctx.env.idle();
  await settle();
  assert.match(p.status(), /Paused\./);
  assert.deepEqual(disabled(p, "btn-start", "btn-pause", "btn-resume", "btn-stop"), { "btn-start": true, "btn-pause": true, "btn-resume": false, "btn-stop": false });
  const savedWhenPaused = ctx.saver.rows.size;
  assert.ok(savedWhenPaused >= 1 && savedWhenPaused < 6);

  await p.click("btn-resume");
  await ctx.env.idle();
  await settle();
  assert.match(p.status(), /Completed/);
  assert.equal(ctx.saver.rows.size, 6);
  assert.equal(p.counters().duplicates, 0, "resuming never re-saved anything");

  await p.click("btn-dismiss");
  assert.match(p.status(), /No run yet/);
  assert.equal(ctx.saver.rows.size, 6, "clearing the result never removes saved jobs");
});

test("Stop ends the run, keeps the saved jobs, and the page says so", async () => {
  const hold = gate();
  const gh = ghSource({ fetch: async (url) => { if (url.includes(String(LIST.jobs[2].id)) && /\?pay/.test(url)) await hold.promise; } });
  const ctx = wire({ gh });
  const p = await openPage(ctx);
  p.$("boards").value = "figma";
  await p.click("btn-start");
  while (!ctx.gh.calls.some((u) => u.includes(String(LIST.jobs[2].id)))) await tick(1);
  await p.click("btn-stop");
  hold.open();
  await ctx.env.idle();
  await settle();
  assert.match(p.status(), /Stopped by you\. Jobs saved so far are kept\./);
  assert.ok(ctx.saver.rows.size >= 2, "jobs finished before the stop are kept");
  assert.equal(p.$("btn-stop").disabled, true);
  assert.equal(p.$("btn-resume").disabled, true, "a stopped run cannot be resumed");
});

// ================================================================== interruption recovery
test("an interrupted run is shown with a Resume button, never restarts by itself, and resumes to completion", async () => {
  const hold = gate();
  const gh = ghSource({ fetch: async (url) => { if (url.includes(String(LIST.jobs[3].id)) && /\?pay/.test(url)) await hold.promise; } });
  const first = wire({ gh });
  const p0 = await openPage(first);
  p0.$("boards").value = "figma";
  p0.$("page-size").value = "3"; // pages of 3, so page 1 is already saved when the "crash" happens
  await p0.click("btn-start");
  while (!first.gh.calls.some((u) => u.includes(String(LIST.jobs[3].id)))) await tick(1);

  // The browser restarts: a brand-new controller over the persisted checkpoint; start-up recovery runs.
  const fresh = restartedEnv(first.env, { sources: new Map([["greenhouse", ghSource()], ["file", createFileSource()]]) });
  await fresh.controller.recover("browser-start");
  const ctx = wire({ env: fresh });
  const p = await openPage(ctx);
  assert.match(p.status(), /Interrupted .*press Resume to continue/);
  assert.deepEqual(disabled(p, "btn-start", "btn-resume", "btn-stop", "btn-pause"), { "btn-start": true, "btn-resume": false, "btn-stop": false, "btn-pause": true });
  assert.ok(p.counters().saved >= 1, "completed work is shown and preserved");
  await tick(30);
  assert.equal(fresh.saver.rows.size, first.saver.rows.size, "nothing ran without a click");

  await p.click("btn-resume");
  await fresh.idle();
  await settle();
  assert.match(p.status(), /Completed/);
  assert.equal(p.counters().saved, 6);
  hold.open();
});

test("closing and reopening the page shows the same persisted run (the page never owned it)", async () => {
  const hold = gate();
  const gh = ghSource({ fetch: async (url) => { if (url.includes(String(LIST.jobs[1].id)) && /\?pay/.test(url)) await hold.promise; } });
  const ctx = wire({ gh });
  const a = await openPage(ctx);
  a.$("boards").value = "figma";
  await a.click("btn-start");
  while (!ctx.gh.calls.some((u) => u.includes(String(LIST.jobs[1].id)))) await tick(1);
  a.w.close();
  const b = await openPage(ctx);
  assert.match(b.status(), /Running/);
  assert.equal(b.counters().discovered, 6);
  assert.equal(b.$("btn-start").disabled, true);
  hold.open();
  await ctx.env.idle();
  await settle();
  assert.match(b.status(), /Completed/);
});

// ================================================================== errors and validation
test("invalid input is reported clearly and no run is created", async () => {
  const ctx = wire();
  const p = await openPage(ctx);
  p.$("boards").value = "../etc/passwd";
  await p.click("btn-start");
  assert.match(p.message(), /not a valid board token/);
  assert.equal(p.messageClass(), "error");
  p.$("boards").value = "";
  await p.click("btn-start");
  assert.match(p.message(), /at least one Greenhouse board token/);
  p.$("boards").value = "figma";
  p.$("max-jobs").value = "999";
  await p.click("btn-start");
  assert.match(p.message(), /maxJobs cannot be more than 500/);
  p.$("max-jobs").value = "200";
  p.$("max-pages").value = "0";
  await p.click("btn-start");
  assert.match(p.message(), /maxPages must be a whole number of at least 1/);
  assert.equal(await ctx.env.state(), null);
  assert.equal(p.$("btn-start").disabled, false, "the form stays usable after an error");
});

test("a board that does not exist produces a warning, not a crash; the run still completes", async () => {
  const ctx = wire();
  const p = await openPage(ctx);
  p.$("boards").value = "ghost-board\nfigma";
  await p.click("btn-start");
  await ctx.env.idle();
  await settle();
  assert.match(p.status(), /Completed/);
  assert.match(p.$("warnings").textContent, /Board "ghost-board" was not found on Greenhouse/);
  assert.equal(p.counters().saved, 6);
});

test("retry countdown, rate-limit wait, last error, warnings and failures are displayed as plain text", async () => {
  const ctx = wire();
  const p = await openPage(ctx);
  const emit = (over) => ctx.listeners.forEach((l) => l({ [RUN_KEY]: { newValue: { v: 1, runId: "r1", status: "running", sourceId: "greenhouse", config: { maxJobs: 200, maxPages: 10, pageSize: 25 }, page: 1, pending: [], counters: { discovered: 5, processed: 2, saved: 2, duplicates: 0, skipped: 0, failed: 0 }, failures: [], warnings: [], retry: null, waiting: null, lastError: null, ...over } } }, "local"));

  emit({ retry: { key: "x", attempt: 2, until: Date.now() + 5000, reason: "network down" } });
  assert.match(p.$("retry-line").textContent, /Retry 2 of 4 in [45]s: network down/);
  emit({ retry: null, waiting: { until: Date.now() + 90000 } });
  assert.match(p.$("retry-line").textContent, /Waiting for the source's rate limit; continuing automatically at/);
  emit({ waiting: null, lastError: { code: "item-failed", message: "boom <b>bold</b>" }, warnings: ["<img src=x onerror=alert(1)> warning"], failures: [{ externalId: "figma:1", reason: "<script>x()</script> timed out" }] });
  assert.equal(p.$("retry-line").hidden, true);
  assert.match(p.$("error-line").textContent, /Last problem: boom <b>bold<\/b>/);
  assert.equal(p.w.document.querySelector("#error-line b, #warnings img, #failures script"), null, "never interpreted as HTML");
  assert.equal(p.$("failures-box").hidden, false);
  assert.match(p.$("failures").textContent, /figma:1: <script>x\(\)<\/script> timed out/);
  emit({ status: "paused", pausedReason: "too-many-failures" });
  assert.match(p.status(), /Paused automatically after repeated failures/);
  emit({ status: "paused", pausedReason: "save-failed" });
  assert.match(p.status(), /could not be saved to Supabase/);
  emit({ status: "paused", pausedReason: "source-unreachable" });
  assert.match(p.status(), /could not be reached/);
  emit({ status: "failed", endReason: "repeated-cursor", lastError: { message: "loop" }, finishedAt: 1 });
  assert.match(p.status(), /Failed\..*repeated a page cursor/);
  emit({ status: "completed", endReason: "job-limit", finishedAt: 1 });
  assert.match(p.status(), /Stopped at the maximum number of jobs/);
});

// ================================================================== file import
test("file import: valid rows are previewed, rejected rows are listed, nothing is saved until Start", async () => {
  const ctx = wire();
  const p = await openPage(ctx);
  p.$("source").value = "file";
  p.$("source").dispatchEvent(new p.w.Event("change"));
  await p.chooseFile("jobs.csv", CSV);
  const summary = p.$("file-summary");
  assert.equal(summary.hidden, false);
  assert.match(summary.textContent, /3 valid jobs ready to import from jobs\.csv/);
  assert.match(summary.textContent, /2 records rejected/);
  assert.match(summary.textContent, /Row 4: missing-url/);
  assert.match(summary.textContent, /Row 5: invalid-url/);
  assert.equal(p.$("btn-start").disabled, false);
  assert.equal(ctx.saver.rows.size, 0, "choosing a file saves nothing");
  assert.ok(!p.types().includes("RUN_START"));
});

test("file import end to end: Start imports the valid rows as provider 'file' through the run controller", async () => {
  const ctx = wire();
  const p = await openPage(ctx);
  p.$("source").value = "file";
  p.$("source").dispatchEvent(new p.w.Event("change"));
  await p.chooseFile("jobs.csv", CSV);
  await p.click("btn-start");
  const start = p.sent.find((m) => m.type === "RUN_START");
  assert.equal(start.sourceId, "file");
  assert.equal(start.params.records.length, 3);
  assert.equal(start.params.fileName, "jobs.csv");
  await ctx.env.idle();
  await settle();
  assert.match(p.status(), /Completed/);
  assert.deepEqual(p.counters(), { discovered: 3, processed: 3, saved: 3, duplicates: 0, skipped: 0, failed: 0 });
  const rows = [...ctx.saver.rows.values()];
  assert.deepEqual(rows.map((r) => r.provider), ["file", "file", "file"]);
  assert.deepEqual(rows.map((r) => r.title).sort(), ["Analyst", "Designer", "Writer"]);
  assert.equal(rows.find((r) => r.title === "Designer").employmentType, "Full-time");

  // Importing the same file again creates no new rows: the second run reports them as duplicates.
  await p.click("btn-dismiss");
  await p.chooseFile("jobs.csv", CSV);
  await p.click("btn-start");
  await ctx.env.idle();
  await settle();
  assert.equal(ctx.saver.rows.size, 3);
  assert.equal(p.counters().duplicates, 3);
  assert.equal(p.counters().saved, 0);
});

test("invalid files are rejected safely: wrong type, too big, unreadable, bad JSON, no valid rows", async () => {
  const ctx = wire();
  const p = await openPage(ctx);
  p.$("source").value = "file";
  p.$("source").dispatchEvent(new p.w.Event("change"));
  const cases = [
    [["notes.txt", "hello"], /Only \.csv and \.json/],
    [["virus.csv.exe", "title,url"], /Only \.csv and \.json/],
    [["big.csv", "title,url\nA,https://x.example/1", { size: 3 * 1024 * 1024 }], /larger than 2 MB/],
    [["gone.csv", "x", { reject: true }], /could not be read/],
    [["bad.json", "{not json"], /not valid JSON/],
    [["empty.csv", "   "], /empty/],
    [["cols.csv", "foo,bar\n1,2"], /no recognised columns/],
    [["none.csv", "title,url\n,\nA,http://insecure.example"], /0 valid jobs/],
  ];
  for (const [args, expected] of cases) {
    await p.chooseFile(...args);
    assert.match(p.$("file-summary").textContent, expected, args[0]);
    assert.equal(p.$("btn-start").disabled, true, `${args[0]}: Start stays disabled`);
  }
  assert.ok(!p.types().includes("RUN_START"));
  assert.equal(ctx.saver.rows.size, 0);
});

test("the maximum-jobs limit re-checks the chosen file and says how many records are over the limit", async () => {
  const ctx = wire();
  const p = await openPage(ctx);
  p.$("source").value = "file";
  p.$("source").dispatchEvent(new p.w.Event("change"));
  await p.chooseFile("jobs.csv", CSV);
  p.$("max-jobs").value = "2";
  p.$("max-jobs").dispatchEvent(new p.w.Event("change"));
  await settle();
  assert.match(p.$("file-summary").textContent, /2 valid jobs ready/);
  assert.match(p.$("file-summary").textContent, /1 record beyond the maximum-jobs limit will not be imported/);
  await p.click("btn-start");
  await ctx.env.idle();
  assert.equal(ctx.saver.rows.size, 2);
});

// ================================================================== navigation
test("Open saved jobs opens the library page in a tab", async () => {
  const p = await openPage(wire());
  await p.click("btn-library");
  assert.deepEqual(p.opened, [`chrome-extension://${EXT}/src/library/library.html`]);
});

// ================================================================== honest limits, position, import summary
test("a limit-stopped run says more jobs were NOT collected instead of 'Completed'", async () => {
  const ctx = wire();
  const p = await openPage(ctx);
  ctx.listeners.forEach((l) => l({ [RUN_KEY]: { newValue: { v: 1, runId: "r", status: "completed", sourceId: "greenhouse", endReason: "page-limit", moreAvailable: true, config: { maxJobs: 200, maxPages: 2, pageSize: 25 }, page: 2, pending: [], counters: { discovered: 50, processed: 50, saved: 50, duplicates: 0, skipped: 0, failed: 0 }, failures: [], warnings: [], finishedAt: 1 } } }, "local"));
  assert.match(p.status(), /Limit reached: stopped at the maximum number of pages/);
  assert.match(p.status(), /NOT collected/);
  assert.doesNotMatch(p.status(), /^Completed/);
});

test("automatic pagination from the page: a multi-page Greenhouse run shows pages fetched and the next position", async () => {
  const hold = gate();
  const gh = ghSource({ fetch: async (url) => { if (url.includes(String(LIST.jobs[2].id)) && url.includes("?pay")) await hold.promise; } });
  const ctx = wire({ gh });
  const p = await openPage(ctx);
  p.$("boards").value = "figma";
  p.$("page-size").value = "2";
  await p.click("btn-start");
  while (!ctx.gh.calls.some((u) => u.includes(String(LIST.jobs[2].id)))) await tick(1);
  await settle();
  assert.ok(p.$("page-line").textContent.includes("Pages fetched: 2 of at most 10"), p.$("page-line").textContent);
  assert.ok(p.$("page-line").textContent.includes('next: board "figma", from job 5'), p.$("page-line").textContent);
  hold.open();
  await ctx.env.idle();
  await settle();
  assert.match(p.status(), /Completed\. All available jobs were processed/);
  assert.ok(p.$("page-line").textContent.includes("Pages fetched: 3"), p.$("page-line").textContent);
  assert.ok(p.$("page-line").textContent.includes("next: end of results"));
  assert.equal(ctx.saver.rows.size, 6, "three pages of two jobs each, fetched one after another automatically");
});

test("a file import shows total, valid, invalid, duplicate, imported and failed counts; re-import shows 'already saved'", async () => {
  const ctx = wire();
  const p = await openPage(ctx);
  p.$("source").value = "file";
  p.$("source").dispatchEvent(new p.w.Event("change"));
  await p.chooseFile("jobs.csv", CSV);
  await p.click("btn-start");
  await ctx.env.idle();
  await settle();
  const line = p.$("import-line");
  assert.equal(line.hidden, false);
  assert.equal(line.textContent, "File: 5 rows | 3 valid | 2 invalid | 0 duplicate in file | 3 imported (new) | 0 already saved | 0 failed");
  await p.click("btn-dismiss");
  await p.chooseFile("jobs.csv", CSV);
  await p.click("btn-start");
  await ctx.env.idle();
  await settle();
  assert.ok(p.$("import-line").textContent.includes("0 imported (new) | 3 already saved"), p.$("import-line").textContent);
});
