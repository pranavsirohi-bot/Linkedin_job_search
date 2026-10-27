// The real content script (classic script) in jsdom with a fake chrome API: LinkedIn's page is never changed, waiting
// for the opened job's details, and the "ready" ping. Fixtures are trimmed live markup; jsdom is not Chrome.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const SCRIPTS = ["src/extract/xpath-selectors.js", "src/extract/normalize.js", "src/extract/extractor.js", "src/content/content-script.js"].map(read);
const body = (html) => html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>"));
const PAGE = `<!doctype html><html><body>${body(read("tests/fixtures/job-cards.html"))}${body(read("tests/fixtures/job-detail.html"))}</body></html>`;
const SR_URL = "https://www.linkedin.com/jobs/search-results/?currentJobId=4480307941";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const windows = [];
test.afterEach(async () => { while (windows.length) windows.pop().close(); await wait(350); }); // let debounced timers see the closed page

function load({ url = SR_URL, html = PAGE, watch = null } = {}) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  const w = dom.window;
  windows.push(w);
  const sent = [];
  const storageListeners = [];
  let onMessage = null;
  w.chrome = {
    runtime: { sendMessage: async (m) => { sent.push(m); return { ok: true }; }, onMessage: { addListener: (fn) => { onMessage = fn; } } },
    storage: { local: { get: async () => (watch ? { "ljs:watch": watch } : {}) }, onChanged: { addListener: (fn) => storageListeners.push(fn) } },
  };
  w.console.log = () => {};
  w.__LJS_TEST__ = {};
  for (const s of SCRIPTS) w.eval(s);
  const setWatch = (v) => { for (const l of storageListeners) l({ "ljs:watch": { newValue: v } }, "local"); };
  const ask = (msg) => new Promise((resolve) => { const async = onMessage(msg, {}, resolve); if (async !== true && async !== false) resolve(undefined); });
  return { w, doc: w.document, sent, setWatch, ask, hooks: w.__LJS_TEST__.content };
}
const watching = (marks) => ({ status: "watching", marks });

// ------------------------------------------------------------------ LinkedIn's page is never changed
test("LinkedIn's page is left exactly as it is: nothing is added to job cards, before, during or after a session", async () => {
  const p = load();
  const before = p.doc.body.innerHTML;
  // Even a state that still carries per-card marks (written by an older version) draws nothing.
  p.setWatch({ ...watching({ 4480307941: "full", 4450363857: "next", 4400000001: "failed" }), nextId: "4450363857" });
  p.doc.body.appendChild(p.doc.createElement("div")).remove(); // wake the page observer
  await wait(450); // the observer is debounced (250 ms)
  assert.equal(p.doc.body.innerHTML, before, "while auto-save runs");
  assert.equal(p.doc.querySelectorAll("[data-ljs-badge]").length, 0);
  p.setWatch({ status: "stopped" });
  assert.equal(p.doc.body.innerHTML, before, "after Stop");
});

test("the initial storage read never overrides a newer state (no stale auto-save flag)", async () => {
  const p = load({ watch: null }); // storage still says 'off' ...
  p.setWatch(watching({})); // ... but a newer change already turned it on
  await wait(30); // the initial read resolves now
  assert.equal(p.hooks.state.autoSave, true);
});

// ------------------------------------------------------------------ waiting for the opened job (no fixed delays)
test("EXTRACT_PREVIEW with waitForDetailMs answers as soon as the selected job's details render", async () => {
  const p = load();
  const box = p.doc.querySelector("[data-testid='expandable-text-box']");
  const holder = box.parentNode;
  box.remove(); // the description is still loading
  setTimeout(() => holder.appendChild(box), 400);
  const t0 = Date.now();
  const res = await p.ask({ type: "EXTRACT_PREVIEW", waitForDetailMs: 4000 });
  const took = Date.now() - t0;
  assert.equal(res.detailReason, "ok");
  assert.equal(res.detail.jobId, "4480307941");
  assert.ok(took >= 350 && took < 1500, `answered after ${took} ms, not after a fixed delay`);
});

test("the wait is bounded: a description that never loads is reported, not waited on forever", async () => {
  const p = load();
  p.doc.querySelector("[data-testid='expandable-text-box']").remove();
  const t0 = Date.now();
  const res = await p.ask({ type: "EXTRACT_PREVIEW", waitForDetailMs: 600 });
  assert.equal(res.detail, null);
  assert.equal(res.detailReason, "description-not-loaded");
  assert.ok(Date.now() - t0 < 1500);
  const capped = await p.ask({ type: "EXTRACT_PREVIEW", waitForDetailMs: 999999 });
  assert.ok(capped, "huge waits are capped (6 s) and still answer");
});

test("stale panel: the URL already selects another job -> nothing is extracted for it", async () => {
  const p = load({ url: "https://www.linkedin.com/jobs/search-results/?currentJobId=4499999999" });
  const res = await p.ask({ type: "EXTRACT_PREVIEW", waitForDetailMs: 400 });
  assert.equal(res.detail, null, "the panel still shows 4480307941");
  assert.equal(res.detailReason, "page-id-mismatch");
});

test("after the user opens a job, the worker is told 'ready' once its details render", async () => {
  const p = load({ watch: watching({}) });
  await wait(50);
  const box = p.doc.querySelector("[data-testid='expandable-text-box']");
  const holder = box.parentNode;
  box.remove();
  p.sent.length = 0;
  p.w.history.pushState({}, "", SR_URL + "&x=1"); // the user clicked the job (SPA navigation)
  p.doc.body.appendChild(p.doc.createElement("div")); // any DOM change triggers the observer
  await wait(450);
  assert.ok(p.sent.some((m) => m.type === "PAGE_CHANGED" && !m.ready), "page change reported");
  assert.ok(!p.sent.some((m) => m.ready), "not ready while the description is missing");
  holder.appendChild(box);
  await wait(700);
  assert.ok(p.sent.some((m) => m.type === "PAGE_CHANGED" && m.ready === true), "ready ping once the details are there");
  assert.ok(p.sent.every((m) => Object.keys(m).every((k) => k === "type" || k === "ready")), "pings carry no job data");
});

