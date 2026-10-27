// Auto-save session: after the user presses Start, every LinkedIn results page or job opened in that tab is saved
// automatically. The worker only reacts when the page changes (the content script sends a data-free "page changed"
// ping), then reads that page once and saves the jobs it has not saved yet in this session, a few at a time.
//
// Auto-click (opt-in per session, `autoClick`): the content script in the watched tab opens the jobs itself, one at a
// time, and moves on to the next results page up to `maxPages` (see content-script.js). The worker only keeps its
// counters (st.pilot) and ends the session when the content script reports that the list is finished.
//
// State lives in storage (survives the service worker sleeping); one session at a time; Stop prevents any further batch.
import { RunError } from "../batch/run-state.js";

export const WATCH_KEY = "ljs:watch";
export const WATCH_LIMITS = Object.freeze({
  batchSize: 5, // records per save request
  settleMs: 600, // wait after an ordinary "page changed" ping (new cards / page) so LinkedIn finishes rendering
  readySettleMs: 100, // the content script saw the opened job's details render: read almost at once
  retryMs: 5000, // retry after a connection problem
  maxRetries: 3,
  maxSeen: 5000, // job ids remembered per session (in-session de-duplication)
  detailRereads: 2, // the open job's panel was still loading: read the same page again (read-only) up to this often
  detailRereadMs: 1500,
  maxJobRecords: 500, // per-job tracking records kept (the oldest are dropped)
  maxTries: 3, // saves attempted for one job when the database keeps refusing it
  retryFailedAfterMs: 5000, // a refused job is tried again only if it is read again at least this long afterwards
  defaultMaxPages: 5, // auto-click: results pages walked through when the popup sends no limit
  maxMaxPages: 100,
});
// Why auto-click ended (sent by the content script; anything else is recorded as "no-more-pages").
export const PILOT_FINISH_REASONS = Object.freeze(["no-more-pages", "max-pages", "no-list"]);
// Detail-extraction reasons that mean "the panel is still rendering", not "there is no job open".
const PANEL_LOADING = new Set(["description-not-loaded", "description-empty", "panel-loading-id-mismatch", "page-id-mismatch"]);

const JOB_ID_RE = /^\d{5,20}$/;
const empty = (v) => v == null || v === "" || (Array.isArray(v) && v.length === 0);

function mergeById(records) {
  const byId = new Map();
  for (const r of records) {
    if (!r || typeof r !== "object" || typeof r.jobId !== "string" || !JOB_ID_RE.test(r.jobId)) continue;
    const prev = byId.get(r.jobId);
    if (!prev) { byId.set(r.jobId, { ...r }); continue; }
    const out = { ...prev };
    for (const [k, v] of Object.entries(r)) if (!empty(v)) out[k] = v;
    if (prev.source === "detail" || r.source === "detail") out.source = "detail";
    // Status and warnings describe the detail read; a card's "partial / card-only" never overrides them.
    const d = r.source === "detail" ? r : prev.source === "detail" ? prev : null;
    if (d) { out.extractionStatus = d.extractionStatus; out.extractionWarnings = d.extractionWarnings || []; }
    byId.set(r.jobId, out);
  }
  return [...byId.values()];
}

const hasDetails = (r) => r.source !== "card" && !empty(r.description);
// Partial = a list card, or a detail read graded "partial" (a core field missing). Ungraded detail records are not partial.
const isPartial = (r) => r.source === "card" || r.extractionStatus === "partial";
const PAGE_MAX = 100; // visible jobs remembered for the guided checklist

// Outcome of a job in this session, recorded ONLY after the database confirmed (or rejected) its save:
//   seen[jobId]: "pending" (save in progress) | "card" (saved from the list card only) | "detail" (saved with full
//   details) | "partial" (saved from the open job, but a core field was missing) | "failed" (rejected by the database)
//   | "skipped" (unusable record).
// dbStatus[jobId]: what the database already held when the job was first listed ("full" | "card"), so jobs saved in
// earlier sessions are not suggested again.
const outcomeOf = (r) => (!hasDetails(r) ? "card" : r.extractionStatus === "partial" ? "partial" : "detail");

