// Auto-click in the real content script (classic script) in jsdom with a fake chrome API: the jobs in the list are opened
// one at a time, each only after the previous one's save was confirmed; Pause halts it; it pages on, then reports why it
// finished. Fixtures are trimmed live markup; jsdom is not Chrome (no layout, so scrolling is a no-op here).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const SCRIPTS = ["src/extract/xpath-selectors.js", "src/extract/normalize.js", "src/extract/extractor.js", "src/content/content-script.js"].map(read);
const body = (html) => html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>"));
const PAGE = `<!doctype html><html><body>${body(read("tests/fixtures/job-cards.html"))}${body(read("tests/fixtures/job-detail.html"))}</body></html>`;
const BASE = "https://www.linkedin.com/jobs/search-results/";
const OPEN = "4480307941"; // the job the URL selects (and the detail panel shows) when the page loads
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const windows = [];
test.afterEach(async () => { while (windows.length) windows.pop().close(); await wait(100); });

async function waitFor(cond, what) {
  for (let i = 0; i < 1000; i++) { if (cond()) return; await wait(10); }
  throw new Error(`timed out waiting for ${what}`);
}

function load({ html = PAGE, url = `${BASE}?currentJobId=${OPEN}`, pilot = true } = {}) {
  const virtualConsole = new VirtualConsole(); // the last open-by-URL try navigates, which jsdom does not do: not an error here
  virtualConsole.on("jsdomError", (e) => { if (!/navigation/.test(e.message)) console.error(e); });
  const dom = new JSDOM(html, { url, runScripts: "outside-only", virtualConsole });
  const w = dom.window;
  windows.push(w);
  const sent = [];
  const listeners = [];
  w.chrome = {
    runtime: {
      sendMessage: async (m) => { sent.push(m); return m.type === "PILOT_EVENT" && m.event === "hello" ? { ok: true, pilot } : { ok: true }; },
      onMessage: { addListener: () => {} },
    },
    storage: { local: { get: async () => ({}) }, onChanged: { addListener: (fn) => listeners.push(fn) } },
  };
  w.console.log = () => {};
  w.__LJS_TEST__ = {};
  for (const s of SCRIPTS) w.eval(s);
  const hooks = w.__LJS_TEST__.content;
  Object.assign(hooks.PILOT, { firstDelayMs: 5, gapMinMs: 5, gapMaxMs: 10, clickDelayMs: 5, scrollWaitMs: 5, pageWaitMs: 30, pageChecks: 2, tickMs: 10 });
  // Clicking a card selects its job like LinkedIn does (SPA URL change); the clicks are recorded in order.
  const clicks = [];
  for (const card of w.document.querySelectorAll("[role='button'][componentkey^='job-card-component-ref-']")) {
    card.addEventListener("click", () => {
      const id = card.getAttribute("componentkey").slice(23);
      clicks.push(id);
      w.history.pushState({}, "", `${BASE}?currentJobId=${id}`);
    });
  }
  let session = null;
  const setWatch = (patch) => {
    session = { sessionId: "s1", status: "watching", autoClick: true, seen: {}, jobs: {}, dbStatus: {}, pilot: { pages: 1, maxPages: 1 }, ...session, ...patch };
    for (const l of listeners) l({ "ljs:watch": { newValue: JSON.parse(JSON.stringify(session)) } }, "local");
  };
  const saved = (id, outcome = "detail") => setWatch({ seen: { ...session.seen, [id]: outcome } }); // the worker confirmed the save
  const events = () => sent.filter((m) => m.type === "PILOT_EVENT").map((m) => (m.reason ? `${m.event}:${m.reason}` : m.event));
  return { w, doc: w.document, sent, clicks, setWatch, saved, events, hooks };
}

test("opens every job one by one, each only after the previous save was confirmed, then finishes at the page limit", async () => {
  const p = load();
  p.setWatch({});
  await wait(60);
  assert.deepEqual(p.clicks, [], "the job already open is not clicked; its save is awaited first");
  p.saved(OPEN);
  await waitFor(() => p.clicks.length === 1, "the second job to be opened");
  assert.deepEqual(p.clicks, ["4450363857"]);
  await wait(80);
  assert.deepEqual(p.clicks, ["4450363857"], "nothing else is opened while that job is not saved yet");
  p.saved("4450363857", "partial");
  // The fixture lists 4480307941 twice: the second card is the same, already saved job -> skipped.
  await waitFor(() => p.clicks.length === 2, "the third job");
  assert.deepEqual(p.clicks, ["4450363857", "4400000001"]);
  p.saved("4400000001");
  await waitFor(() => p.events().some((e) => e.startsWith("finished")), "the end");
  assert.deepEqual(p.events(), ["hello", "clicked", "clicked", "finished:max-pages"]);
  assert.deepEqual(p.clicks, ["4450363857", "4400000001"], "no job is opened twice");
});

