// The real content script (classic script) in jsdom with a fake chrome API: status badges on job cards, waiting for the
// opened job's details, and the "ready" ping. Fixtures are trimmed live markup; jsdom is not Chrome.
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
  const badges = () => [...w.document.querySelectorAll("[data-ljs-badge]")].map((b) => [b.closest("[componentkey^='job-card-component-ref-'][role='button']").getAttribute("componentkey").slice(23), b.textContent]);
  return { w, doc: w.document, sent, setWatch, ask, badges, hooks: w.__LJS_TEST__.content };
}
const watching = (marks) => ({ status: "watching", marks });

// ------------------------------------------------------------------ badges
test("badges show the confirmed state per job id; one badge per card, updated in place", async () => {
  const p = load();
  p.setWatch(watching({ 4480307941: "full", 4450363857: "next", 4400000001: "failed" }));
  // The fixture lists job 4480307941 twice (LinkedIn can render the same job in two cards): each card gets ONE badge.
  assert.deepEqual(p.badges().sort(), [["4400000001", "Failed"], ["4450363857", "Next to save"], ["4480307941", "Full details saved"], ["4480307941", "Full details saved"]]);
  p.setWatch(watching({ 4480307941: "full", 4450363857: "partial", 4400000001: "next" }));
  p.hooks.applyBadges(); p.hooks.applyBadges(); // repeated renders never duplicate
  assert.deepEqual(p.badges().sort(), [["4400000001", "Next to save"], ["4450363857", "Partial"], ["4480307941", "Full details saved"], ["4480307941", "Full details saved"]]);
  assert.equal(p.doc.querySelectorAll("[data-ljs-badge]").length, 4, "one per card element");
  const b = p.doc.querySelector("[data-ljs-badge='full']");
  assert.equal(b.style.pointerEvents, "none", "never intercepts the user's click");
});

test("the initial storage read never overrides a newer state (no stale badges or flags)", async () => {
  const p = load({ watch: null }); // storage still says 'off' ...
  p.setWatch(watching({ 4450363857: "next" })); // ... but a newer change already turned it on
  await wait(30); // the initial read resolves now
  assert.deepEqual(p.badges(), [["4450363857", "Next to save"]]);
});

test("a job is never shown as saved without a confirmed mark (no badge from title/company alone)", () => {
  const p = load();
  p.setWatch(watching({}));
  assert.deepEqual(p.badges(), []);
});

test("LinkedIn re-rendering a card: the badge comes back once, not twice", async () => {
  const p = load();
  p.setWatch(watching({ 4450363857: "next" }));
  const card = p.doc.querySelector("[componentkey='job-card-component-ref-4450363857'][role='button']");
  const copy = card.cloneNode(true); // LinkedIn replaces the node; the clone carries our old badge
  card.replaceWith(copy);
  await wait(450); // the observer is debounced (300 ms)
  assert.deepEqual(p.badges(), [["4450363857", "Next to save"]]);
  copy.querySelector("[data-ljs-badge]").remove(); // a re-render without our badge
  await wait(450);
  assert.deepEqual(p.badges(), [["4450363857", "Next to save"]]);
});

test("Stop removes every badge cleanly", () => {
  const p = load();
  p.setWatch(watching({ 4480307941: "full", 4450363857: "next" }));
  assert.equal(p.badges().length, 3);
  p.setWatch({ status: "stopped", marks: {} });
  assert.deepEqual(p.badges(), []);
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
  await wait(400);
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
