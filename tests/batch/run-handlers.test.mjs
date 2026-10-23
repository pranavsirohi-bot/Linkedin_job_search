// Run-control messages: only extension pages may use them, payloads are validated, commands drive the real controller.
import test from "node:test";
import assert from "node:assert/strict";
import { createHandlers } from "../../src/background/handlers.js";
import { makeIsTrustedSender } from "../../src/background/trust.js";
import { MSG } from "../../src/shared/messages.js";
import { gate, ids, makeEnv, makeSource, tick } from "./helpers.mjs";

const EXT = "abcdefghijklmnopabcdefghijklmnop";
const POPUP = { id: EXT, url: `chrome-extension://${EXT}/src/popup/popup.html` };
const BATCH_PAGE = { id: EXT, tab: { id: 3 }, url: `chrome-extension://${EXT}/src/batchpage/batch.html` };
const CONTENT_SCRIPT = { id: EXT, tab: { id: 9 }, url: "https://www.linkedin.com/jobs/view/4480218579/" };
const RUN_TYPES = [MSG.RUN_START, MSG.RUN_PAUSE, MSG.RUN_RESUME, MSG.RUN_STOP, MSG.RUN_STATUS, MSG.RUN_DISMISS];
const OK_CFG = () => ({ ok: true, reason: "" });

function setup({ pages = [ids(1, 4), ids(5, 4)], hooks, checkConfig = OK_CFG, ready } = {}) {
  const source = makeSource({ id: "fake", pages, hooks });
  const env = makeEnv({ source });
  const handle = createHandlers({
    getClient: () => { throw new Error("run control must not need a Supabase client"); },
    checkConfig,
    isTrustedSender: makeIsTrustedSender(EXT),
    runs: env.controller,
    sources: { list: () => [{ id: "fake", label: "Fake" }] },
    ready,
  });
  return { env, handle, source };
}
const send = (h, type, extra = {}, sender = POPUP) => h({ type, ...extra }, sender);

test("every run message is refused for content scripts and unknown senders, and changes nothing", async () => {
  const { env, handle } = setup();
  for (const type of RUN_TYPES) {
    for (const sender of [CONTENT_SCRIPT, null, { id: "other", url: "https://evil.example/" }, { id: EXT }]) {
      const res = await send(handle, type, { sourceId: "fake", params: {}, limits: {} }, sender);
      assert.equal(res.ok, false, `${type}`);
      assert.equal(res.error.code, "PERMISSION", `${type}`);
    }
  }
  assert.equal(await env.state(), null, "no run was created, paused, stopped or dismissed");
});

test("extension pages (popup and a page opened in a tab) may control runs", async () => {
  const { handle, env } = setup();
  for (const sender of [POPUP, BATCH_PAGE]) {
    const res = await send(handle, MSG.RUN_STATUS, {}, sender);
    assert.equal(res.ok, true);
  }
  await env.idle();
});

test("RUN_STATUS reports no run and the available sources", async () => {
  const { handle } = setup();
  assert.deepEqual(await send(handle, MSG.RUN_STATUS), { ok: true, run: null, sources: [{ id: "fake", label: "Fake" }] });
});

test("start -> progress -> completed through messages; the response carries the persisted summary", async () => {
  const { handle, env } = setup();
  const started = await send(handle, MSG.RUN_START, { sourceId: "fake", params: {}, limits: { maxJobs: 8 } });
  assert.equal(started.ok, true);
  assert.equal(started.run.status, "running");
  assert.equal(started.run.config.maxJobs, 8);
  await env.idle();
  const done = await send(handle, MSG.RUN_STATUS);
  assert.equal(done.run.status, "completed");
  assert.equal(done.run.counters.saved, 8);
  const cleared = await send(handle, MSG.RUN_DISMISS);
  assert.equal(cleared.run, null);
  assert.equal(env.saver.rows.size, 8, "dismissing never removes saved jobs");
});

test("pause, resume and stop commands drive the controller", async () => {
  const hold = gate();
  const { handle, env, source } = setup({ hooks: { search: async ({ p }) => { if (p === 1) await hold.promise; } } });
  await send(handle, MSG.RUN_START, { sourceId: "fake", params: {}, limits: {} });
  while (source.calls.search.length < 2) await tick(1);
  const pausing = await send(handle, MSG.RUN_PAUSE);
  assert.equal(pausing.run.pauseRequested, true);
  hold.open();
  await env.idle();
  assert.equal((await send(handle, MSG.RUN_STATUS)).run.status, "paused");
  const resumed = await send(handle, MSG.RUN_RESUME);
  assert.equal(resumed.run.status, "running");
  await env.idle();
  assert.equal((await send(handle, MSG.RUN_STATUS)).run.status, "completed");

  await send(handle, MSG.RUN_DISMISS);
  const hold2 = gate();
  const b = setup({ hooks: { search: async () => { await hold2.promise; } } });
  await send(b.handle, MSG.RUN_START, { sourceId: "fake", params: {}, limits: {} });
  const stopped = await send(b.handle, MSG.RUN_STOP);
  assert.ok(["stopping", "stopped"].includes(stopped.run.status));
  hold2.open();
  await b.env.idle();
  assert.equal((await send(b.handle, MSG.RUN_STATUS)).run.status, "stopped");
});

