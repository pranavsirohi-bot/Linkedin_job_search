// Honest completion at limits, expired cursors, readable position, import statistics.
import test from "node:test";
import assert from "node:assert/strict";
import { SourceError } from "../../src/sources/http.js";
import { gate, ids, makeEnv, makeSource, tick } from "./helpers.mjs";

const run = (env, extra = {}) => env.controller.start({ sourceId: env.source.id, params: {}, limits: {}, ...extra });

test("a page limit with more pages left is reported as 'more available', never as all done", async () => {
  const env = makeEnv({ source: makeSource({ pages: [ids(1, 2), ids(3, 2), ids(5, 2)] }) });
  await run(env, { limits: { maxPages: 2 } });
  await env.idle();
  const s = await env.controller.getState();
  assert.equal(s.endReason, "page-limit");
  assert.equal(s.moreAvailable, true);
  assert.equal(s.counters.saved, 4);
});

test("a job limit that cut results off is 'more available'; a source that ends exactly at the limit is not", async () => {
  const cut = makeEnv({ source: makeSource({ pages: [ids(1, 4), ids(5, 4)] }) });
  await run(cut, { limits: { maxJobs: 6 } });
  await cut.idle();
  const c = await cut.controller.getState();
  assert.deepEqual([c.endReason, c.moreAvailable], ["job-limit", true]);

  const exact = makeEnv({ source: makeSource({ pages: [ids(1, 4)] }) });
  await run(exact, { limits: { maxJobs: 4 } });
  await exact.idle();
  const e = await exact.controller.getState();
  assert.deepEqual([e.endReason, e.moreAvailable, e.counters.saved], ["no-more-results", false, 4]);

  const atCapWithNext = makeEnv({ source: makeSource({ pages: [ids(1, 4), ids(5, 4)] }) });
  await run(atCapWithNext, { limits: { maxJobs: 4 } });
  await atCapWithNext.idle();
  const n = await atCapWithNext.controller.getState();
  assert.deepEqual([n.endReason, n.moreAvailable], ["job-limit", true], "the cap was hit while a next page existed");

  const natural = makeEnv({ source: makeSource({ pages: [ids(1, 3), ids(4, 3)] }) });
  await run(natural);
  await natural.idle();
  const nat = await natural.controller.getState();
  assert.deepEqual([nat.endReason, nat.moreAvailable], ["no-more-results", false]);
});

test("an expired cursor restarts paging once from the first page; collected jobs are not saved twice", async () => {
  const source = makeSource({ pages: [ids(1, 3), ids(4, 3), ids(7, 3)], hooks: { search: ({ call }) => { if (call === 2) throw new SourceError("cursor-expired", "cursor expired"); } } });
  const env = makeEnv({ source });
  await run(env);
  await env.idle();
  const s = await env.controller.getState();
  assert.equal(s.status, "completed");
  assert.equal(env.saver.rows.size, 9);
  assert.equal(s.counters.saved, 9);
  assert.equal(s.counters.duplicates, 3, "the first page was seen again after the restart and skipped");
  assert.ok(s.warnings.some((w) => w.includes("cursor expired, so paging restarted")));
});

test("a second expired cursor fails the run instead of looping; earlier jobs stay saved", async () => {
  const source = makeSource({ pages: [ids(1, 2), ids(3, 2)], hooks: { search: ({ p }) => { if (p === 1) throw new SourceError("cursor-expired", "cursor expired"); } } });
  const env = makeEnv({ source });
  await run(env);
  await env.idle();
  const s = await env.controller.getState();
  assert.equal(s.status, "failed");
  assert.equal(env.saver.rows.size, 2);
  assert.ok(source.calls.search.length <= 4);
});

test("the summary shows a readable position for the next page, and 'end of results' at the end", async () => {
  const hold = gate();
  const source = makeSource({ pages: [ids(1, 2), ids(3, 2)], hooks: { search: async ({ p }) => { if (p === 1) await hold.promise; } } });
  source.describeCursor = (c) => `page ${c.p + 1}`;
  const env = makeEnv({ source });
  const s0 = await run(env);
  assert.equal(s0.position, "start");
  while (source.calls.search.length < 2) await tick(1);
  assert.equal((await env.controller.getState()).position, "page 2");
  hold.open();
  await env.idle();
  assert.equal((await env.controller.getState()).position, "end of results");
});

test("a source without describeCursor still gets a bounded position label; a throwing describer cannot break the run", async () => {
  const plain = makeEnv({ source: makeSource({ pages: [ids(1, 1), ids(2, 1)] }) });
  await run(plain);
  await plain.idle();
  assert.equal((await plain.controller.getState()).counters.saved, 2);
  const src = makeSource({ pages: [ids(1, 1), ids(2, 1)] });
  src.describeCursor = () => { throw new Error("bad describer"); };
  const env = makeEnv({ source: src });
  await run(env);
  await env.idle();
  const s = await env.controller.getState();
  assert.equal(s.status, "completed");
  assert.equal(s.counters.saved, 2);
});

test("import statistics passed with the run are exposed in the summary for display", async () => {
  const env = makeEnv({ source: makeSource({ pages: [ids(1, 2)] }) });
  await run(env, { params: { stats: { total: 5, valid: 2, invalid: 3, duplicatesInFile: 0, overLimit: 0 } } });
  await env.idle();
  assert.deepEqual((await env.controller.getState()).importStats, { total: 5, valid: 2, invalid: 3, duplicatesInFile: 0, overLimit: 0 });
});
