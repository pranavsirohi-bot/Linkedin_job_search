// Deterministic fakes for run-controller tests: virtual clock, alarms, source, store and saver.
import { DbError, ERR } from "../../src/db/errors.js";
import { SourceError } from "../../src/sources/http.js";
import { createRunController } from "../../src/batch/run-controller.js";
import { createMemoryRunStore } from "../../src/batch/run-store.js";

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// A source that serves `pages` (arrays of ids) with cursor {p}. Hooks let a test fail or hold any call.
export function makeSource({ id = "fake", pages = [], heavy = false, hooks = {} } = {}) {
  const calls = { search: [], details: [], normalize: [] };
  return {
    calls,
    id,
    label: "Fake",
    heavyParams: heavy ? ["records"] : [],
    validateParams: (params) => (params && params.bad ? { ok: false, errors: ["bad params"] } : { ok: true, params: heavy ? { records: params.records || [], note: params.note || "" } : { ...(params || {}) } }),
    async search(params, cursor, ctx) {
      const p = cursor && Number.isInteger(cursor.p) ? cursor.p : 0;
      calls.search.push({ p, cursor, pageSize: ctx.pageSize, signal: ctx.signal });
      if (hooks.search) {
        const r = await hooks.search({ p, cursor, call: calls.search.length, ctx, params });
        if (r !== undefined) return r;
      }
      const ids = pages[p] || [];
      const next = p + 1 < pages.length ? { p: p + 1 } : null;
      return { refs: ids.map((x) => ({ externalId: String(x), title: `Job ${x}` })), nextCursor: next };
    },
    async getDetails(ref, ctx) {
      calls.details.push(ref.externalId);
      if (hooks.details) {
        const r = await hooks.details({ ref, call: calls.details.length, ctx });
        if (r !== undefined) return r;
      }
      return { id: ref.externalId, title: ref.title };
    },
    normalize(raw, ref) {
      calls.normalize.push(ref.externalId);
      if (hooks.normalize) {
        const r = hooks.normalize(raw, ref);
        if (r !== undefined) return r;
      }
      return { provider: "fake", externalId: raw.id, url: `https://x.example/${raw.id}`, title: raw.title, description: `desc ${raw.id}` };
    },
  };
}

// Saver that behaves like the idempotent upsert: same (provider, externalId) twice is a duplicate, not a new row.
export function makeSaver({ hook } = {}) {
  const rows = new Map();
  const batches = [];
  const saver = async (records) => {
    batches.push(records.map((r) => r.externalId));
    if (hook) {
      const r = await hook({ records, call: batches.length, rows });
      if (r !== undefined) return r;
    }
    let inserted = 0;
    let duplicates = 0;
    for (const rec of records) {
      const key = `${rec.provider}:${rec.externalId}`;
      if (rows.has(key)) { duplicates++; rows.set(key, { ...rows.get(key), ...rec }); } else { inserted++; rows.set(key, rec); }
    }
    return { total: records.length, inserted, duplicates, rejected: [] };
  };
  saver.rows = rows;
  saver.batches = batches;
  return saver;
}

export function makeEnv({ source, sources, saver = makeSaver(), store = createMemoryRunStore(), preflight, paceMs = 0, start: startTime = 1_700_000_000_000 } = {}) {
  let t = startTime;
  const slept = [];
  const alarmCalls = [];
  const registry = sources || new Map([[source.id, source]]);
  let idn = 0;
  const alarms = { schedule: async (ms) => { alarmCalls.push({ ms, at: t }); }, cancel: async () => { alarmCalls.push({ cancelled: true }); } };
  const controller = createRunController({
    store,
    sources: { get: (id) => registry.get(id) || null },
    save: saver,
    preflight,
    alarms,
    now: () => t,
    random: () => 0.5, // zero jitter, so delays are exactly base * 2^(n-1)
    newId: () => `run-${++idn}`,
    sleep: async (ms) => { slept.push(ms); t += ms; await Promise.resolve(); },
    paceMs,
  });
  return {
    controller, store, saver, source, alarms: alarmCalls, slept,
    clock: { now: () => t, advance: (ms) => { t += ms; } },
    state: () => store.load(),
    // Wait until the driver has fully finished (including a possible automatic restart).
    async idle() {
      for (let i = 0; i < 6; i++) { await controller.whenIdle(); await tick(0); }
    },
  };
}

// A brand-new controller (a "restarted" service worker / browser) over the persisted data of another env.
export function restartedEnv(old, { source, sources, saver, paceMs = 0, startTime } = {}) {
  const store = createMemoryRunStore(old.store.snapshot());
  return makeEnv({ source: source || old.source, sources, saver: saver || old.saver, store, paceMs, start: startTime ?? old.clock.now() });
}

export const transient = (msg = "network down") => new SourceError("transient", msg);
export const rateLimited = (retryAfterMs) => new SourceError("rate-limited", "slow down", { retryAfterMs });
export const fatal = (msg = "access refused") => new SourceError("fatal", msg, { status: 403 });
export const netDb = () => new DbError(ERR.NETWORK, "Can't reach the server.");

export const ids = (from, n) => Array.from({ length: n }, (_, i) => `j${from + i}`);

// A promise you resolve by hand: lets a test hold a source call open while it sends a control message.
export function gate() {
  let open;
  const promise = new Promise((r) => { open = r; });
  return { promise, open };
}
