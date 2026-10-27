// The template for an authorised, paginated job-data API (src/sources/api-source.js), driven by the real run controller against a FAKE
// provider. No real provider exists in the project and none is called. These tests prove the contract a future adapter relies on.
import test from "node:test";
import assert from "node:assert/strict";
import { createApiSource, gradeRecord } from "../src/sources/api-source.js";
import { assertJobSource } from "../src/sources/registry.js";
import { SourceError } from "../src/sources/http.js";
import { gate, makeEnv, makeSaver, restartedEnv, tick } from "./batch/helpers.mjs";

// A fake provider: `total` jobs, `perPage` per page, pages addressed by { page }.
function fakeProvider({ total = 23, perPage = 10, item, hook } = {}) {
  const calls = [];
  const make = item || ((i) => ({ id: `A${i}`, title: `API Job ${i}`, company: "Co", location: "Delhi", description: `Description ${i}`, link: `https://jobs.example.com/${i}` }));
  async function fetchPage({ params, cursor, pageSize, signal }) {
    const page = cursor && cursor.page ? cursor.page : 1;
    calls.push({ page, pageSize, params, cursor });
    if (hook) { const r = await hook({ page, call: calls.length, signal }); if (r !== undefined) return r; }
    const size = Math.min(pageSize, perPage);
    const from = (page - 1) * size;
    const items = Array.from({ length: Math.max(Math.min(size, total - from), 0) }, (_, k) => make(from + k + 1));
    return { items, nextCursor: from + size < total ? { page: page + 1 } : null, total };
  }
  return { calls, fetchPage };
}

const COUNTRIES = ["in", "gb"];
const parseParams = (params, { maxJobs } = {}) => {
  const query = String(params.query ?? "").trim().slice(0, 100);
  const country = String(params.country ?? "in");
  if (!COUNTRIES.includes(country)) return { ok: false, errors: [`Country must be one of ${COUNTRIES.join(", ")}.`] };
  return { ok: true, params: { query, country } }; // whitelist: nothing else (no keys or tokens) is persisted
};
const build = (provider, over = {}) => createApiSource({
  id: "example-api", label: "Example authorised API", parseParams, fetchPage: provider.fetchPage,
  idOf: (raw) => raw.id, toRecord: (raw) => ({ title: raw.title, company: raw.company, location: raw.location, description: raw.description, url: raw.link }),
  ...over,
});
function setup({ provider = fakeProvider(), saver = makeSaver(), source } = {}) {
  const src = source || build(provider);
  const env = makeEnv({ source: src, saver });
  const start = (params = { query: "developer", country: "in" }, limits = { maxJobs: 100, maxPages: 20, pageSize: 10 }) => env.controller.start({ sourceId: "example-api", params, limits });
  return { env, start, saver, provider, src };
}

test("the template validates what an adapter must provide, and cannot claim a LinkedIn identity", () => {
  const p = fakeProvider();
  assert.doesNotThrow(() => assertJobSource(build(p)));
  assert.throws(() => build(p, { id: "Bad Id" }), /valid id/);
  assert.throws(() => build(p, { id: "linkedin" }), /LinkedIn/);
  assert.throws(() => build(p, { id: "linkedin-page" }), /LinkedIn/);
  for (const missing of ["parseParams", "fetchPage", "idOf", "toRecord"]) assert.throws(() => build(p, { [missing]: undefined }), new RegExp(missing));
  assert.equal(build(p).automatic, true);
});

test("sequential retrieval follows the provider's pagination to the end; every job is saved once, with its source attribution", async () => {
  const { env, start, saver, provider } = setup();
  await start();
  await env.idle();
  const s = await env.controller.getState();
  assert.equal(s.status, "completed");
  assert.deepEqual(s.counters, { discovered: 23, processed: 23, saved: 23, duplicates: 0, skipped: 0, failed: 0 });
  assert.deepEqual(provider.calls.map((c) => c.page), [1, 2, 3], "one request per page, in order, no repeats");
  assert.deepEqual(provider.calls.map((c) => c.cursor), [null, { page: 2 }, { page: 3 }]);
  assert.equal(saver.rows.size, 23);
  const row = saver.rows.get("example-api:A7");
  assert.deepEqual([row.provider, row.externalId, row.source, row.url, row.extractionStatus], ["example-api", "A7", "detail", "https://jobs.example.com/7", "complete"]);
  assert.equal(s.total, 23, "the provider's total is the progress denominator");
  assert.equal(s.position, "end of results");
});

