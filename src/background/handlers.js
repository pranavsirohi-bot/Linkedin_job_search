// Message handlers for the service worker. Dependencies are injected so this is testable without Chrome or a network.
//   getClient()        -> supabase client (created lazily by the service worker)
//   checkConfig()      -> { ok, reason }
//   isTrustedSender(s) -> true only for this extension's own pages (never content scripts / web pages)
//   runs               -> batch run controller (optional)
//   sources            -> job source registry, used only to describe the available sources (optional)
//   withSession(fn)    -> runs fn(client) under the anonymous session (optional; built from getClient by default)
//   ready              -> promise resolved once start-up recovery has run (run messages wait for it)
//   watch              -> auto-save session (optional)
//   isContentSender(s) -> true only for our content script in a LinkedIn tab (allowed to send PAGE_CHANGED and PILOT_EVENT, nothing else)
import { MSG, PROTOCOL } from "../shared/messages.js";
import { RunError } from "../batch/run-state.js";
import { ensureSession, recoverSession } from "../db/auth.js";
import { DbError, ERR, toDbError } from "../db/errors.js";
import { countJobs, deleteJob, detailColumnsAvailable, findDuplicates, getJob, listJobs, providerColumnsAvailable, saveJobs, updateJob } from "../db/saved-jobs.js";

const MAX_JOBS_PER_SAVE = 500;
const MAX_RUN_PARAMS_CHARS = 4 * 1000 * 1000; // serialized size of the parameters sent to start a run

const fail = (err) => {
  if (err instanceof RunError) return { ok: false, error: err.toJSON() };
  const e = toDbError(err);
  return { ok: false, error: e.toJSON() };
};

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

// Every data operation runs under the anonymous session owned by this service worker. The session is resolved
// here (reused, or created once); nothing the popup sends can name the owner. If the server rejects the token we
// recover once and retry, so a stale session does not drop the user's extracted data.
export function createSessionRunner(getClient) {
  return async function withSession(fn) {
    const client = getClient();
    let session = await ensureSession(client);
    let out;
    try {
      out = await fn(client);
    } catch (e) {
      if (toDbError(e).code !== ERR.AUTH_REQUIRED) throw e;
      session = await recoverSession(client);
      out = await fn(client);
    }
    return session.replaced && out && typeof out === "object" ? { ...out, sessionReplaced: true } : out;
  };
}

