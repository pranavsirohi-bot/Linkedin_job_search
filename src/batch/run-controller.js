// Batch run controller: a persistent, resumable state machine that lives in the service worker.
//
// Design rules
//  * The ONLY source of truth is the store (chrome.storage.local). Nothing important lives in popup or worker memory.
//  * A "safe unit of work" is one source page or one batch of detail fetches. After every unit the progress
//    (cursor, pending references, counters) is checkpointed, so an interruption loses at most one unit.
//  * Replay is safe: saving goes through the idempotent upsert, so re-processing a unit never duplicates jobs.
//  * Pause stops after the current unit. Stop cancels the in-flight request, never discards saved jobs.
//  * Control state changes are serialised through one queue so a Pause can never be overwritten by a checkpoint.
import { DbError, ERR } from "../db/errors.js";
import { EXTERNAL_ID_RE } from "../db/job-mapper.js";
import { SourceError } from "../sources/http.js";
import { computeDelay } from "./backoff.js";
import { ACTIVE_STATUSES, HARD_LIMITS, RunError, STATUS, TERMINAL_STATUSES, newRunState, summarize, validateLimits } from "./run-state.js";

class Aborted extends Error {} // the user stopped the run
class PauseNow extends Error {} // pause requested while waiting between retries
class Deferred extends Error { // a long wait was handed to chrome.alarms; the driver exits and wake() resumes it
  constructor(ms) { super("deferred"); this.ms = ms; }
}