test("the pause between two jobs is usually 2-5 s, now and then a long stop of 5-10 s", () => {
  const { hooks } = load({ pilot: false });
  Object.assign(hooks.PILOT, { gapMinMs: 2000, gapUsualMaxMs: 5000, gapMaxMs: 10000, longGapChance: 0.2 });
  const seq = (...v) => () => v.shift();
  assert.equal(hooks.randomGap(seq(0.5, 0)), 2000, "usual pause, shortest");
  assert.equal(hooks.randomGap(seq(0.99, 0.999999)), 4999, "usual pause, longest");
  assert.equal(hooks.randomGap(seq(0.1, 0)), 5000, "long stop, shortest");
  assert.equal(hooks.randomGap(seq(0.1, 0.999999)), 9999, "long stop, longest");
  const gaps = Array.from({ length: 2000 }, () => hooks.randomGap());
  assert.ok(gaps.every((g) => g >= 2000 && g < 10000), "always within 2-10 s");
  const longShare = gaps.filter((g) => g >= 5000).length / gaps.length;
  assert.ok(longShare > 0.1 && longShare < 0.3, `about one pause in five is long (got ${longShare})`);
});

test("jobs already saved in full before this session, or refused, are not opened again", async () => {
  const p = load();
  p.setWatch({ seen: { [OPEN]: "detail" }, dbStatus: { 4450363857: "full" }, jobs: { 4400000001: { det: "unreadable" } } });
  await waitFor(() => p.events().some((e) => e.startsWith("finished")), "the end");
  assert.deepEqual(p.clicks, []);
});

test("another tab (the worker says it is not the watched one) never clicks", async () => {
  const p = load({ pilot: false });
  p.setWatch({});
  p.saved(OPEN);
  await wait(150);
  assert.deepEqual(p.clicks, []);
  assert.deepEqual(p.events(), ["hello"]);
});

test("a session without auto-click never clicks", async () => {
  const p = load();
  p.setWatch({ autoClick: false, pilot: null });
  p.saved(OPEN);
  await wait(150);
  assert.deepEqual([p.clicks, p.events()], [[], []]);
});

test("Pause halts the clicking at once; Resume carries on with the next job", async () => {
  const p = load();
  p.setWatch({});
  p.saved(OPEN);
  await waitFor(() => p.clicks.length === 1, "the second job");
  p.setWatch({ status: "paused" });
  p.saved("4450363857");
  await wait(150);
  assert.deepEqual(p.clicks, ["4450363857"], "nothing is opened while paused");
  p.setWatch({ status: "watching" });
  await waitFor(() => p.clicks.length === 2, "the next job after Resume");
  assert.equal(p.clicks[1], "4400000001");
});

test("a click that does not open the job is retried, then the job is skipped", async () => {
  const p = load();
  Object.assign(p.hooks.PILOT, { openTimeoutMs: 60, maxAttempts: 2 });
  // This card ignores clicks (the URL never selects it).
  const dead = p.doc.querySelector("[componentkey='job-card-component-ref-4450363857'][role='button']");
  dead.replaceWith(dead.cloneNode(true));
  const deadClicks = [];
  p.doc.querySelector("[componentkey='job-card-component-ref-4450363857'][role='button']").addEventListener("click", () => deadClicks.push(1));
  p.setWatch({});
  p.saved(OPEN);
  await waitFor(() => p.clicks.includes("4400000001"), "the job after the dead one");
  assert.equal(deadClicks.length, 1, "the first try is a click; the last try is by URL (a reload, not run in jsdom)");
});

test("all jobs on the page done: LinkedIn's next-page button is clicked; a page that never changes ends the run", async () => {
  const p = load();
  const next = p.doc.createElement("button");
  next.setAttribute("aria-label", "View next page");
  next.textContent = "Next";
  let paged = 0;
  next.addEventListener("click", () => { paged++; });
  p.doc.body.appendChild(next);
  p.setWatch({ seen: { [OPEN]: "detail", 4450363857: "detail", 4400000001: "detail" }, pilot: { pages: 1, maxPages: 3 } });
  await waitFor(() => p.events().some((e) => e.startsWith("finished")), "the end");
  assert.equal(paged, 1);
  assert.deepEqual(p.events(), ["hello", "page", "finished:no-more-pages"], "the list never changed after paging");
});

test("the next-page finder ignores the job panel's carousel 'Next' button and disabled controls", () => {
  const html = read("tests/fixtures/job-search-2026-10-23.html");
  const p = load({ html });
  assert.equal(p.hooks.nextPageControl(), null, "the fixture only has a carousel 'Next'");
  const off = p.doc.createElement("button");
  off.setAttribute("aria-label", "View next page");
  off.disabled = true;
  p.doc.body.appendChild(off);
  assert.equal(p.hooks.nextPageControl(), null);
  const page3 = p.doc.createElement("button");
  page3.setAttribute("aria-label", "Page 3");
  const page2 = p.doc.createElement("button");
  page2.setAttribute("aria-label", "Page 2");
  page2.setAttribute("aria-current", "page");
  p.doc.body.append(page2, page3);
  assert.equal(p.hooks.nextPageControl(), page3, "numbered pages: the one after the current page");
});

test("auto-click switched on in a session that started without it: clicking starts; switched off: it stops", async () => {
  const p = load();
  p.setWatch({ autoClick: false, pilot: null });
  p.saved(OPEN);
  await wait(80);
  assert.deepEqual(p.clicks, []);
  p.setWatch({ autoClick: true, pilot: { pages: 1, maxPages: 5 } });
  await waitFor(() => p.clicks.length === 1, "the first click after switching on");
  assert.deepEqual(p.clicks, ["4450363857"]);
  p.setWatch({ autoClick: false });
  p.saved("4450363857");
  await wait(150);
  assert.deepEqual(p.clicks, ["4450363857"], "nothing more after switching off");
  p.setWatch({ autoClick: true });
  await waitFor(() => p.clicks.length === 2, "clicking resumes when switched on again");
});