test("invalid commands come back as { ok:false, error:{ code, message } }, not exceptions", async () => {
  const { handle, env } = setup();
  const code = async (type, extra) => (await send(handle, type, extra)).error.code;
  assert.equal(await code(MSG.RUN_PAUSE), "no-run");
  assert.equal(await code(MSG.RUN_RESUME), "no-run");
  assert.equal(await code(MSG.RUN_STOP), "no-run");
  await send(handle, MSG.RUN_START, { sourceId: "fake", params: {}, limits: {} });
  assert.equal(await code(MSG.RUN_START, { sourceId: "fake", params: {}, limits: {} }), "run-active");
  assert.equal(await code(MSG.RUN_DISMISS), "run-active");
  await env.idle();
  assert.equal(await code(MSG.RUN_PAUSE), "invalid-state");
  assert.equal(await code(MSG.RUN_RESUME), "invalid-state");
});

test("start payloads are validated: source, params, limits (including the hard caps), and size", async () => {
  const { handle, env } = setup();
  const code = async (extra) => (await send(handle, MSG.RUN_START, extra)).error.code;
  assert.equal(await code({}), "unknown-source");
  assert.equal(await code({ sourceId: 5 }), "unknown-source");
  assert.equal(await code({ sourceId: ["fake"] }), "unknown-source");
  assert.equal(await code({ sourceId: "nope" }), "unknown-source");
  assert.equal(await code({ sourceId: "__proto__" }), "unknown-source");
  assert.equal(await code({ sourceId: "fake", params: [] }), "invalid-params");
  assert.equal(await code({ sourceId: "fake", params: "x" }), "invalid-params");
  assert.equal(await code({ sourceId: "fake", params: { bad: true } }), "invalid-params");
  assert.equal(await code({ sourceId: "fake", params: { big: "x".repeat(4_100_000) } }), "invalid-params");
  assert.equal(await code({ sourceId: "fake", limits: [] }), "invalid-limits");
  assert.equal(await code({ sourceId: "fake", limits: { maxJobs: 501 } }), "invalid-limits");
  assert.equal(await code({ sourceId: "fake", limits: { maxPages: 51 } }), "invalid-limits");
  assert.equal(await code({ sourceId: "fake", limits: { pageSize: 51 } }), "invalid-limits");
  assert.equal(await env.state(), null, "none of the rejected requests created a run");
});

test("extra fields in a start message (user ids, flags) have no effect on the run", async () => {
  const { handle, env } = setup();
  const res = await send(handle, MSG.RUN_START, { sourceId: "fake", params: {}, limits: {}, userId: "evil", user_id: "evil", status: "completed", counters: { saved: 999 }, pending: [{ externalId: "x" }] });
  assert.equal(res.ok, true);
  await env.idle();
  const s = await env.state();
  assert.equal(s.counters.saved, 8);
  assert.doesNotMatch(JSON.stringify(s), /evil|userId|user_id/);
});

test("starting needs a configured project; pausing, stopping and reading a run work without one", async () => {
  const unconfigured = () => ({ ok: false, reason: "Supabase project URL is not configured." });
  const a = setup({ checkConfig: unconfigured });
  assert.equal((await send(a.handle, MSG.RUN_START, { sourceId: "fake", params: {}, limits: {} })).error.code, "NOT_CONFIGURED");
  assert.equal((await send(a.handle, MSG.RUN_STATUS)).ok, true);

  // A run is already in progress; the configuration check must not block pausing or stopping it.
  const hold = gate();
  const b = setup({ hooks: { search: async () => { await hold.promise; } } });
  await send(b.handle, MSG.RUN_START, { sourceId: "fake", params: {}, limits: {} });
  const off = createHandlers({ getClient: () => { throw new Error("no client"); }, checkConfig: unconfigured, isTrustedSender: makeIsTrustedSender(EXT), runs: b.env.controller, sources: { list: () => [] } });
  assert.equal((await send(off, MSG.RUN_PAUSE)).ok, true);
  assert.equal((await send(off, MSG.RUN_STOP)).ok, true);
  hold.open();
  await b.env.idle();
});

test("run messages wait for start-up recovery before answering", async () => {
  const recovery = gate();
  const { handle } = setup({ ready: recovery.promise });
  let answered = false;
  const p = send(handle, MSG.RUN_STATUS).then((r) => { answered = true; return r; });
  await tick(10);
  assert.equal(answered, false, "a stale 'running' state must not be shown before recovery has marked it interrupted");
  recovery.open();
  assert.equal((await p).ok, true);
});

test("run handlers exist only when a controller is supplied; unrelated message types are ignored", async () => {
  const withRuns = setup().handle;
  for (const t of RUN_TYPES) assert.equal(withRuns.handles(t), true, t);
  assert.equal(withRuns.handles("EXTRACT_PREVIEW"), false);
  assert.equal(await withRuns({ type: "EXTRACT_PREVIEW" }, POPUP), undefined);
  const without = createHandlers({ getClient: () => null, checkConfig: OK_CFG, isTrustedSender: makeIsTrustedSender(EXT) });
  for (const t of RUN_TYPES) assert.equal(without.handles(t), false, t);
});