test("only the documented, whitelisted settings are used and persisted; a key cannot end up in the checkpoint", async () => {
  const { env, start, provider } = setup();
  await start({ query: "wordpress", country: "gb", apiKey: "SECRET-KEY-123", token: "t", __proto__: { evil: true } });
  await env.idle();
  const stored = JSON.stringify(env.store.snapshot());
  assert.doesNotMatch(stored, /SECRET-KEY-123|"token"|apiKey/);
  assert.deepEqual(provider.calls[0].params, { query: "wordpress", country: "gb" });
  await assert.rejects(env.controller.start({ sourceId: "example-api", params: { country: "zz" }, limits: {} }), (e) => e.code === "invalid-params" && /Country must be one of/.test(e.message));
});

test("the job limit is honoured: later pages are not requested and extra results are never saved", async () => {
  const { env, start, saver, provider } = setup();
  await start({ query: "x", country: "in" }, { maxJobs: 12, maxPages: 20, pageSize: 10 });
  await env.idle();
  const s = await env.controller.getState();
  assert.deepEqual([s.status, s.counters.saved, saver.rows.size, s.endReason, s.moreAvailable], ["completed", 12, 12, "job-limit", true]);
  assert.deepEqual(provider.calls.map((c) => c.page), [1, 2]);
});

test("rate limiting is honoured: Retry-After is waited out, then the run carries on", async () => {
  let limited = false;
  const provider = fakeProvider({ hook: async ({ page }) => { if (page === 2 && !limited) { limited = true; throw new SourceError("rate-limited", "429 Too Many Requests", { retryAfterMs: 3000 }); } } });
  const { env, start } = setup({ provider });
  await start();
  await env.idle();
  const s = await env.controller.getState();
  assert.equal(s.status, "completed");
  assert.equal(s.counters.saved, 23);
  assert.ok(env.slept.some((ms) => ms >= 3000), `waited at least the provider's Retry-After (slept ${env.slept.join(",")})`);
});

test("temporary failures back off exponentially; a fatal answer ends the run and keeps what was saved", async () => {
  let n = 0;
  const flaky = fakeProvider({ hook: async () => { if (++n <= 2) throw new SourceError("transient", "network down"); } });
  const a = setup({ provider: flaky });
  await a.start();
  await a.env.idle();
  assert.equal((await a.env.controller.getState()).status, "completed");
  assert.deepEqual(a.env.slept.slice(0, 2), [1000, 2000]);
  const refused = fakeProvider({ hook: async ({ page }) => { if (page === 2) throw new SourceError("fatal", "access refused (403)", { status: 403 }); } });
  const b = setup({ provider: refused });
  await b.start();
  await b.env.idle();
  const s = await b.env.controller.getState();
  assert.equal(s.status, "failed");
  assert.match(s.lastError.message, /access refused/);
  assert.equal(b.saver.rows.size, 10, "page 1 was saved before the provider refused page 2");
});

test("Stop prevents further requests and lets the save in flight finish", async () => {
  const hold = gate();
  const provider = fakeProvider();
  const saver = makeSaver({ hook: async ({ call }) => { if (call === 1) await hold.promise; } });
  const { env, start } = setup({ provider, saver });
  const run = await start();
  while (saver.batches.length < 1) await tick(1);
  await env.controller.stop(run.runId);
  hold.open();
  await env.idle();
  const s = await env.controller.getState();
  assert.equal(s.status, "stopped");
  assert.deepEqual(provider.calls.map((c) => c.page), [1], "page 2 was never requested");
  assert.equal(saver.rows.size, 10, "the batch in flight was saved");
});