export function createHandlers({ getClient, checkConfig, isTrustedSender, isContentSender = () => false, runs, sources, watch, watchPreflight = () => ensureSession(getClient()), withSession: injected, ready = Promise.resolve() }) {
  const withSession = injected || createSessionRunner(getClient);
  const authed = (fn) => (message) => withSession((client) => fn(client, message));

  const handlers = {
    [MSG.PING]: async () => ({ ok: true, from: "service-worker", time: Date.now(), protocol: PROTOCOL }),

    // Ensures a session exists (reusing the stored one) and reports who we are. Called when the popup opens.
    [MSG.AUTH_STATUS]: async () => {
      const cfg = checkConfig();
      if (!cfg.ok) return { ok: true, configured: false, reason: cfg.reason, user: null };
      const session = await ensureSession(getClient());
      return { ok: true, configured: true, user: session.user, created: session.created, sessionReplaced: session.replaced };
    },

    [MSG.SAVE_JOBS]: authed(async (client, m) => {
      if (!Array.isArray(m.jobs) || m.jobs.length === 0) throw new DbError(ERR.VALIDATION, "No jobs to save.");
      if (m.jobs.length > MAX_JOBS_PER_SAVE) throw new DbError(ERR.VALIDATION, `Too many jobs at once (max ${MAX_JOBS_PER_SAVE}).`);
      return { ok: true, result: await saveJobs(client, m.jobs) };
    }),
    [MSG.FIND_DUPLICATES]: authed(async (client, m) => ({ ok: true, ids: await findDuplicates(client, m.ids) })),
    [MSG.COUNT_SAVED]: authed(async (client) => ({ ok: true, count: await countJobs(client) })),
    [MSG.LIST_JOBS]: authed(async (client, m) => ({ ok: true, ...(await listJobs(client, m.filters || {})) })),
    [MSG.GET_JOB]: authed(async (client, m) => {
      const job = await getJob(client, m.id);
      if (!job) throw new DbError(ERR.NOT_FOUND, "Job not found.");
      return { ok: true, job };
    }),
    [MSG.UPDATE_JOB]: authed(async (client, m) => ({ ok: true, job: await updateJob(client, m.id, m.patch) })),
    [MSG.DELETE_JOB]: authed(async (client, m) => ({ ok: true, ...(await deleteJob(client, m.id)) })),
    [MSG.SCHEMA_STATUS]: authed(async (client) => ({ ok: true, detailColumns: await detailColumnsAvailable(client), multiProvider: await providerColumnsAvailable(client) })),
  };

  if (runs) {
    // Run control. The popup only sends commands; progress is read from the persisted run state.
    const status = async () => ({ ok: true, run: await runs.getState(), sources: sources ? sources.list() : [] });
    Object.assign(handlers, {
      [MSG.RUN_STATUS]: async () => { await ready; return status(); },
      [MSG.RUN_START]: async (m) => {
        await ready;
        if (typeof m.sourceId !== "string") throw new RunError("unknown-source", "Choose a job source.");
        if (m.params !== undefined && !isPlainObject(m.params)) throw new RunError("invalid-params", "The run settings are not valid.");
        if (m.limits !== undefined && !isPlainObject(m.limits)) throw new RunError("invalid-limits", "The run limits are not valid.");
        let size;
        try { size = JSON.stringify(m.params || {}).length; } catch { size = Infinity; }
        if (size > MAX_RUN_PARAMS_CHARS) throw new RunError("invalid-params", "The run settings are too large.");
        await runs.start({ sourceId: m.sourceId, params: m.params || {}, limits: m.limits || {} });
        return status();
      },
      [MSG.RUN_PAUSE]: async () => { await ready; await runs.pause(); return status(); },
      [MSG.RUN_RESUME]: async () => { await ready; await runs.resume(); return status(); },
      [MSG.RUN_STOP]: async (m) => { await ready; await runs.stop(typeof m.runId === "string" ? m.runId : undefined); return status(); },
      [MSG.RUN_RETRY_FAILED]: async () => { await ready; await runs.retryFailed(); return status(); },
      [MSG.RUN_DISMISS]: async (m) => { await ready; await runs.dismiss(typeof m.runId === "string" ? m.runId : undefined); return status(); },
    });
  }

  if (watch) {
    // Auto-save while browsing. The popup names the tab; the worker checks it is a LinkedIn tab and reads it itself.
    // automaticSources: configured sources that can fetch and page jobs by themselves (none today).
    const automaticSources = () => (sources ? sources.list().filter((s) => s.automatic === true).map((s) => ({ id: s.id, label: s.label })) : []);
    const wstatus = async () => ({ ok: true, watch: await watch.getState(), automaticSources: automaticSources() });
    Object.assign(handlers, {
      [MSG.WATCH_STATUS]: async () => { await ready; return wstatus(); },
      [MSG.WATCH_START]: async (m) => {
        await ready;
        if (!Number.isInteger(m.tabId) || m.tabId < 0) throw new RunError("invalid-tab", "Open a LinkedIn jobs page (search results or a job), then press Start.");
        await watchPreflight(); // fail fast (session / connection) before anything is watched
        await watch.start({ tabId: m.tabId, pageUrl: typeof m.pageUrl === "string" ? m.pageUrl : "", autoClick: m.autoClick === true, maxPages: m.maxPages });
        return wstatus();
      },
      [MSG.WATCH_STOP]: async (m) => { await ready; await watch.stop(typeof m.sessionId === "string" ? m.sessionId : undefined); return wstatus(); },
      [MSG.WATCH_PAUSE]: async (m) => { await ready; await watch.pause(typeof m.sessionId === "string" ? m.sessionId : undefined); return wstatus(); },
      [MSG.WATCH_RESUME]: async (m) => { await ready; await watch.resume(typeof m.sessionId === "string" ? m.sessionId : undefined); return wstatus(); },
      [MSG.WATCH_RETRY]: async (m) => { await ready; await watch.retry(typeof m.sessionId === "string" ? m.sessionId : undefined); return wstatus(); },
      [MSG.WATCH_SET_AUTOCLICK]: async (m) => {
        await ready;
        await watch.setAutoClick(typeof m.sessionId === "string" ? m.sessionId : undefined, { autoClick: m.autoClick === true, maxPages: m.maxPages });
        return wstatus();
      },
      // Data-free ping; the message body is ignored, only the sender's tab id is used.
      // "ready" is the only field read: the content script saw the opened job's details render.
      [MSG.PAGE_CHANGED]: async (m, sender) => { await ready; return { ok: true, watching: await watch.pageChanged(sender.tab.id, { ready: m.ready === true }) }; },
      // Auto-click progress from the content script; only the sender's tab id, "event" and "reason" are read.
      [MSG.PILOT_EVENT]: async (m, sender) => {
        await ready;
        return { ok: true, ...(await watch.pilotEvent(sender.tab.id, { event: typeof m.event === "string" ? m.event : "", reason: typeof m.reason === "string" ? m.reason : "" })) };
      },
    });
  }

  // Everything except these needs a configured Supabase project. (Pausing, stopping and reading a run work offline.)
  const NO_CONFIG_NEEDED = new Set([MSG.PING, MSG.AUTH_STATUS, MSG.RUN_STATUS, MSG.RUN_PAUSE, MSG.RUN_RESUME, MSG.RUN_STOP, MSG.RUN_DISMISS, MSG.WATCH_STATUS, MSG.WATCH_STOP, MSG.WATCH_PAUSE, MSG.PAGE_CHANGED, MSG.PILOT_EVENT]);
  // The only messages a content script may send.
  const CONTENT_SCRIPT_TYPES = new Set([MSG.PAGE_CHANGED, MSG.PILOT_EVENT]);

  async function handle(message, sender) {
    const type = message && message.type;
    const handler = Object.hasOwn(handlers, type) ? handlers[type] : null;
    if (!handler) return undefined; // not ours (e.g. content-script message types)
    try {
      const allowed = type === MSG.PING || (CONTENT_SCRIPT_TYPES.has(type) ? isContentSender(sender) : isTrustedSender(sender));
      if (!allowed) throw new DbError(ERR.PERMISSION, "Request not allowed from this context.");
      if (!NO_CONFIG_NEEDED.has(type)) {
        const cfg = checkConfig();
        if (!cfg.ok) throw new DbError(ERR.NOT_CONFIGURED, cfg.reason);
      }
      return await handler(message, sender);
    } catch (e) {
      return fail(e);
    }
  }
  handle.handles = (type) => Object.hasOwn(handlers, type);
  return handle;
}
