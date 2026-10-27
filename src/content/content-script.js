// Content script. Reads rendered job content ONLY when the extension asks (the popup, or the service worker during
// auto-save). Depends on LJS.* from src/extract/ (loaded first). It clicks, scrolls and pages ONLY in auto-click mode
// (opt-in per auto-save session, see "Auto-click" below); otherwise it never clicks, scrolls, opens or navigates anything.
//
// Auto-save: while the user has auto-save on (a flag the service worker keeps in chrome.storage.local), this script
//  * tells the worker "the page changed" after the USER navigates (opens a job, clicks Next) or more cards load, and
//    "ready" as soon as the job the user opened has rendered its details (no fixed waiting).
// It never adds anything to LinkedIn's page: per-job status (next to save, saved, partial, failed) is shown only in the
// extension's popup. Pings carry no job data; the worker decides whether this tab is watched and then asks for the snapshot.
(() => {
  const MSG = { GET_PAGE_INFO: "GET_PAGE_INFO", DIAGNOSE: "DIAGNOSE", EXTRACT_PREVIEW: "EXTRACT_PREVIEW", PAGE_CHANGED: "PAGE_CHANGED", PILOT_EVENT: "PILOT_EVENT" }; // keep in sync with shared/messages.js
  const WATCH_KEY = "ljs:watch"; // keep in sync with watch/watch-session.js
  const { selectors, extractor } = globalThis.LJS;
  const READY_POLL_MS = 150; // how often a just-opened job is checked for its details
  const READY_TIMEOUT_MS = 8000; // give up waiting after this; the worker then reports "still loading"
  const WAIT_MAX_MS = 6000; // upper bound for a requested wait (EXTRACT_PREVIEW waitForDetailMs)

  // ---- Lightweight change tracking (counts only; reads no job text) ----
  const state = { lastUrl: location.href, urlChanges: 0, cardElementsSeen: new WeakSet(), newCardsSinceLastExtract: 0, autoSave: false, lastSig: "none", observing: false, watch: null };

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

  // Which job's details panel is showing, and has its description rendered? LinkedIn can swap the panel to another job WITHOUT
  // changing the URL, so this is read from the panel itself: the About-the-job section's id ends with that job's own id (it
  // changes when the panel shows another job) and its text box appears when the description has rendered.
  const PANEL_SECTION = "[id^='JobDetails_AboutTheJob_']";
  function panelSignature() {
    const el = document.querySelector(PANEL_SECTION);
    if (!el) return "none";
    return `${el.id}|${el.querySelector("[data-testid='expandable-text-box']") ? "text" : "loading"}`;
  }

  // After the user opens a job: wait for ITS details to render, then say "ready" once. "Ready" needs the details to belong to the
  // selected job (the extractor checks the panel's own ids against each other and against the URL's id when it has one) AND the
  // panel to be unchanged across two checks, so a half-swapped panel is never read. Bounded by READY_TIMEOUT_MS; a newer change
  // (another job opened) replaces this wait. One timer at most; nothing runs when capture is off.
  let readyTimer = null;
  function watchForDetail() {
    clearTimeout(readyTimer);
    readyTimer = null;
    if (!state.autoSave) return;
    const started = Date.now();
    const want = selectedJobId();
    let prevSig = null;
    const tick = () => {
      readyTimer = null;
      if (!state.autoSave || !document.body || selectedJobId() !== want) return; // stopped, page gone, or another job opened
      const sig = panelSignature();
      let ready = false;
      try { ready = readDetail().ready; } catch { ready = false; }
      if (ready && sig === prevSig) return notifyPageChanged(true);
      prevSig = sig;
      if (Date.now() - started >= READY_TIMEOUT_MS) return notifyPageChanged(false); // let the worker report it
      readyTimer = setTimeout(tick, READY_POLL_MS);
    };
    tick();
  }

  function onUrlChange() {
    notifyPageChanged(false); // new cards / page: the worker reads them
    watchForDetail(); // and the opened job as soon as its details are in
  }

  // URL or card changes since the last look (cheap; also used by the diagnostics so they are right even while capture is off).
  function syncTracking() {
    let changed = false;
    if (location.href !== state.lastUrl) { state.lastUrl = location.href; state.urlChanges++; changed = true; } // SPA navigation
    if (countNewCards() > 0) changed = true;
    return changed;
  }

  // The page observer exists only while capture is on (no work, no memory held, when it is off). Debounced; one timer.
  let timer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!document.body || !state.autoSave) return; // the page is going away, or capture was switched off meanwhile
      const listChanged = syncTracking(); // new URL (user navigated) or new cards (next page, scrolling)
      const sig = panelSignature();
      const idChanged = sig.split("|")[0] !== state.lastSig.split("|")[0]; // the panel now shows ANOTHER job (no URL change needed)
      const sigChanged = sig !== state.lastSig; // ... or the same job's description arrived
      state.lastSig = sig;
      if (listChanged) onUrlChange();
      else if (idChanged || (sigChanged && !readyTimer)) watchForDetail(); // a wait already running for this job just carries on
    }, 250);
  });
  function startObserving() {
    if (state.observing || !document.body) return;
    observer.observe(document.body, { childList: true, subtree: true });
    state.observing = true;
  }
  function stopObserving() {
    if (!state.observing) return;
    observer.disconnect();
    clearTimeout(timer);
    timer = null;
    state.observing = false;
  }
  window.addEventListener("popstate", () => { state.lastUrl = location.href; state.urlChanges++; onUrlChange(); });

  // ---- Auto-click: open the jobs one by one (opt-in per session) ----
  // Runs only when the session was started with "Click through the jobs for me", only while it is "watching" (Pause / Stop
  // halt it at once), and only in the tab the worker confirms is the watched one. Per job: scroll its card into view, click
  // it like a user would, wait until the worker has CONFIRMED the save (or give up on that job after a while), pause a few
  // randomised seconds, then the next card. When every card is done it scrolls the list for more, then goes to the next
  // results page (LinkedIn's Next button; else the ?start= URL), until no page is left or the page limit is reached.
  // Saving itself is unchanged: opening a job triggers the same "page changed" / "ready" pings as a user's click.
  const PILOT = {
    firstDelayMs: 800, // after Start, before the first click
    gapMinMs: 2000, gapUsualMaxMs: 5000, gapMaxMs: 10000, // randomised pause between two jobs: usually 2-5 s ...
    longGapChance: 0.2, // ... and now and then (this share of pauses) a longer stop of 5-10 s
    clickDelayMs: 400, // after scrolling a card into view, before clicking it
    openTimeoutMs: 7000, // the clicked job must be the open one by then, or the click is tried again
    jobTimeoutMs: 30000, // give up waiting for one job's save after this
    maxAttempts: 3, // opens tried per job (the last one by URL); then it is skipped
    scrollWaitMs: 1500, maxScrolls: 3, // scroll the list this often for more cards before paging
    pageWaitMs: 5000, pageChecks: 3, // after paging: wait for new cards, at most pageWaitMs * pageChecks
    tickMs: 500,
    pageSize: 25, // LinkedIn's results per page (?start= steps)
  };
  const PILOT_MEM = "ljs:pilot"; // per-tab sessionStorage: survives a reload by URL (open attempts, page check)
  const pilot = { sessionId: null, allowed: false, finished: false, timer: null, target: null, clickedAt: 0, nextAt: 0, scrolls: 0, cardCount: -1 };

  const cardIdOf = (el) => { try { return document.evaluate(selectors.cardId, el, null, 2, null).stringValue.trim(); } catch { return ""; } };
  // Pause between two jobs: usually short (gapMinMs..gapUsualMaxMs), now and then (longGapChance) a long stop
  // (gapUsualMaxMs..gapMaxMs). Each range is picked evenly.
  function randomGap(rand = Math.random) {
    const usual = Math.min(Math.max(PILOT.gapUsualMaxMs, PILOT.gapMinMs), PILOT.gapMaxMs);
    const [lo, hi] = rand() < PILOT.longGapChance ? [usual, PILOT.gapMaxMs] : [PILOT.gapMinMs, usual];
    return lo + Math.floor(rand() * Math.max(hi - lo, 0));
  }

  function pilotMem() {
    let m = null;
    try { m = JSON.parse(sessionStorage.getItem(PILOT_MEM) || "null"); } catch { m = null; }
    return m && m.sessionId === pilot.sessionId && m.attempts ? m : { sessionId: pilot.sessionId, attempts: {}, prevFirst: null, pagedAt: 0 };
  }
  function savePilotMem(m) { try { sessionStorage.setItem(PILOT_MEM, JSON.stringify(m)); } catch { /* attempts are then per page load */ } }

  function pilotSend(msg) {
    try { return chrome.runtime.sendMessage({ type: MSG.PILOT_EVENT, ...msg }).catch(() => null); } catch { return Promise.resolve(null); }
  }

  // Done for this session = the worker answered for it (full, partial, refused, unusable), its details cannot be read, or it was
  // already saved with full details before this session. "pending" (being saved) and "card" (list card only) are not done.
  function jobDone(w, id) {
    const seen = (w && w.seen && w.seen[id]) || "";
    if (seen === "detail" || seen === "partial" || seen === "failed" || seen === "skipped") return true;
    if (!seen && w && w.dbStatus && w.dbStatus[id] === "full") return true;
    const j = w && w.jobs && w.jobs[id];
    return !!j && (j.det === "unreadable" || j.save === "failed");
  }
  const isOpen = (id) => selectedJobId() === id || panelSignature().startsWith(`JobDetails_AboutTheJob_${id}|`);

  // A user-like click on the card's title (never on its Dismiss button): pointer/mouse down-up, then click.
  function userClick(el) {
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    const at = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: r.left + Math.min(r.width / 2, 40), clientY: r.top + Math.min(r.height / 2, 12) };
    const P = typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
    for (const t of ["pointerover", "mouseover", "pointerdown", "mousedown", "pointerup", "mouseup"]) el.dispatchEvent(new (t.startsWith("pointer") ? P : MouseEvent)(t, at));
    el.dispatchEvent(new MouseEvent("click", at));
  }
  function clickCard(id) {
    const card = cardElements().find((el) => cardIdOf(el) === id);
    if (!card) return false;
    userClick(card.querySelector("p span[aria-hidden='true']") || card.querySelector("p") || card);
    return true;
  }
  const onSearchList = () => /^\/jobs\/(search|search-results|collections)\//.test(location.pathname);
  function openByUrl(id) {
    const u = new URL(location.href);
    u.searchParams.set("currentJobId", id);
    location.assign(u.href);
  }

  // The scrollable list that holds the cards: scrolled to its end so LinkedIn renders / loads more cards.
  function scrollListToEnd(cards) {
    const last = cards[cards.length - 1];
    if (!last) { window.scrollTo(0, document.body.scrollHeight); return; }
    if (typeof last.scrollIntoView === "function") last.scrollIntoView({ block: "end" });
    for (let el = last.parentElement; el && el !== document.body; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 10) {
        const oy = getComputedStyle(el).overflowY;
        if (oy === "auto" || oy === "scroll") { el.scrollTop = el.scrollHeight; break; }
      }
    }
  }

  // LinkedIn's "next results page" control (enabled; never one inside the job panel or a carousel).
  function nextPageControl() {
    const label = (el) => (el.getAttribute("aria-label") || "").trim().toLowerCase();
    const usable = (el) => !el.disabled && el.getAttribute("aria-disabled") !== "true" && !el.closest("[data-testid^='carousel'], [id^='JobDetails_'], [role='dialog']");
    const all = [...document.querySelectorAll("button, a")];
    const byLabel = all.find((el) => (label(el) === "view next page" || label(el) === "next page") && usable(el));
    if (byLabel) return byLabel;
    // Numbered pages: the one after the current ("Page 3" after the aria-current "Page 2").
    const cur = all.find((el) => /^page \d+$/.test(label(el)) && ["page", "true"].includes(el.getAttribute("aria-current") || el.getAttribute("aria-pressed") || ""));
    if (cur) {
      const n = Number(label(cur).slice(5)) + 1;
      const nx = all.find((el) => label(el) === `page ${n}` && usable(el));
      if (nx) return nx;
    }
    return all.find((el) => /^next$/i.test((el.textContent || "").trim()) && !label(el) && usable(el)) || null;
  }
  function nextPageUrl(cardCount) {
    if (!onSearchList() || cardCount < PILOT.pageSize - 5) return null; // a short page is the last one
    const u = new URL(location.href);
    u.searchParams.set("start", String((Number(u.searchParams.get("start")) || 0) + PILOT.pageSize));
    u.searchParams.delete("currentJobId");
    return u.href;
  }

  function pilotActive() {
    const w = state.watch;
    return state.autoSave && pilot.allowed && !pilot.finished && !!w && w.autoClick === true && w.sessionId === pilot.sessionId;
  }
  function pilotSchedule(ms) { clearTimeout(pilot.timer); pilot.timer = setTimeout(pilotTick, ms); }
  function pilotHalt() { clearTimeout(pilot.timer); pilot.timer = null; pilot.target = null; }
  function pilotFinish(reason) {
    pilot.finished = true;
    pilotHalt();
    pilotSend({ event: "finished", reason });
  }

  // Called on every session change (start, a save confirmed, pause, resume, stop).
  function pilotSync(w) {
    state.watch = w || null;
    if (!(state.autoSave && w && w.autoClick === true && w.sessionId)) { pilotHalt(); return; }
    if (pilot.sessionId !== w.sessionId) {
      pilotHalt();
      Object.assign(pilot, { sessionId: w.sessionId, allowed: false, finished: false, nextAt: 0, scrolls: 0, cardCount: -1 });
      const sid = w.sessionId;
      pilotSend({ event: "hello" }).then((r) => {
        if (pilot.sessionId !== sid || !r || r.pilot !== true) return; // another tab is the watched one: never click here
        pilot.allowed = true;
        if (pilotActive()) pilotSchedule(PILOT.firstDelayMs);
      });
      return;
    }
    if (pilotActive() && !pilot.timer) pilotSchedule(PILOT.tickMs);
  }

  function pilotTick() {
    pilot.timer = null;
    if (!pilotActive() || !document.body) return;
    try { pilotStep(); } catch (err) { console.warn("[LJS] auto-click step failed:", err); }
    if (pilotActive() && !pilot.timer) pilotSchedule(PILOT.tickMs);
  }

  function pilotStep() {
    const w = state.watch;
    const now = Date.now();
    if (now < pilot.nextAt) return;
    const mem = pilotMem();

    // 1. Waiting for the job opened last: saved (or refused) -> pause, then the next one.
    if (pilot.target) {
      const id = pilot.target;
      if (jobDone(w, id)) { pilot.target = null; pilot.nextAt = now + randomGap(); return; }
      if (!isOpen(id) && now - pilot.clickedAt > PILOT.openTimeoutMs) { pilot.target = null; return; } // the click did not open it: try again
      if (now - pilot.clickedAt > PILOT.jobTimeoutMs) { pilot.target = null; pilot.nextAt = now + randomGap(); } // never saved: try again / move on
      return;
    }

    const cards = cardElements();
    if (cards.length !== pilot.cardCount) { pilot.cardCount = cards.length; pilot.scrolls = 0; }

    // 2. Just paged: wait until the list shows other jobs than the page before.
    if (mem.prevFirst) {
      const first = cards.length ? cardIdOf(cards[0]) : "";
      if (first && first !== mem.prevFirst) { mem.prevFirst = null; savePilotMem(mem); }
      else if (now - mem.pagedAt > PILOT.pageWaitMs * PILOT.pageChecks) return pilotFinish("no-more-pages");
      else return;
    }

    // 3. Open the first card (in list order) that is not done yet.
    for (const el of cards) {
      const id = cardIdOf(el);
      if (!/^\d{5,20}$/.test(id) || jobDone(w, id) || (w.seen && w.seen[id] === "pending")) continue;
      const tries = mem.attempts[id] || 0;
      if (tries >= PILOT.maxAttempts) continue;
      mem.attempts[id] = tries + 1;
      savePilotMem(mem);
      pilot.target = id;
      pilot.clickedAt = now;
      if (tries === 0 && isOpen(id)) { watchForDetail(); return; } // already open (e.g. at Start): just wait for its save
      if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
      pilotSend({ event: "clicked" });
      pilot.nextAt = now + PILOT.clickDelayMs;
      setTimeout(() => {
        if (!pilotActive() || pilot.target !== id) return;
        pilot.clickedAt = Date.now();
        if (tries + 1 >= PILOT.maxAttempts && onSearchList()) openByUrl(id); // last try: open it by its URL
        else if (!clickCard(id)) pilot.target = null; // the card was re-rendered away: pick again
      }, PILOT.clickDelayMs);
      return;
    }

    // 4. Every card is done: scroll for more cards, then go to the next results page.
    if (pilot.scrolls < PILOT.maxScrolls) { pilot.scrolls += 1; scrollListToEnd(cards); pilot.nextAt = now + PILOT.scrollWaitMs; return; }
    if (!cards.length) return pilotFinish("no-list");
    const p = w.pilot || {};
    if ((p.pages || 1) >= (p.maxPages || 1)) return pilotFinish("max-pages");
    const control = nextPageControl();
    const url = control ? null : nextPageUrl(cards.length);
    if (!control && !url) return pilotFinish("no-more-pages");
    Object.assign(mem, { prevFirst: cardIdOf(cards[0]) || "none", pagedAt: now });
    savePilotMem(mem);
    pilot.scrolls = 0;
    pilot.nextAt = now + PILOT.pageWaitMs;
    pilotSend({ event: "page" });
    if (control) userClick(control);
    else setTimeout(() => { if (pilotActive()) location.assign(url); }, 300); // after the "page" event went out
  }

  // ---- Auto-save flag (read-only view of the worker's state) ----
  const applyWatch = (w) => {
    const was = state.autoSave;
    state.autoSave = !!w && w.status === "watching";
    if (state.autoSave) { if (!was) { state.lastSig = panelSignature(); syncTracking(); } startObserving(); }
    else { clearTimeout(readyTimer); readyTimer = null; stopObserving(); }
    if (state.autoSave && !was) { notifyPageChanged(false); watchForDetail(); } // just switched on, or loaded while on
    pilotSync(w);
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
          syncTracking(); // the observer is off while capture is off: bring the counts up to date first
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
  if (globalThis.__LJS_TEST__) globalThis.__LJS_TEST__.content = { selectedJobId, readDetail, panelSignature, state, pilot, PILOT, jobDone, nextPageControl, randomGap };

  console.log("[LJS] content script loaded on", location.pathname);
})();
