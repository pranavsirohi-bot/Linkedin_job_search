// Run state: statuses, limits, validation, the legal transitions, and the UI-safe summary. Pure functions only.

export const STATUS = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  PAUSED: "paused",
  STOPPING: "stopping",
  COMPLETED: "completed",
  STOPPED: "stopped",
  FAILED: "failed",
  INTERRUPTED: "interrupted",
});

// A run in one of these states owns the single run slot; a new run cannot start until it ends or is dismissed.
export const ACTIVE_STATUSES = new Set([STATUS.RUNNING, STATUS.PAUSED, STATUS.STOPPING, STATUS.INTERRUPTED]);
export const TERMINAL_STATUSES = new Set([STATUS.COMPLETED, STATUS.STOPPED, STATUS.FAILED]);

// Defaults for a new run, and HARD limits enforced by the controller (the UI's inputs are only a convenience).
export const DEFAULT_LIMITS = Object.freeze({ maxJobs: 200, maxPages: 10, pageSize: 25 });
export const HARD_LIMITS = Object.freeze({
  maxJobs: 500,
  maxPages: 50,
  pageSize: 50,
  detailBatch: 10, // detail fetches per saved checkpoint (a "safe unit of work")
  maxRetries: 4, // retries per operation before it counts as a failure
  maxConsecutiveFailures: 5, // then the run pauses itself
  paceMs: 400, // pause between units of work (politeness; the source's rate limit is not documented)
  inlineWaitMs: 10000, // longer waits are handed to chrome.alarms so the service worker can sleep
  maxEmptyPages: 12,
  maxStoredFailures: 50, // recent failures kept with their reason for display
  maxFailedRecords: 500, // every failed record (id + title + reason) is remembered so it can be retried
  maxResults: 500, // per-record outcome log of one run
  maxWarnings: 20,
  maxSeenCursors: 200,
});

const LEGAL = {
  [STATUS.IDLE]: [STATUS.RUNNING],
  [STATUS.RUNNING]: [STATUS.PAUSED, STATUS.STOPPING, STATUS.COMPLETED, STATUS.FAILED, STATUS.INTERRUPTED, STATUS.STOPPED],
  [STATUS.PAUSED]: [STATUS.RUNNING, STATUS.STOPPED],
  [STATUS.INTERRUPTED]: [STATUS.RUNNING, STATUS.STOPPED],
  [STATUS.STOPPING]: [STATUS.STOPPED],
  [STATUS.COMPLETED]: [STATUS.IDLE],
  [STATUS.STOPPED]: [STATUS.IDLE],
  [STATUS.FAILED]: [STATUS.IDLE],
};
export const canTransition = (from, to) => (LEGAL[from] || []).includes(to);

export class RunError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RunError";
    this.code = code;
  }
  toJSON() {
    return { code: this.code, message: this.message };
  }
}

// Validate user-supplied limits. Values above the hard limits are REJECTED (not silently clamped).
export function validateLimits(input = {}) {
  const errors = [];
  const out = {};
  for (const key of ["maxJobs", "maxPages", "pageSize"]) {
    const raw = input[key];
    if (raw === undefined || raw === null || raw === "") { out[key] = DEFAULT_LIMITS[key]; continue; }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) errors.push(`${key} must be a whole number of at least 1.`);
    else if (n > HARD_LIMITS[key]) errors.push(`${key} cannot be more than ${HARD_LIMITS[key]}.`);
    else out[key] = n;
  }
  return errors.length ? { ok: false, errors } : { ok: true, limits: out };
}

export function newRunState({ runId, now, sourceId, params, limits }) {
  return {
    v: 1,
    runId,
    status: STATUS.RUNNING,
    sourceId,
    params, // small, non-heavy params only; heavy ones (e.g. imported records) are stored separately
    config: { ...limits, detailBatch: HARD_LIMITS.detailBatch },
    createdAt: now,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    cursor: null, // opaque, source-defined; null = start of the source
    exhausted: false, // true when the source has no more pages (or a limit was reached)
    capReached: null, // "jobs" | "pages" | null
    loopError: null, // set when the source repeats a cursor; reported when the queue drains
    moreAvailable: false, // true when a limit stopped the run while the source still had results
    cursorRestarted: false, // paging was restarted once after the source reported an expired cursor
    positionLabel: "start", // human-readable position of the next page
    sourceTotal: null, // how many results the source says exist (capped at the job limit), when it says so
    partialSaved: 0, // saved records that were incomplete (e.g. an imported row without a description)
    failedRefs: [], // [{ externalId, title, reason }]: every record that failed (not the ones skipped), for "retry failed"
    results: [], // [{ id, t, o, r }]: what happened to each record. o: new | updated | saved | partial | skipped | failed
    retryOf: null, // runId of the run whose failed records this run is retrying
    page: 0, // pages fetched
    emptyPages: 0,
    pending: [], // references discovered but not yet processed
    seen: [], // external ids already discovered in this run (in-run de-duplication)
    seenCursors: [], // cursor keys already requested (loop protection)
    counters: { discovered: 0, processed: 0, saved: 0, duplicates: 0, skipped: 0, failed: 0 },
    failures: [], // last few per-item failures [{ externalId, reason, at }]
    warnings: [], // non-fatal notices from the source
    consecutiveFailures: 0,
    pauseRequested: false,
    stopRequested: false,
    retry: null, // { key, attempt, until, reason }
    waiting: null, // { until } while an alarm is pending
    lastError: null, // { code, message, at }
    pausedReason: null,
    endReason: null,
    resumeCount: 0,
    interruptedAt: null,
  };
}

// What the UI may see: counters and status, never the pending queue or heavy payloads.
export function summarize(state) {
  if (!state) return null;
  return {
    runId: state.runId,
    status: state.status,
    sourceId: state.sourceId,
    counters: { ...state.counters },
    config: { maxJobs: state.config.maxJobs, maxPages: state.config.maxPages, pageSize: state.config.pageSize },
    page: state.page,
    pendingCount: state.pending.length,
    pauseRequested: !!state.pauseRequested,
    pausedReason: state.pausedReason,
    endReason: state.endReason,
    capReached: state.capReached,
    moreAvailable: !!state.moreAvailable,
    position: state.positionLabel || (state.cursor == null ? "start" : ""),
    // The job the run will process next (title only: never the queue itself) and the progress denominator.
    current: state.pending && state.pending.length ? { externalId: String(state.pending[0].externalId), title: String(state.pending[0].title || "").slice(0, 200) } : null,
    total: Number.isInteger(state.sourceTotal) ? Math.max(state.sourceTotal, state.counters.discovered) : state.counters.discovered,
    partial: state.partialSaved || 0,
    failedCount: Array.isArray(state.failedRefs) ? state.failedRefs.length : 0,
    results: Array.isArray(state.results) ? state.results.map((r) => ({ id: r.id, title: r.t, outcome: r.o, reason: r.r })) : [],
    retryOf: state.retryOf || null,
    importStats: state.params && state.params.stats ? { ...state.params.stats } : null,
    lastError: state.lastError ? { ...state.lastError } : null,
    retry: state.retry ? { attempt: state.retry.attempt, until: state.retry.until, reason: state.retry.reason } : null,
    waiting: state.waiting ? { until: state.waiting.until } : null,
    warnings: state.warnings.slice(-5),
    failures: state.failures.slice(-10),
    resumeCount: state.resumeCount,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    finishedAt: state.finishedAt,
  };
}