test("the same job returned twice is counted once as a duplicate and saved once", async () => {
  const provider = fakeProvider({ total: 20, item: (i) => ({ id: i === 15 ? "A5" : `A${i}`, title: `API Job ${i}`, company: "Co", description: "d", link: `https://jobs.example.com/${i}` }) });
  const { env, start, saver } = setup({ provider });
  await start();
  await env.idle();
  const s = await env.controller.getState();
  assert.deepEqual([s.counters.discovered, s.counters.duplicates, s.counters.saved, saver.rows.size], [19, 1, 19, 19]);
});

test("missing fields are reported honestly: partial, skipped (no id) and failed (no usable link); nothing is invented", async () => {
  const provider = fakeProvider({
    total: 6,
    item: (i) => ({
      id: i === 5 ? "" : `A${i}`, title: `API Job ${i}`, company: i === 2 ? "" : "Co", description: i === 1 ? "" : `Description ${i}`,
      link: i === 6 ? "http://insecure.example.com/6" : `https://jobs.example.com/${i}`,
    }),
  });
  const { env, start, saver } = setup({ provider });
  await start();
  await env.idle();
  const s = await env.controller.getState();
  const by = Object.fromEntries(s.results.map((r) => [r.id, [r.outcome, r.reason]]));
  assert.deepEqual(by.A1, ["partial", "missing:description"]);
  assert.deepEqual(by.A2, ["partial", "missing:company"]);
  assert.equal(by.A6[0], "failed", "an insecure link is not a usable job link");
  assert.equal(saver.rows.get("example-api:A1").description, "", "no description is invented");
  assert.deepEqual([s.partial, s.counters.skipped, s.counters.failed, saver.rows.size], [2, 1, 1, 4]);
  assert.ok(s.warnings.some((w) => /without a valid id/.test(w)));
});

test("after a restart the in-memory copy is gone: pending jobs are re-read from the page they came from, never lost or duplicated", async () => {
  const hold = gate();
  const provider = fakeProvider({ total: 25, perPage: 25 });
  const saver = makeSaver({ hook: async ({ call }) => { if (call === 2) await hold.promise; } });
  const first = setup({ provider, saver });
  await first.start({ query: "x", country: "in" }, { maxJobs: 100, maxPages: 5, pageSize: 25 });
  while (saver.batches.length < 2) await tick(1);
  const provider2 = fakeProvider({ total: 25, perPage: 25 });
  const reborn = restartedEnv(first.env, { source: build(provider2), saver });
  const recovered = await reborn.controller.recover("browser-start");
  assert.equal(recovered.status, "interrupted");
  await reborn.controller.resume();
  await reborn.idle();
  const s = await reborn.controller.getState();
  assert.equal(s.status, "completed");
  assert.deepEqual(provider2.calls.map((c) => c.page), [1], "one re-read of the page (the in-memory copy was lost)");
  assert.equal(saver.rows.size, 25, "every job exactly once");
  hold.open();
});

test("provider code cannot set identity or attribution: provider, id and source come from the adapter", () => {
  const p = fakeProvider();
  const src = createApiSource({
    id: "example-api", label: "x", parseParams, fetchPage: p.fetchPage, idOf: (r) => r.id,
    toRecord: (raw) => ({ title: raw.title, url: raw.link, provider: "linkedin", externalId: "evil", source: "card", description: "d", company: "c" }),
  });
  const rec = src.normalize({ id: "A1", title: "T", link: "https://jobs.example.com/1" }, { externalId: "A1" });
  assert.deepEqual([rec.provider, rec.externalId, rec.source], ["example-api", "A1", "detail"]);
  assert.equal(src.normalize({ id: "A1", title: "T", link: "javascript:alert(1)" }, {}), null);
  assert.equal(gradeRecord({ description: "d", company: "c" }).extractionStatus, "complete");
  assert.deepEqual(gradeRecord({ description: "", company: "c" }).extractionWarnings, ["missing:description"]);
});

test("Retry failed is offered only when the adapter says how to rebuild its input", async () => {
  const refuseAll = makeSaver({ hook: async () => { throw Object.assign(new Error("rejected"), { code: "VALIDATION" }); } });
  const a = setup({ saver: refuseAll });
  await a.start();
  await a.env.idle();
  await a.env.controller.stop((await a.env.controller.getState()).runId);
  await assert.rejects(a.env.controller.retryFailed(), (e) => e.code === "retry-unsupported");
});