test("nothing is sent while auto-save is off", async () => {
  const p = load();
  p.w.history.pushState({}, "", SR_URL + "&y=1");
  p.doc.body.appendChild(p.doc.createElement("div"));
  await wait(450);
  assert.deepEqual(p.sent, []);
});

// ------------------------------------------------------------------ 2026-10-23 layout in the content script
const LRM_PAGE = `<!doctype html><html><body>${body(read("tests/fixtures/job-card-2026-10-23.html"))}${body(read("tests/fixtures/job-search-2026-10-23.html"))}</body></html>`;
const LRM_URL = "https://www.linkedin.com/jobs/search-results/?currentJobId=4460331411";

test("new layout: the card is left untouched while auto-save runs; the opened job is read and matched", async () => {
  const p = load({ url: LRM_URL, html: LRM_PAGE });
  const card = p.doc.querySelector("[componentkey='job-card-component-ref-4448191242'][role='button']");
  const before = card.outerHTML;
  p.setWatch(watching({ 4448191242: "next" }));
  assert.equal(card.outerHTML, before);
  assert.match(card.textContent, /Software Engineer 3/);
  const res = await p.ask({ type: "EXTRACT_PREVIEW", waitForDetailMs: 300 });
  assert.deepEqual(JSON.parse(JSON.stringify([res.detailReason, res.detail.jobId, res.checks.pageUrlId, res.checks.idMatchesPageUrl, res.cards.map((c) => c.jobId)])), ["ok", "4460331411", "4460331411", true, ["4448191242"]]);
});

test("new layout: the user opens a different job -> the stale panel is not extracted for it", async () => {
  const p = load({ url: "https://www.linkedin.com/jobs/search-results/?currentJobId=4448191242", html: LRM_PAGE });
  const res = await p.ask({ type: "EXTRACT_PREVIEW", waitForDetailMs: 400 });
  assert.equal(res.detail, null);
  assert.equal(res.detailReason, "page-id-mismatch");
  assert.deepEqual(JSON.parse(JSON.stringify([res.checks.pageUrlId, res.checks.aboutId])), ["4448191242", "4460331411"]);
});

// ------------------------------------------------------------------ panel changes without a URL change (v0.12.0)
const NO_ID_URL = "https://www.linkedin.com/jobs/search-results/";

test("the panel is re-read when its description (re)renders even though the URL never changed; 'ready' only once it is stable", async () => {
  const p = load({ url: NO_ID_URL, watch: watching({}) });
  await wait(50);
  const box = p.doc.querySelector("[data-testid='expandable-text-box']");
  const holder = box.parentNode;
  box.remove(); // the panel goes back to loading (LinkedIn swapping the job in place)
  p.sent.length = 0;
  await wait(450);
  assert.ok(!p.sent.some((m) => m.ready), "loading panel: not ready");
  assert.equal(p.w.location.href, NO_ID_URL, "the URL did not change");
  holder.appendChild(box);
  await wait(1200); // observer debounce + two stable polls (generous: the full suite runs files in parallel)
  assert.equal(p.sent.filter((m) => m.ready === true).length, 1, "exactly one ready ping");
});

test("a panel that re-renders as the same job does not ping again", async () => {
  const p = load({ url: NO_ID_URL, watch: watching({}) });
  await wait(700); // the opening read settles first
  p.sent.length = 0;
  const unrelated = p.doc.createElement("div");
  p.doc.body.appendChild(unrelated);
  unrelated.textContent = "x";
  await wait(500);
  assert.deepEqual(p.sent, [], "same panel signature, same URL, no new cards");
});

test("capture off: no observer runs, nothing is sent; turning it on starts one, turning it off stops it", async () => {
  const p = load({ url: NO_ID_URL });
  assert.equal(p.hooks.state.observing, false);
  p.setWatch(watching({}));
  assert.equal(p.hooks.state.observing, true);
  p.setWatch({ status: "paused" });
  assert.equal(p.hooks.state.observing, false, "paused = off for the page");
  p.sent.length = 0;
  p.doc.body.appendChild(p.doc.createElement("div"));
  await wait(450);
  assert.deepEqual(p.sent, []);
  p.setWatch(watching({}));
  assert.equal(p.hooks.state.observing, true);
});

test("panelSignature names the job panel and whether its description rendered", () => {
  const p = load();
  assert.equal(p.hooks.panelSignature(), "JobDetails_AboutTheJob_4480307941|text");
  p.doc.querySelector("[data-testid='expandable-text-box']").remove();
  assert.equal(p.hooks.panelSignature(), "JobDetails_AboutTheJob_4480307941|loading");
  p.doc.querySelector("[id^='JobDetails_AboutTheJob_']").remove();
  assert.equal(p.hooks.panelSignature(), "none");
});

test("diagnostics are current even while capture is off (the page is synced on demand)", async () => {
  const p = load({ url: NO_ID_URL });
  p.w.history.pushState({}, "", NO_ID_URL + "?currentJobId=1");
  const res = await p.ask({ type: "DIAGNOSE" });
  assert.ok(res && res.ok !== false);
  assert.equal(p.hooks.state.urlChanges, 1);
});
