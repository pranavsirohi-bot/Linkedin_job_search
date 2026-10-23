// Content script. Reads rendered job content ONLY when the extension asks (the popup, or the service worker during
// auto-save). It never clicks, scrolls, opens or navigates anything. Depends on LJS.* from src/extract/ (loaded first).
//
// Auto-save: while the user has auto-save on (a flag the service worker keeps in chrome.storage.local), this script
//  * tells the worker "the page changed" after the USER navigates (opens a job, clicks Next) or more cards load, and
//    "ready" as soon as the job the user opened has rendered its details (no fixed waiting);
//  * draws a small status badge on each job card (Next to save / Full details saved / Partial / Failed) from the
//    worker's confirmed save state. Badges are visual only (pointer-events: none) and are removed when auto-save ends.
// Pings carry no job data; the worker decides whether this tab is watched and then asks for the snapshot.
(() => {
  const MSG = { GET_PAGE_INFO: "GET_PAGE_INFO", DIAGNOSE: "DIAGNOSE", EXTRACT_PREVIEW: "EXTRACT_PREVIEW", PAGE_CHANGED: "PAGE_CHANGED" }; // keep in sync with shared/messages.js
  const WATCH_KEY = "ljs:watch"; // keep in sync with watch/watch-session.js
  const { selectors, extractor } = globalThis.LJS;
  const READY_POLL_MS = 150; // how often a just-opened job is checked for its details
  const READY_TIMEOUT_MS = 8000; // give up waiting after this; the worker then reports "still loading"
  const WAIT_MAX_MS = 6000; // upper bound for a requested wait (EXTRACT_PREVIEW waitForDetailMs)

  // ---- Lightweight change tracking (counts only; reads no job text) ----
  const state = { lastUrl: location.href, urlChanges: 0, cardElementsSeen: new WeakSet(), newCardsSinceLastExtract: 0, autoSave: false, marks: {} };

  function cardElements() {
    const r = document.evaluate(selectors.card, document, null, 7, null);
    const out = [];
    for (let i = 0; i < r.snapshotLength; i++) out.push(r.snapshotItem(i));
    return out;
  }

  function countNewCards() {
    let added = 0;
    for (const el of cardElements()) {
      if (!state.cardElementsSeen.has(el)) { state.cardElementsSeen.add(el); state.newCardsSinceLastExtract++; added++; }
    }
    return added;
  }

  function send(msg) {
    if (!state.autoSave) return;
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      state.autoSave = false; // the extension was reloaded: this old script can no longer talk to it
    }
  }
  const notifyPageChanged = (ready = false) => send(ready ? { type: MSG.PAGE_CHANGED, ready: true } : { type: MSG.PAGE_CHANGED });

  // The job the URL says is open (search results: ?currentJobId=..., job page: /jobs/view/<id>/).
  function selectedJobId() {
    try {
      const u = new URL(location.href);
      const m = u.pathname.match(/\/jobs\/view\/(?:[^/]*-)?(\d{5,})/);
      return m ? m[1] : u.searchParams.get("currentJobId");
    } catch { return null; }
  }

  // Detail extraction for the open job; ok only when its panel shows the SELECTED job and its description is there.
  function readDetail() {
    const d = extractor.extractDetail(document, new Date(), location.href);
    const want = selectedJobId();
    const ready = !!d.job && (!want || d.job.jobId === want);
    return { d, ready };
  }

  // After the user opens a job: watch for its details to render, then say "ready" once. Bounded by READY_TIMEOUT_MS.
  let readyTimer = null;
  function watchForDetail() {
    clearTimeout(readyTimer);
    if (!state.autoSave) return;
    const started = Date.now();
    const want = selectedJobId();
    const tick = () => {
      readyTimer = null;
      if (!state.autoSave || !document.body || selectedJobId() !== want) return; // stopped, page gone, or another job opened
      let ready = false;
      try { ready = readDetail().ready; } catch { ready = false; }
      if (ready) return notifyPageChanged(true);
      if (Date.now() - started >= READY_TIMEOUT_MS) return notifyPageChanged(false); // let the worker report it
      readyTimer = setTimeout(tick, READY_POLL_MS);
    };
    tick();
  }

  function onUrlChange() {
    notifyPageChanged(false); // new cards / page: the worker reads them
    watchForDetail(); // and the opened job as soon as its details are in
  }

  // ---- Status badges on job cards ----
  const BADGE_ATTR = "data-ljs-badge";
  const BADGES = {
    next: { text: "Next to save", bg: "#0a66c2", fg: "#ffffff" },
    full: { text: "Full details saved", bg: "#dafbe1", fg: "#116329" },
    partial: { text: "Partial", bg: "#fff8c5", fg: "#7d4e00" },
    failed: { text: "Failed", bg: "#ffebe9", fg: "#a40e26" },
    saving: { text: "Saving...", bg: "#eaeef2", fg: "#57606a" },
  };
  // Idempotent: one badge per card, updated in place (LinkedIn re-renders cards; nothing is duplicated). Only touches
  // the DOM when something actually changes, so it never feeds the MutationObserver in a loop.
  function applyBadges() {
    for (const el of cardElements()) {
      let id = "";
      try { id = document.evaluate(selectors.cardId, el, null, 2, null).stringValue.trim(); } catch { id = ""; }
      const kind = state.autoSave && id ? state.marks[id] : undefined;
      const badges = el.querySelectorAll(`[${BADGE_ATTR}]`);
      for (let i = 1; i < badges.length; i++) badges[i].remove(); // never more than one
      let badge = badges[0] || null;
      const spec = kind && BADGES[kind];
      if (!spec) { if (badge) badge.remove(); continue; }
      if (!badge) {
        badge = document.createElement("span");
        badge.setAttribute(BADGE_ATTR, "");
        badge.setAttribute("aria-hidden", "true");
        badge.style.cssText = "display:inline-block;margin:4px 0 0;padding:1px 8px;border-radius:10px;font:600 12px/18px system-ui,sans-serif;pointer-events:none;";
        el.appendChild(badge);
      }
      if (badge.getAttribute(BADGE_ATTR) !== kind) {
        badge.setAttribute(BADGE_ATTR, kind);
        badge.textContent = spec.text;
        badge.style.background = spec.bg;
        badge.style.color = spec.fg;
      }
    }
  }
  function removeBadges() {
    for (const b of document.querySelectorAll(`[${BADGE_ATTR}]`)) b.remove();
  }

  let timer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!document.body) return; // the page is going away
      let changed = false;
      if (location.href !== state.lastUrl) { state.lastUrl = location.href; state.urlChanges++; changed = true; } // SPA navigation
      if (countNewCards() > 0) changed = true;
      if (state.autoSave) applyBadges(); // re-rendered cards get their badge back
      if (changed) onUrlChange();
    }, 300);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("popstate", () => { state.lastUrl = location.href; state.urlChanges++; onUrlChange(); });

  // ---- Auto-save flag and badge marks (read-only view of the worker's state) ----
  const applyWatch = (w) => {
    const was = state.autoSave;
    state.autoSave = !!w && w.status === "watching";
    state.marks = state.autoSave && w.marks && typeof w.marks === "object" ? w.marks : {};
    if (state.autoSave) applyBadges();
    else { clearTimeout(readyTimer); removeBadges(); }
    if (state.autoSave && !was) { notifyPageChanged(false); watchForDetail(); } // just switched on, or loaded while on
  };
  // The initial read may resolve after a newer change event: a change event always wins over that older snapshot.
  let changedSinceLoad = false;
  try {
    chrome.storage.local.get(WATCH_KEY).then((r) => { if (!changedSinceLoad) applyWatch(r[WATCH_KEY]); }, () => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && WATCH_KEY in changes) { changedSinceLoad = true; applyWatch(changes[WATCH_KEY].newValue); }
    });
  } catch {
    /* storage unavailable: auto-save pings stay off; manual actions still work */
  }

  // ---- Messaging ----
  function snapshot() {
    const cards = extractor.extractCards(document, new Date());
    // The open job's blanks may be filled from ITS OWN card (same job ID), then re-graded.
    const detail = extractor.withCardFallback(extractor.extractDetail(document, new Date(), location.href), cards);
    state.newCardsSinceLastExtract = 0;
    return {
      ok: true,
      layout: detail.layout,
      detail: detail.job,
      detailReason: detail.reason,
      fieldSources: detail.sources,
      failedSelectors: detail.failed,
      selectorIssues: detail.selectorIssues || [],
      checks: detail.checks || {}, // job IDs, match flags, description length: no page text
      completeness: extractor.completeness(detail, cards), // field names only, no page text
      cards,
    };
  }
  // Reasons that mean "the open job is still rendering" (worth waiting for), not "there is no job open".
  const LOADING = new Set(["description-not-loaded", "description-empty", "panel-loading-id-mismatch", "page-id-mismatch"]);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      switch (message?.type) {
        case MSG.GET_PAGE_INFO:
          sendResponse({ ok: true, url: location.href, title: document.title });
          return false;
        case MSG.DIAGNOSE:
          sendResponse({ ok: true, report: { ...extractor.diagnose(document, location.href), tracking: { urlChanges: state.urlChanges, newCardsSinceLastExtract: state.newCardsSinceLastExtract } } });
          return false;
        case MSG.EXTRACT_PREVIEW: {
          const waitMs = Math.min(Math.max(Number(message.waitForDetailMs) || 0, 0), WAIT_MAX_MS);
          const first = snapshot();
          if (!waitMs || first.detail || !LOADING.has(first.detailReason)) { sendResponse(first); return false; }
          // Bounded wait for the open job's details to render (checked every READY_POLL_MS), then answer.
          const until = Date.now() + waitMs;
          const poll = () => {
            let snap;
            try { snap = snapshot(); } catch (err) { sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }); return; }
            if (snap.detail || !LOADING.has(snap.detailReason) || Date.now() >= until) sendResponse({ ...snap, waitedMs: waitMs - Math.max(until - Date.now(), 0) });
            else setTimeout(poll, READY_POLL_MS);
          };
          setTimeout(poll, READY_POLL_MS);
          return true; // async response
        }
        default:
          return false;
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      return false;
    }
  });

  // Test hook (no effect in the extension): lets tests drive the debounced observer deterministically.
  if (globalThis.__LJS_TEST__) globalThis.__LJS_TEST__.content = { applyBadges, removeBadges, selectedJobId, readDetail, state };

  console.log("[LJS] content script loaded on", location.pathname);
})();