// Per visible card: "full" | "partial" | "failed" | "saving" | "next" | undefined. The first job that still needs its
// full details is "next"; the user opens it, nothing is clicked for them. Card-only rows still need details.
export function cardMarks(st) {
  const ids = (st && Array.isArray(st.pageIds) && st.pageIds) || [];
  const seen = (st && st.seen) || {};
  const db = (st && st.dbStatus) || {};
  const marks = {};
  let next = null;
  for (const id of ids) {
    const s = seen[id];
    let m;
    const j = (st && st.jobs && st.jobs[id]) || null;
    if (s === "detail" || (!s && db[id] === "full")) m = "full";
    else if (s === "partial") m = "partial";
    else if (s === "failed" || s === "skipped") m = "failed";
    else if (s === "pending") m = j && j.save === "failed" ? "failed" : "saving"; // retries ran out: not "Saving..." any more
    else if (s === "card" || db[id] === "card") m = "card";
    // The open job's details could not be read (not just "still loading"): shown as Failed until they are.
    if ((m === undefined || m === "card") && j && j.det === "unreadable" && !s) m = "failed";
    if (!next && (m === undefined || m === "card")) { next = id; m = "next"; }
    if (m) marks[id] = m === "card" ? "partial" : m;
  }
  return { marks, next };
}
const RETRYABLE = new Set(["NETWORK", "RATE_LIMITED", "AUTH_REQUIRED"]);
const TRANSIENT = new Set([...RETRYABLE, "read-failed"]);

// ---- Per-job tracking record: st.jobs[jobId] ----------------------------------------------------------------------
//   t, c     title, company (as listed or as read from the open job)
//   det      detail extraction: "none" | "loading" | "unreadable" | "full" | "partial"
//   save     database save:     "none" | "saving" | "retry" (waiting to retry) | "saved" | "failed"
//   out      outcome after the database answered: null | "full" | "partial" | "card" | "skipped" | "failed"
//   dup      did this save update a row that already existed? null = unknown
//   tries    saves attempted for this job; at = when the last attempt ended
//   err      last processing error: { stage: "detail" | "save", code, message } | null
// "saved" is only ever set after the database confirmed the save.
const OUT_RANK = { failed: 0, skipped: 0, card: 1, partial: 2, full: 3 };
const DETAIL_REASON_TEXT = {
  "description-not-loaded": "the job's description has not loaded",
  "description-empty": "the job's description is empty",
  "panel-loading-id-mismatch": "the panel was still switching between jobs",
  "page-id-mismatch": "the panel shows a different job than the selected one",
  "ambiguous-detail-root": "several job panels on the page, none matches the selected job",
  "no-job-id": "the open job has no readable job ID",
  "unsupported-layout": "not a LinkedIn jobs page",
};
function jobRec(st, id) {
  st.jobs = st.jobs || {};
  return (st.jobs[id] = st.jobs[id] || { t: "", c: "", det: "none", save: "none", out: null, dup: null, tries: 0, at: 0, err: null });
}
function trimMap(map, max) {
  const keys = Object.keys(map);
  if (keys.length > max) for (const k of keys.slice(0, keys.length - max)) delete map[k];
}
const clip = (v, n) => String(v == null ? "" : v).slice(0, n);