const defaultId = () => `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyOf = (cursor) => JSON.stringify(cursor ?? null);
const describe = (e) => String((e && e.message) || e || "Unknown error").slice(0, 300);

function isRetryable(e) {
  if (e instanceof SourceError) return e.kind === "transient" || e.kind === "rate-limited";
  if (e instanceof DbError) return e.code === ERR.NETWORK || e.code === ERR.RATE_LIMITED;
  return false;
}

export function createRunController({
  store, sources, save, preflight, alarms, now = Date.now, random = Math.random, newId = defaultId,
  sleep = defaultSleep, paceMs = HARD_LIMITS.paceMs, log = () => {},
}) {
  // ------------------------------------------------------------- serialised state mutation
  let chain = Promise.resolve();
  function mutate(fn) {
    const p = chain.then(async () => {
      const current = await store.load();
      const next = await fn(current ? structuredClone(current) : null);
      if (next) {
        next.updatedAt = now();
        await store.save(next);
      }
      return next;
    });
    chain = p.then(() => {}, () => {});
    return p;
  }

  // ------------------------------------------------------------- in-memory control (mirrors persisted flags)
  const flags = { pause: false, stop: false };
  const waiters = new Set();
  let driver = null;
  let abortCtl = null;

  const wakeWaiters = () => { for (const w of [...waiters]) w(); waiters.clear(); };
  async function interruptibleWait(ms) {
    if (ms <= 0) return;
    let release;
    const interrupted = new Promise((r) => { release = r; waiters.add(r); });
    await Promise.race([sleep(ms), interrupted]);
    waiters.delete(release);
  }

  // ------------------------------------------------------------- finishing helpers
  async function finish(status, { endReason = null, error = null } = {}) {
    await mutate((s) => {
      if (!s || TERMINAL_STATUSES.has(s.status)) return null;
      s.status = status;
      s.finishedAt = now();
      s.endReason = endReason;
      if (error) s.lastError = { code: error.code || "error", message: describe(error), at: now() };
      s.pauseRequested = false;
      s.stopRequested = false;
      s.pausedReason = null;
      s.retry = null;
      s.waiting = null;
      s.pending = []; // nothing more will be processed; saved jobs are unaffected
      return s;
    });
    await store.clearPayload();
    if (alarms) await alarms.cancel();
  }

  async function pauseRun(reason, error = null) {
    await mutate((s) => {
      if (!s || s.status !== STATUS.RUNNING) return null;
      s.status = STATUS.PAUSED;
      s.pauseRequested = false;
      s.pausedReason = reason;
      s.waiting = null;
      if (error) s.lastError = { code: error.code || (error.kind || "error"), message: describe(error), at: now() };
      return s;
    });
    flags.pause = false;
  }

  async function scheduleWake(ms) {
    await mutate((s) => {
      if (!s || s.status !== STATUS.RUNNING) return null;
      s.waiting = { until: now() + ms };
      return s;
    });
    if (alarms) await alarms.schedule(ms);
  }

  // ------------------------------------------------------------- retrying one operation
  // Retries transient/rate-limited failures with bounded exponential backoff + jitter, honouring Retry-After.
  // Attempts are persisted so backoff progress survives a worker restart. Long waits become alarms (Deferred).
  //   saving: true  the operation is persisting finished work, so a Stop request does not skip it. (If it fails
  //                 while stopping it is not retried: Stop stays responsive.)
  async function attempt(key, op, { saving = false } = {}) {
    const s0 = await store.load();
    let n = s0 && s0.retry && s0.retry.key === key ? s0.retry.attempt : 0;
    for (;;) {
      if (flags.stop && !saving) throw new Aborted();
      try {
        const out = await op();
        if (n > 0) await mutate((s) => { if (!s || !s.retry) return null; s.retry = null; return s; });
        return out;
      } catch (e) {
        if (e instanceof Aborted || e instanceof Deferred || e instanceof PauseNow) throw e;
        if ((e instanceof SourceError && e.kind === "aborted") || flags.stop) throw new Aborted();
        if (!isRetryable(e)) throw e;
        n += 1;
        if (n > HARD_LIMITS.maxRetries) { e.retriesExhausted = true; throw e; }
        const delay = computeDelay(n, { retryAfterMs: e.retryAfterMs ?? null }, random);
        const reason = describe(e);
        await mutate((s) => { if (!s) return null; s.retry = { key, attempt: n, until: now() + delay, reason }; return s; });
        log("retry", { key, n, delay });
        if (delay > HARD_LIMITS.inlineWaitMs && alarms) throw new Deferred(delay);
        await interruptibleWait(delay);
        if (flags.stop) throw new Aborted();
        if (flags.pause) throw new PauseNow();
      }
    }
  }

  // ------------------------------------------------------------- one page of references
  async function fetchPage(s, source, params, signal) {
    const cursorKey = keyOf(s.cursor);
    if (s.seenCursors.includes(cursorKey)) throw new RunError("repeated-cursor", "The source asked for a page that was already processed.");
    const res = await attempt(`page:${cursorKey}`, () => source.search(params, s.cursor, { pageSize: s.config.pageSize, signal }));

    if (!res || typeof res !== "object" || !Array.isArray(res.refs)) throw new SourceError("malformed", "The source returned an unexpected page shape");
    if (res.refs.length > s.config.pageSize) throw new SourceError("malformed", "The source returned more results than requested");
    const next = res.nextCursor === undefined ? null : res.nextCursor;
    let nextKey = null;
    if (next !== null) {
      try { nextKey = keyOf(next); } catch { throw new SourceError("malformed", "The source returned a cursor that cannot be stored"); }
      if (nextKey.length > 1000) throw new SourceError("malformed", "The source returned an oversized cursor");
    }

    await mutate((st) => {
      if (!st || st.status !== STATUS.RUNNING) return null;
      const known = new Set(st.seen);
      const accepted = [];
      let duplicates = 0;
      let invalid = 0;
      for (const ref of res.refs) {
        if (!ref || typeof ref !== "object" || typeof ref.externalId !== "string" || !EXTERNAL_ID_RE.test(ref.externalId)) { invalid++; continue; }
        if (known.has(ref.externalId)) { duplicates++; continue; }
        known.add(ref.externalId);
        accepted.push(ref);
      }
      const room = Math.max(0, st.config.maxJobs - st.counters.discovered);
      const taken = accepted.slice(0, room);
      const overCap = accepted.length - taken.length;

      st.pending.push(...taken);
      st.seen.push(...taken.map((r) => r.externalId));
      st.counters.discovered += taken.length;
      st.counters.duplicates += duplicates;
      st.counters.skipped += invalid;
      st.page += 1;
      st.seenCursors.push(cursorKey);
      if (st.seenCursors.length > HARD_LIMITS.maxSeenCursors) st.seenCursors.shift();
      st.emptyPages = res.refs.length === 0 ? st.emptyPages + 1 : 0;
      st.cursor = next;
      // Human-readable position for the UI (e.g. 'board "figma", from job 26'); sources may describe their cursor.
      try {
        st.positionLabel = next === null ? "end of results" : String((source.describeCursor && source.describeCursor(next, params)) || nextKey).slice(0, 120);
      } catch { st.positionLabel = String(nextKey).slice(0, 120); }
      st.consecutiveFailures = 0;
      for (const w of res.warnings || []) if (st.warnings.length < HARD_LIMITS.maxWarnings) st.warnings.push(String(w).slice(0, 200));
      if (invalid) st.warnings.push(`${invalid} result(s) without a valid id were skipped.`);

      // Job cap. Only report "more available" when the source really had more (left-over results or a next page);
      // a source that ends exactly at the cap finished normally.
      if (overCap > 0 || (st.counters.discovered >= st.config.maxJobs && next !== null)) { st.exhausted = true; st.capReached = "jobs"; st.moreAvailable = true; }
      else if (st.counters.discovered >= st.config.maxJobs) st.exhausted = true;
      else if (next === null) st.exhausted = true;
      else if (nextKey === cursorKey || st.seenCursors.includes(nextKey)) {
        // The source is looping. Keep this page's results, stop paging, and report it loudly at the end.
        st.exhausted = true;
        st.loopError = { code: "repeated-cursor", message: "The source returned a page cursor it had already returned, so paging was stopped to avoid a loop." };
      } else if (st.emptyPages >= HARD_LIMITS.maxEmptyPages) { st.exhausted = true; st.endReason = "too-many-empty-pages"; }
      return st;
    });
  }

  // ------------------------------------------------------------- one batch of details + incremental save
  async function processBatch(s, source, params, signal) {
    const batch = s.pending.slice(0, s.config.detailBatch);
    const outcomes = []; // { ref, kind: "ok" | "skipped" | "failed", reason }
    const records = [];
    let deferred = null;
    let aborted = false;
    let consec = s.consecutiveFailures; // failures in a row, in processing order

    for (const ref of batch) {
      if (flags.stop) { aborted = true; break; }
      if (flags.pause) break;
      if (consec >= HARD_LIMITS.maxConsecutiveFailures) break; // too many in a row: stop here, the rest stay queued
      try {
        const raw = await attempt(`item:${ref.externalId}`, () => source.getDetails(ref, { params, signal }));
        if (raw == null) { outcomes.push({ ref, kind: "skipped", reason: "no details available" }); continue; }
        let rec = null;
        try { rec = source.normalize(raw, ref); } catch { rec = null; }
        if (!rec) { outcomes.push({ ref, kind: "failed", reason: "the job record was malformed" }); consec += 1; continue; }
        records.push(rec);
        outcomes.push({ ref, kind: "ok" });
        consec = 0;
      } catch (e) {
        if (e instanceof Aborted) { aborted = true; break; }
        if (e instanceof Deferred) { deferred = e; break; }
        if (e instanceof PauseNow) break;
        if (e instanceof SourceError && e.kind === "not-found") { outcomes.push({ ref, kind: "skipped", reason: "the job is no longer available" }); continue; }
        outcomes.push({ ref, kind: "failed", reason: describe(e) });
        consec += 1;
      }
    }

    // Save what we have BEFORE exiting for a pause/stop/deferral, so completed work is never held back.
    let saved = null;
    let saveError = null;
    if (records.length) {
      try {
        saved = await attempt(`save:${s.runId}:${s.counters.processed}`, () => save(records), { saving: true });
      } catch (e) {
        if (e instanceof Deferred) deferred = deferred || e;
        else if (!(e instanceof Aborted) && !(e instanceof PauseNow)) saveError = e;
      }
    }
    const saveRetryable = saveError && (saveError.retriesExhausted || isRetryable(saveError));
    const saveBlocked = !!(saveError && (saveRetryable || saveError.code === ERR.AUTH_REQUIRED || saveError.code === ERR.NOT_CONFIGURED));
    const saveFailedItems = !!(saveError && !saveBlocked); // e.g. a validation error: retrying cannot help
    const unsaved = !saved && records.length > 0; // saving did not complete: leave those references pending

    await mutate((st) => {
      if (!st) return null;
      const done = new Set();
      let failedNow = 0;
      for (const o of outcomes) {
        if (o.kind === "ok") {
          if (saved) done.add(o.ref.externalId);
          else if (saveFailedItems) { done.add(o.ref.externalId); st.counters.failed++; failedNow++; pushFailure(st, o.ref, describe(saveError)); }
        } else {
          done.add(o.ref.externalId);
          if (o.kind === "skipped") st.counters.skipped++;
          else { st.counters.failed++; failedNow++; pushFailure(st, o.ref, o.reason); }
        }
      }
      st.pending = st.pending.filter((r) => !done.has(r.externalId));
      st.counters.processed += done.size;
      if (saved) {
        st.counters.saved += Number(saved.inserted) || 0;
        st.counters.duplicates += Number(saved.duplicates) || 0;
        st.counters.skipped += (saved.rejected || []).length;
        for (const r of saved.rejected || []) pushFailure(st, { externalId: String(r.jobId || "?") }, `rejected: ${r.reason}`, false);
      }
      // Failures in a row, evaluated in processing order: a success resets the streak, a failure extends it.
      let streak = st.consecutiveFailures;
      for (const o of outcomes) {
        if (o.kind === "failed") streak += 1;
        else if (o.kind === "ok") {
          if (saved) streak = 0;
          else if (saveFailedItems) streak += 1;
        }
      }
      st.consecutiveFailures = streak + (unsaved && saveBlocked ? 1 : 0);

      if (saveBlocked && st.status === STATUS.RUNNING) {
        st.status = STATUS.PAUSED;
        st.pausedReason = saveError.code === ERR.AUTH_REQUIRED || saveError.code === ERR.NOT_CONFIGURED ? "save-blocked" : "save-failed";
        st.lastError = { code: saveError.code || "save-failed", message: describe(saveError), at: now() };
      } else if (st.consecutiveFailures >= HARD_LIMITS.maxConsecutiveFailures && st.status === STATUS.RUNNING) {
        st.status = STATUS.PAUSED;
        st.pausedReason = "too-many-failures";
        st.lastError = { code: "too-many-failures", message: `Paused after ${st.consecutiveFailures} failures in a row. Last: ${st.failures.length ? st.failures[st.failures.length - 1].reason : "unknown"}`, at: now() };
      } else if (failedNow && st.failures.length) {
        st.lastError = { code: "item-failed", message: st.failures[st.failures.length - 1].reason, at: now() };
      }
      return st;
    });

    if (aborted) throw new Aborted();
    if (deferred) throw deferred;
  }

  function pushFailure(st, ref, reason, count = true) { // eslint-disable-line no-unused-vars
    st.failures.push({ externalId: ref.externalId, reason: String(reason).slice(0, 200), at: now() });
    if (st.failures.length > HARD_LIMITS.maxStoredFailures) st.failures.shift();
  }

  // ------------------------------------------------------------- the driver loop
  function decideDone(s) {
    if (s.pending.length) return null;
    if (s.loopError) return { status: STATUS.FAILED, endReason: "repeated-cursor", error: s.loopError };
    if (s.exhausted) return { status: STATUS.COMPLETED, endReason: s.capReached === "jobs" ? "job-limit" : s.endReason || "no-more-results" };
    if (s.page >= s.config.maxPages) return { status: STATUS.COMPLETED, endReason: "page-limit", cap: "pages" };
    return null;
  }

  async function drive(signal) {
    const first = await store.load();
    if (!first || first.status !== STATUS.RUNNING) return;
    const source = sources.get(first.sourceId);
    if (!source) { await finish(STATUS.FAILED, { endReason: "unknown-source", error: { code: "unknown-source", message: `Unknown source "${first.sourceId}"` } }); return; }
    const heavy = (await store.loadPayload(first.runId)) || {};
    const params = { ...first.params, ...heavy };
    flags.pause = !!first.pauseRequested;
    flags.stop = !!first.stopRequested;

    for (;;) {
      const s = await store.load();
      if (!s || s.runId !== first.runId) return;
      if (s.status === STATUS.STOPPING || flags.stop) { await finish(STATUS.STOPPED, { endReason: "stopped" }); return; }
      if (s.status !== STATUS.RUNNING) return; // paused (user or automatic), interrupted, or finished
      if (flags.pause || s.pauseRequested) { await pauseRun("user"); return; }

      const done = decideDone(s);
      if (done) {
        // Page cap with a next cursor still pending: the source has more; the run must not read as "all done".
        if (done.cap) await mutate((st) => { if (st) { st.capReached = done.cap; st.moreAvailable = st.cursor !== null; } return st; });
        await finish(done.status, { endReason: done.endReason, error: done.error });
        return;
      }

      try {
        if (s.pending.length) await processBatch(s, source, params, signal);
        else await fetchPage(s, source, params, signal);
      } catch (e) {
        if (e instanceof Deferred) { await scheduleWake(e.ms); return; }
        if (e instanceof Aborted) continue; // the loop head handles the stop
        if (e instanceof PauseNow) { await pauseRun("user"); return; }
        // A source may report that its page cursor expired. Restart paging from the first page once; jobs already
        // collected are skipped as duplicates and the page cap still bounds the run. A second expiry fails the run.
        if (e instanceof SourceError && e.kind === "cursor-expired" && !s.cursorRestarted) {
          await mutate((st) => {
            if (!st || st.status !== STATUS.RUNNING) return null;
            st.cursor = null;
            st.seenCursors = [];
            st.cursorRestarted = true;
            st.retry = null;
            if (st.warnings.length < HARD_LIMITS.maxWarnings) st.warnings.push("The source's page cursor expired, so paging restarted from the first page (jobs already collected are skipped).");
            return st;
          });
          continue;
        }
        if (e && e.retriesExhausted) { await pauseRun("source-unreachable", { code: "retries-exhausted", message: `Gave up after ${HARD_LIMITS.maxRetries} retries: ${describe(e)}` }); return; }
        log("step failed", describe(e));
        await finish(STATUS.FAILED, { endReason: "error", error: { code: (e && (e.code || e.kind)) || "error", message: describe(e) } });
        return;
      }
      await interruptibleWait(paceMs);
    }
  }

  function ensureDriver() {
    if (driver) return driver;
    abortCtl = new AbortController();
    const signal = abortCtl.signal;
    driver = drive(signal)
      .catch(async (e) => {
        log("driver crashed", describe(e));
        try { await finish(STATUS.FAILED, { endReason: "error", error: { code: "unexpected", message: `Unexpected error: ${describe(e)}` } }); } catch { /* storage unavailable */ }
      })
      .finally(() => {
        driver = null;
        abortCtl = null;
        // A resume may have arrived while the previous loop was winding down: don't leave a RUNNING run without a driver.
        store.load().then((s) => { if (s && s.status === STATUS.RUNNING && !s.waiting && !driver) ensureDriver(); }).catch(() => {});
      });
    return driver;
  }

  // ------------------------------------------------------------- public API
  async function start({ sourceId, params, limits } = {}) {
    const source = sources.get(sourceId);
    if (!source) throw new RunError("unknown-source", "Choose a job source.");
    const lim = validateLimits(limits || {});
    if (!lim.ok) throw new RunError("invalid-limits", lim.errors.join(" "));
    const v = source.validateParams(params || {}, { maxJobs: lim.limits.maxJobs });
    if (!v.ok) throw new RunError("invalid-params", v.errors.join(" "));
    if (preflight) await preflight();

    const light = { ...v.params };
    const heavy = {};
    for (const k of source.heavyParams) { heavy[k] = light[k]; delete light[k]; }
    const runId = newId();
    const state = newRunState({ runId, now: now(), sourceId, params: light, limits: lim.limits });
    // A source may ask for smaller save batches (faster progress); never larger than the hard limit.
    if (Number.isInteger(source.detailBatch) && source.detailBatch >= 1) state.config.detailBatch = Math.min(source.detailBatch, HARD_LIMITS.detailBatch);

    await mutate((cur) => {
      // A leftover run from a source that is no longer enabled (e.g. an older version's batch run) cannot continue,
      // so it never blocks a new run. Its saved jobs are unaffected.
      if (cur && ACTIVE_STATUSES.has(cur.status) && sources.get(cur.sourceId)) throw new RunError("run-active", "A run is already in progress. Stop it first.");
      return state;
    });
    try {
      if (Object.keys(heavy).length) await store.savePayload(runId, heavy);
      else await store.clearPayload();
    } catch (e) {
      await mutate(() => null);
      await store.clear();
      throw new RunError("storage-full", `The run's data could not be stored: ${describe(e)}`);
    }
    flags.pause = false;
    flags.stop = false;
    ensureDriver();
    return summarize(await store.load());
  }

  async function pause() {
    const s = await store.load();
    if (!s) throw new RunError("no-run", "There is no run.");
    if (s.status === STATUS.PAUSED) return summarize(s);
    if (s.status !== STATUS.RUNNING) throw new RunError("invalid-state", `A ${s.status} run cannot be paused.`);
    flags.pause = true;
    wakeWaiters();
    await mutate((st) => { if (!st || st.status !== STATUS.RUNNING) return null; st.pauseRequested = true; return st; });
    return summarize(await store.load());
  }

  async function resume() {
    const s = await store.load();
    if (!s) throw new RunError("no-run", "There is no run.");
    if (s.status === STATUS.RUNNING && s.pauseRequested) { // changed their mind while "pausing"
      flags.pause = false;
      await mutate((st) => { if (st) st.pauseRequested = false; return st; });
      return summarize(await store.load());
    }
    if (s.status !== STATUS.PAUSED && s.status !== STATUS.INTERRUPTED) throw new RunError("invalid-state", `A ${s.status} run cannot be resumed.`);
    flags.pause = false;
    flags.stop = false;
    await mutate((st) => {
      if (!st || (st.status !== STATUS.PAUSED && st.status !== STATUS.INTERRUPTED)) return null;
      st.status = STATUS.RUNNING;
      st.pauseRequested = false;
      st.pausedReason = null;
      st.interruptedAt = null;
      st.consecutiveFailures = 0;
      st.retry = null;
      st.waiting = null;
      st.resumeCount += 1;
      return st;
    });
    ensureDriver();
    return summarize(await store.load());
  }

  // runId (optional): the run the caller believes is current. A stale command from an older view never touches a newer run.
  async function stop(runId) {
    const s = await store.load();
    if (!s) throw new RunError("no-run", "There is no run.");
    if (runId && s.runId !== runId) throw new RunError("stale-run", "That run has already finished and a newer one is shown now.");
    if (TERMINAL_STATUSES.has(s.status) || s.status === STATUS.STOPPING) return summarize(s);
    if (s.status === STATUS.PAUSED || s.status === STATUS.INTERRUPTED) {
      await finish(STATUS.STOPPED, { endReason: "stopped" });
      return summarize(await store.load());
    }
    flags.stop = true;
    await mutate((st) => { if (!st || st.status !== STATUS.RUNNING) return null; st.status = STATUS.STOPPING; st.stopRequested = true; return st; });
    if (abortCtl) abortCtl.abort(); // cancel the in-flight request
    wakeWaiters();
    if (!driver) await finish(STATUS.STOPPED, { endReason: "stopped" });
    return summarize(await store.load());
  }

  async function dismiss(runId) {
    const s = await store.load();
    if (!s) return null;
    if (runId && s.runId !== runId) throw new RunError("stale-run", "That run has already been replaced by a newer one.");
    if (!TERMINAL_STATUSES.has(s.status)) throw new RunError("run-active", "Stop the run before dismissing it.");
    await store.clear();
    await store.clearPayload();
    return null;
  }

  async function getState() {
    return summarize(await store.load());
  }

  // Called when the worker (re)starts, the browser starts, or the extension is reloaded. A run that was RUNNING
  // with no live loop was interrupted: it is marked so and waits for the user to press Resume.
  async function recover(reason = "sw-wake") {
    const s = await store.load();
    if (!s) return null;
    // An unfinished run whose source is no longer enabled can never be resumed: close it as stopped (saved jobs stay).
    if (ACTIVE_STATUSES.has(s.status) && !sources.get(s.sourceId)) {
      await finish(STATUS.STOPPED, { endReason: "source-unavailable" });
      return getState();
    }
    if (s.status === STATUS.STOPPING) { await finish(STATUS.STOPPED, { endReason: "stopped" }); return getState(); }
    if (s.status !== STATUS.RUNNING || driver) return summarize(s);
    if (s.waiting && reason === "sw-wake") { // a long wait was scheduled with an alarm; keep it
      const remaining = s.waiting.until - now();
      if (remaining <= 0) await wake();
      else if (alarms) await alarms.schedule(remaining);
      return getState();
    }
    await mutate((st) => {
      if (!st || st.status !== STATUS.RUNNING) return null;
      st.status = STATUS.INTERRUPTED;
      st.interruptedAt = now();
      st.waiting = null;
      st.pauseRequested = false;
      return st;
    });
    return getState();
  }

  // chrome.alarms fired: continue a run that was waiting out a long delay.
  async function wake() {
    const s = await store.load();
    if (!s || s.status !== STATUS.RUNNING || driver) return;
    await mutate((st) => { if (!st || st.status !== STATUS.RUNNING) return null; st.waiting = null; return st; });
    ensureDriver();
  }

  return { start, pause, resume, stop, dismiss, getState, recover, wake, whenIdle: () => driver || Promise.resolve() };
}