export function createWatchSession({
  store, // { get(): Promise<state|null>, set(state): Promise<void> }
  pullSnapshot, // (tabId) => Promise<{ ok, cards, detail }>  -- reads the user's page via our content script
  save, // (jobs) => Promise<{ inserted, duplicates, rejected }>  -- throws a DbError-like { code, message }
  now = Date.now,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (h) => clearTimeout(h),
  newId = () => `watch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
  checkTab = async () => true, // (tabId) => is it a LinkedIn tab?
  lookup = null, // (jobIds) => Promise<{ [jobId]: "full" | "card" }>  -- what the database already holds (optional)
  limits = WATCH_LIMITS,
} = {}) {
  let chain = Promise.resolve();
  function mutate(fn) {
    const p = chain.then(async () => {
      const cur = await store.get();
      const next = fn(cur ? structuredClone(cur) : null);
      if (next) {
        next.updatedAt = now();
        next.rev = ((cur && cur.rev) || 0) + 1; // rev orders updates for the popup
        // Per-card marks are computed on demand for the popup (summarizeWatch); nothing is drawn on LinkedIn's page,
        // so they are not stored. Drop copies left by older versions.
        delete next.marks;
        delete next.nextId;
        await store.set(next);
      }
      return next;
    });
    chain = p.then(() => {}, () => {});
    return p;
  }

  let scanning = false;
  let rescan = false;
  let settleTimer = null;
  let retryTimer = null;
  let retries = 0;
  let rereadTimer = null;
  let rereads = 0;

  // watching = reacting to the page; paused = session kept (counters, records) but ignoring the page until Resume.
  const isWatching = (s, sessionId) => !!s && s.status === "watching" && (!sessionId || s.sessionId === sessionId);
  const isLive = (s, sessionId) => !!s && (s.status === "watching" || s.status === "paused") && (!sessionId || s.sessionId === sessionId);

  // ------------------------------------------------------------- one pass over the page the user is looking at
  async function scanOnce(sessionId) {
    let s = await store.get();
    if (!isWatching(s, sessionId)) return;
    await mutate((st) => (isWatching(st, sessionId) ? Object.assign(st, { current: "reading" }) : null));

    let snap;
    try {
      snap = await pullSnapshot(s.tabId);
    } catch {
      snap = null;
    }
    if (!snap || !snap.ok) {
      await mutate((st) => (isWatching(st, sessionId) ? Object.assign(st, { current: "watching", lastError: { code: "read-failed", message: "Could not read the LinkedIn tab. Keep it open and loaded (reload it if needed); saving continues on the next page you open.", at: now() } }) : null));
      return;
    }

    s = await store.get();
    if (!isWatching(s, sessionId)) return;
    // The open job is still rendering: save what is ready now (cards) and read the page again shortly for its details.
    if (!snap.detail && PANEL_LOADING.has(snap.detailReason) && rereads < limits.detailRereads && !rereadTimer) {
      rereads += 1;
      rereadTimer = schedule(() => { rereadTimer = null; scan(sessionId); }, limits.detailRereadMs);
    } else if (snap.detail) rereads = 0;
    const cards = snap.cards || [];
    const detail = snap.detail || null;
    // Only the job that is open is saved, with its full details (merged with its own card, which can fill blanks such
    // as the location). List cards are read for the checklist only and are never saved on their own, whatever an older
    // stored session (saveCards) says.
    const records = detail ? mergeById([...cards.filter((c) => c && c.jobId === detail.jobId), detail]) : [];
    // Guided checklist + open-job state (always updated, even when there is nothing to save).
    await mutate((st) => {
      if (!isWatching(st, sessionId)) return null;
      const ids = [];
      st.known = st.known || {};
      st.jobs = st.jobs || {};
      for (const c of mergeById(cards)) {
        if (ids.length < PAGE_MAX) ids.push(c.jobId);
        const j = jobRec(st, c.jobId); // one record per job ID: a card seen again never creates a second one
        j.t = clip(c.title, 120) || j.t;
        j.c = clip(c.company, 80) || j.c;
        st.known[c.jobId] = 1;
      }
      if (ids.length) st.pageIds = ids;
      if (detail && JOB_ID_RE.test(detail.jobId || "")) {
        st.known[detail.jobId] = 1;
        const j = jobRec(st, detail.jobId);
        j.t = clip(detail.title, 120) || j.t;
        j.c = clip(detail.company, 80) || j.c;
        j.det = detail.extractionStatus === "partial" ? "partial" : "full";
        if (j.err && j.err.stage === "detail") j.err = null;
      } else if (snap.detailReason && snap.detailReason !== "no-detail-panel") {
        // The job the URL selects has no readable details yet. Only the selected job (never another one) gets the status,
        // and a job already read in full is never downgraded by a later half-rendered read.
        const sel = String((snap.checks && snap.checks.pageUrlId) || "");
        if (JOB_ID_RE.test(sel)) {
          st.known[sel] = 1;
          const j = jobRec(st, sel);
          if (j.det !== "full" && j.det !== "partial") {
            if (PANEL_LOADING.has(snap.detailReason)) j.det = "loading";
            else {
              j.det = "unreadable";
              j.err = { stage: "detail", code: clip(snap.detailReason, 60), message: DETAIL_REASON_TEXT[snap.detailReason] || clip(snap.detailReason, 100) };
            }
          }
        }
      }
      trimMap(st.jobs, limits.maxJobRecords);
      st.counters.discovered = Object.keys(st.known).length;
      const done = detail ? st.seen[detail.jobId] : null;
      st.openJob = detail
        ? {
            jobId: detail.jobId, title: String(detail.title || "").slice(0, 120), company: String(detail.company || "").slice(0, 80),
            state: done === "detail" ? "full" : done === "partial" ? "partial" : done === "failed" ? "failed" : "found",
          }
        : snap.detailReason && snap.detailReason !== "no-detail-panel"
          ? (() => {
              const sel = String((snap.checks && snap.checks.pageUrlId) || "");
              const known = JOB_ID_RE.test(sel) && st.jobs ? st.jobs[sel] : null; // the selected job, named from its list card
              return { jobId: JOB_ID_RE.test(sel) ? sel : null, title: known ? known.t : "", company: known ? known.c : "", state: PANEL_LOADING.has(snap.detailReason) ? "loading" : "unreadable", reason: snap.detailReason };
            })()
          : null;
      st.forceRetry = false; // an explicit "Retry" applies to this one read
      trimMap(st.known, limits.maxSeen);
      return st;
    });
    // Jobs listed for the first time: ask the database whether they already have full details (for "Next to save").
    if (lookup) {
      const st0 = await store.get();
      const unknown = cards.map((c) => c && c.jobId).filter((id) => JOB_ID_RE.test(id || "") && !(st0.dbStatus && id in st0.dbStatus)).slice(0, PAGE_MAX);
      if (unknown.length) {
        let found = null;
        try { found = await lookup(unknown); } catch { found = null; } // a failed lookup only means fewer hints
        if (found) {
          await mutate((st) => {
            if (!isWatching(st, sessionId)) return null;
            st.dbStatus = st.dbStatus || {};
            for (const id of unknown) st.dbStatus[id] = found[id] || "none";
            const keys = Object.keys(st.dbStatus);
            if (keys.length > limits.maxSeen) for (const k of keys.slice(0, keys.length - limits.maxSeen)) delete st.dbStatus[k];
            return st;
          });
        }
      }
    }
    // Save what is new in this session, still pending (e.g. after a connection problem), now has full details where only
    // the card was saved, or is now complete where a partial detail read was saved.
    // A job the database refused is tried again only when it is READ AGAIN later (the user reopened it), a few times at most,
    // never in a tight loop.
    const retryRefused = (r) => {
      const j = (s.jobs && s.jobs[r.jobId]) || {};
      if (s.forceRetry) return hasDetails(r); // the user pressed Retry: try the job on screen again now, whatever the back-off
      return hasDetails(r) && (j.tries || 0) < limits.maxTries && now() - (j.at || 0) >= limits.retryFailedAfterMs;
    };
    const fresh = records.filter((r) => {
      const prev = s.seen[r.jobId];
      return !prev || prev === "pending" || (prev === "card" && hasDetails(r)) || (prev === "partial" && outcomeOf(r) === "detail") || (prev === "failed" && retryRefused(r));
    });
    if (!fresh.length) {
      await mutate((st) => (isWatching(st, sessionId) ? Object.assign(st, { current: "watching" }) : null));
      return;
    }
    await mutate((st) => {
      if (!isWatching(st, sessionId)) return null;
      const novel = fresh.filter((r) => st.seen[r.jobId] !== "pending"); // a retry is not a new page
      if (novel.length) st.counters.pages += 1;
      for (const r of fresh) {
        if (!st.seen[r.jobId] || st.seen[r.jobId] === "failed") st.seen[r.jobId] = "pending";
        const j = jobRec(st, r.jobId);
        j.save = "saving";
        j.tries = (j.tries || 0) + 1;
        if (j.err && j.err.stage === "save") j.err = null;
      }
      if (st.openJob && fresh.some((r) => r.jobId === st.openJob.jobId)) st.openJob.state = "saving";
      st.current = "saving";
      return st;
    });

    for (let i = 0; i < fresh.length; i += limits.batchSize) {
      s = await store.get();
      if (!isWatching(s, sessionId)) return; // Stop pressed: no further batch starts
      const batch = fresh.slice(i, i + limits.batchSize);
      let result = null;
      let error = null;
      try { result = await save(batch); } catch (e) { error = e; }
      const kept = await mutate((st) => {
        if (!st || st.sessionId !== sessionId) return null; // a newer session replaced this one
        if (result) {
          st.counters.processed += batch.length;
          st.counters.saved += Number(result.inserted) || 0;
          st.counters.duplicates += Number(result.duplicates) || 0;
          st.counters.skipped += (result.rejected || []).length;
          // Confirmed by the database: count what was stored without complete details.
          const rejected = new Set((result.rejected || []).map((x) => x && x.jobId));
          st.counters.partial = (st.counters.partial || 0) + batch.filter((r) => !rejected.has(r.jobId) && isPartial(r)).length;
          st.counters.full = (st.counters.full || 0) + batch.filter((r) => !rejected.has(r.jobId) && outcomeOf(r) === "detail").length;
          const reasons = new Map((result.rejected || []).map((x) => [x && x.jobId, x && x.reason]));
          const accepted = batch.filter((r) => !rejected.has(r.jobId)).length;
          const allExisting = accepted > 0 && (Number(result.duplicates) || 0) >= accepted;
          const allNew = accepted > 0 && (Number(result.inserted) || 0) >= accepted;
          for (const r of batch) {
            const j = jobRec(st, r.jobId);
            const before = j.out;
            j.at = now();
            if (rejected.has(r.jobId)) {
              j.save = "none"; j.out = "skipped";
              j.err = { stage: "save", code: clip(reasons.get(r.jobId) || "rejected", 60), message: `Not saved: ${clip(reasons.get(r.jobId) || "no usable fields", 100)}` };
              continue;
            }
            const out = { detail: "full", partial: "partial", card: "card" }[outcomeOf(r)];
            const priorRow = before != null && before !== "failed" && before !== "skipped";
            j.dup = allExisting ? true : allNew ? false : priorRow || (st.dbStatus && (st.dbStatus[r.jobId] === "full" || st.dbStatus[r.jobId] === "card")) ? true : null;
            j.save = "saved";
            if (!priorRow || OUT_RANK[out] >= OUT_RANK[before]) j.out = out; // a weaker later result never lowers what was saved
            j.err = null;
          }
          for (const r of batch) st.seen[r.jobId] = rejected.has(r.jobId) ? "skipped" : outcomeOf(r);
          const mine = st.openJob && batch.find((r) => r.jobId === st.openJob.jobId);
          if (mine) st.openJob.state = rejected.has(mine.jobId) ? "failed" : outcomeOf(mine) === "detail" ? "full" : "partial";
          if (st.lastError && TRANSIENT.has(st.lastError.code)) st.lastError = null; // a rejected batch stays reported
        } else if (error && RETRYABLE.has(error.code)) {
          // Not marked as seen: these jobs are retried automatically (and again on the next page change).
          st.lastError = { code: error.code, message: String(error.message || "Saving failed").slice(0, 300), at: now() };
          for (const r of batch) { const j = jobRec(st, r.jobId); j.save = "retry"; j.err = { stage: "save", code: clip(error.code, 60), message: clip(error.message || "Saving failed", 200) }; }
        } else {
          st.counters.processed += batch.length;
          st.counters.failed += batch.length;
          // Rejected by the database: not retried in this session, and never counted as saved.
          for (const r of batch) {
            st.seen[r.jobId] = "failed";
            const j = jobRec(st, r.jobId);
            j.save = "failed"; j.out = j.out === "full" || j.out === "partial" ? j.out : "failed"; j.at = now();
            j.err = { stage: "save", code: clip((error && error.code) || "save-failed", 60), message: clip((error && error.message) || "Saving failed", 200) };
          }
          if (st.openJob && batch.some((r) => r.jobId === st.openJob.jobId)) st.openJob.state = "failed";
          st.lastError = { code: (error && error.code) || "save-failed", message: String((error && error.message) || "Saving failed").slice(0, 300), at: now() };
        }
        trimMap(st.seen, limits.maxSeen);
        trimMap(st.jobs || {}, limits.maxJobRecords);
        return st;
      });
      if (!result && error && RETRYABLE.has(error.code)) {
        if (retries < limits.maxRetries) { retries += 1; retryTimer = schedule(() => { retryTimer = null; scan(sessionId); }, limits.retryMs); }
        else {
          // Retries ran out: say so per job instead of leaving "Saving..." (they stay pending and are tried again if read again).
          await mutate((st) => {
            if (!isWatching(st, sessionId)) return null;
            for (const r of batch) { const j = jobRec(st, r.jobId); if (j.save === "retry") { j.save = "failed"; j.at = now(); j.err = { stage: "save", code: clip(error.code, 60), message: `Gave up after ${limits.maxRetries} retries: ${clip(error.message || "connection problem", 150)}` }; } }
            return st;
          });
        }
        break;
      }
      retries = 0;
      if (!kept) return;
    }
    await mutate((st) => (isWatching(st, sessionId) ? Object.assign(st, { current: "watching" }) : null));
  }

  // Single-flight: pings that arrive during a scan cause exactly one more scan afterwards.
  async function scan(sessionId) {
    if (scanning) { rescan = true; return; }
    scanning = true;
    try {
      do { rescan = false; await scanOnce(sessionId); } while (rescan);
    } finally {
      scanning = false;
    }
  }

  // ------------------------------------------------------------- public API
  async function start({ tabId, pageUrl = "", autoClick = false, maxPages = limits.defaultMaxPages } = {}) {
    if (!Number.isInteger(tabId) || tabId < 0 || !(await checkTab(tabId))) throw new RunError("invalid-tab", "Open a LinkedIn jobs page (search results or a job), then press Start.");
    // One session at a time: a second Start (another popup, a double click) never replaces the running one.
    const existing = await store.get();
    if (isLive(existing)) throw new RunError("watch-active", existing.status === "paused" ? "Auto-save is paused. Press Resume to continue it, or Stop to end it first." : "Auto-save is already on. Press Stop first to start a new session.");
    const sessionId = newId();
    if (retryTimer) cancel(retryTimer);
    retries = 0;
    await mutate(() => ({
      v: 1, sessionId, tabId, status: "watching", current: "watching", startedAt: now(), stoppedAt: null, endReason: null,
      pageUrl: typeof pageUrl === "string" ? pageUrl.slice(0, 500) : "",
      autoClick: autoClick === true,
      pilot: autoClick === true ? { maxPages: clampPages(maxPages), pages: 1, clicked: 0, finishReason: null } : null,
      counters: { pages: 0, discovered: 0, processed: 0, saved: 0, duplicates: 0, full: 0, skipped: 0, partial: 0, failed: 0 },
      seen: {}, known: {}, pageIds: [], jobs: {}, dbStatus: {}, openJob: null, lastError: null,
    }));
    scan(sessionId); // save what is on screen right now
    return getState();
  }

  async function stop(sessionId, endReason = "stopped") {
    if (settleTimer) { cancel(settleTimer); settleTimer = null; }
    if (retryTimer) { cancel(retryTimer); retryTimer = null; }
    if (rereadTimer) { cancel(rereadTimer); rereadTimer = null; }
    const s = await store.get();
    if (!s) throw new RunError("no-session", "Auto-save is not running.");
    if (sessionId && s.sessionId !== sessionId) throw new RunError("stale-session", "That auto-save session has already been replaced by a newer one.");
    await mutate((st) => (st && (st.status === "watching" || st.status === "paused") ? Object.assign(st, { status: "stopped", current: "stopped", stoppedAt: now(), endReason }) : null));
    return getState();
  }

  // Pause: keep the session (counters, records), stop reacting to the page. A save already in progress finishes; nothing new starts.
  async function pause(sessionId) {
    const s = await store.get();
    if (!s) throw new RunError("no-session", "Auto-save is not running.");
    if (sessionId && s.sessionId !== sessionId) throw new RunError("stale-session", "That auto-save session has already been replaced by a newer one.");
    if (s.status === "paused") return getState();
    if (s.status !== "watching") throw new RunError("invalid-state", `Auto-save is ${s.status}; it cannot be paused.`);
    if (settleTimer) { cancel(settleTimer); settleTimer = null; }
    if (retryTimer) { cancel(retryTimer); retryTimer = null; }
    if (rereadTimer) { cancel(rereadTimer); rereadTimer = null; }
    await mutate((st) => (st && st.status === "watching" ? Object.assign(st, { status: "paused", current: "paused", pausedAt: now() }) : null));
    return getState();
  }

  // Resume: react to the page again, starting with whatever is on screen now.
  async function resume(sessionId) {
    const s = await store.get();
    if (!s) throw new RunError("no-session", "Auto-save is not running.");
    if (sessionId && s.sessionId !== sessionId) throw new RunError("stale-session", "That auto-save session has already been replaced by a newer one.");
    if (s.status === "watching") return getState();
    if (s.status !== "paused") throw new RunError("invalid-state", `Auto-save is ${s.status}; it cannot be resumed. Press Start for a new session.`);
    retries = 0;
    rereads = 0;
    await mutate((st) => (st && st.status === "paused" ? Object.assign(st, { status: "watching", current: "watching", pausedAt: null }) : null));
    scan(s.sessionId);
    return getState();
  }

  // Retry: read the page again right now and try the job on screen again, whatever back-off or attempt limit applied.
  async function retry(sessionId) {
    const s = await store.get();
    if (!s) throw new RunError("no-session", "Auto-save is not running.");
    if (sessionId && s.sessionId !== sessionId) throw new RunError("stale-session", "That auto-save session has already been replaced by a newer one.");
    if (s.status !== "watching") throw new RunError("invalid-state", s.status === "paused" ? "Auto-save is paused. Press Resume first." : "Auto-save is not running.");
    if (settleTimer) { cancel(settleTimer); settleTimer = null; }
    if (retryTimer) { cancel(retryTimer); retryTimer = null; }
    retries = 0;
    rereads = 0;
    await mutate((st) => (isWatching(st, s.sessionId) ? Object.assign(st, { forceRetry: true, lastError: null }) : null));
    scan(s.sessionId);
    return getState();
  }

  // The content script in tab `tabId` says the page changed. Only the watched tab counts.
  async function pageChanged(tabId, { ready = false } = {}) {
    const s = await store.get();
    if (!isWatching(s) || s.tabId !== tabId) return false;
    if (settleTimer) cancel(settleTimer);
    rereads = 0; // a new page: the panel gets its own re-reads
    settleTimer = schedule(() => { settleTimer = null; scan(s.sessionId); }, ready ? limits.readySettleMs ?? 100 : limits.settleMs);
    return true;
  }

  // Switch auto-click on or off for the running (or paused) session; its counters are kept, the page limit is updated.
  async function setAutoClick(sessionId, { autoClick = false, maxPages } = {}) {
    const s = await store.get();
    if (!s) throw new RunError("no-session", "Auto-save is not running.");
    if (sessionId && s.sessionId !== sessionId) throw new RunError("stale-session", "That auto-save session has already been replaced by a newer one.");
    if (!isLive(s)) throw new RunError("invalid-state", "Auto-save is not running. Press Start.");
    await mutate((st) => {
      if (!isLive(st, s.sessionId)) return null;
      st.autoClick = autoClick === true;
      const p = st.pilot || { pages: 1, clicked: 0, finishReason: null };
      st.pilot = { ...p, maxPages: maxPages === undefined && st.pilot ? st.pilot.maxPages : clampPages(maxPages) };
      return st;
    });
    return getState();
  }

  // Auto-click progress from the content script in tab `tabId`. Only the watched tab of a session started with auto-click
  // is answered with { pilot: true }; "hello" lets that tab's content script know it is the one that clicks.
  async function pilotEvent(tabId, { event = "", reason = "" } = {}) {
    const s = await store.get();
    if (!isLive(s) || s.tabId !== tabId || s.autoClick !== true) return { pilot: false };
    if (event === "hello" || s.status !== "watching") return { pilot: true }; // paused: nothing is counted
    if (event === "clicked" || event === "page") {
      await mutate((st) => {
        if (!isWatching(st, s.sessionId)) return null;
        st.pilot = { maxPages: limits.defaultMaxPages, pages: 1, clicked: 0, finishReason: null, ...st.pilot };
        if (event === "clicked") st.pilot.clicked += 1;
        else st.pilot.pages += 1;
        return st;
      });
    } else if (event === "finished") {
      await mutate((st) => {
        if (!isWatching(st, s.sessionId)) return null;
        st.pilot = { ...st.pilot, finishReason: PILOT_FINISH_REASONS.includes(reason) ? reason : "no-more-pages" };
        return st;
      });
      await stop(s.sessionId, "auto-finished"); // a save already in flight still records its result (see scanOnce)
    }
    return { pilot: true };
  }

  async function tabClosed(tabId) {
    const s = await store.get();
    if (isLive(s) && s.tabId === tabId) await stop(s.sessionId, "tab-closed");
  }

  // Browser restart (tab ids change) or extension reload (the page's content script is disconnected): end the session.
  // Plain worker wake-up: keep watching; a scan cut short by the worker sleeping is simply redone on the next ping.
  async function recover(reason) {
    const s = await store.get();
    if (!isLive(s)) return;
    if (reason === "browser-start" || reason === "extension-reload") await stop(s.sessionId, reason === "browser-start" ? "browser-restarted" : "extension-reloaded");
    else if (s.status === "watching" && s.current !== "watching") await mutate((st) => (isWatching(st, s.sessionId) ? Object.assign(st, { current: "watching" }) : null));
  }

  const getState = async () => summarizeWatch(await store.get());

  // True while a scan runs or one is scheduled (settle wait / retry). For tests and diagnostics.
  const isBusy = () => scanning || settleTimer !== null || retryTimer !== null || rereadTimer !== null;

  const clampPages = (n) => (Number.isInteger(n) ? Math.min(Math.max(n, 1), limits.maxMaxPages ?? 100) : limits.defaultMaxPages ?? 5);

  return { start, stop, pause, resume, retry, pageChanged, setAutoClick, pilotEvent, tabClosed, recover, getState, isBusy };
}

// Popup-facing view of the stored state: internal id maps are dropped; the guided checklist is computed.
//   page.visible   jobs listed on the page last read
//   page.full      of those, saved with full details in this session
//   page.next      the first listed job not yet saved with details (the user opens it; nothing is clicked for them)
export function summarizeWatch(s) {
  if (!s || typeof s !== "object") return null;
  const { seen, known, pageIds, pageInfo: _legacy, jobs, dbStatus, marks: _m, nextId: _n, ...rest } = s;
  const ids = Array.isArray(pageIds) ? pageIds : [];
  const { marks, next: nextId } = cardMarks(s);
  const full = ids.filter((id) => marks[id] === "full").length;
  const rec = jobs || {};
  const info = (nextId && rec[nextId]) || {};
  // One row per job listed on the page last read, in list order, with its tracking state.
  const rows = ids.map((id) => {
    const j = rec[id] || {};
    return { jobId: id, title: j.t || "", company: j.c || "", mark: marks[id] || null, det: j.det || "none", save: j.save || "none", outcome: j.out || null, dup: j.dup === undefined ? null : j.dup, error: j.err ? j.err.message : null, isNext: id === nextId };
  });
  return {
    ...rest,
    counters: { partial: 0, full: 0, ...s.counters },
    seenCount: Object.keys(seen || {}).length,
    page: { visible: ids.length, full, remaining: ids.length - full, next: nextId ? { jobId: nextId, title: info.t || "", company: info.c || "" } : null, jobs: rows },
    trackedJobs: Object.keys(rec).length,
  };
}

export function createChromeWatchStore(area = chrome.storage.local) {
  return {
    async get() { const r = await area.get(WATCH_KEY); return r[WATCH_KEY] || null; },
    async set(state) { await area.set({ [WATCH_KEY]: state }); },
  };
}

export function createMemoryWatchStore(initial = null) {
  let v = initial ? structuredClone(initial) : null;
  return { async get() { return v ? structuredClone(v) : null; }, async set(s) { v = structuredClone(s); } };
}
